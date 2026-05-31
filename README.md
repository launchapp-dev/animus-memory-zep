# animus-memory-zep

Persistent semantic memory for Animus v0.5 agents, backed by [Zep Cloud](https://www.getzep.com/).

This is the reference implementation of the `memory_store` plugin kind defined in
[animus-protocol v0.5.0](https://github.com/launchapp-dev/animus-protocol/releases/tag/v0.5.0)
(crate: `animus-memory-store-protocol`). It runs as a stdio JSON-RPC plugin under
the Animus daemon, exposing five RPCs:

| Method | Purpose |
|---|---|
| `memory/put` | Store a `(key, value)` under a scope. Idempotent ensure-exists on the underlying Zep graph. |
| `memory/get` | Search-based exact-key recall. **Not O(1)** — see capability flag below. |
| `memory/query` | Semantic search over edges. Uses RRF reranker, cap 50. |
| `memory/list_scopes` | Cursor-paginated scope enumeration, filtered by normalized project prefix. |
| `memory/delete_scope` | Idempotent delete by scope. |

## Quick start

```bash
npm install
npm run build
ZEP_API_KEY=your-key node dist/main.js --manifest    # prints the plugin manifest
ZEP_API_KEY=your-key node dist/main.js               # runs the JSON-RPC stdio loop
```

Animus daemon discovery typically goes through:

```bash
animus plugin install launchapp-dev/animus-memory-zep
ANIMUS_DAEMON_MEMORY_STORE_ENABLED=1 animus daemon start
```

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `ZEP_API_KEY` | yes | Zep Cloud API key. Read once at startup. |
| `ZEP_BASE_URL` | no | Override the Zep base URL (BYOC / self-hosted deployments). |
| `MEMORY_GET_MAX_SCAN` | no | Upper bound on episodes scanned by the `memory/get` exhaustive-fallback path. Default `500`. See [`memory/get` lookup strategy](#memoryget-lookup-strategy). |

## Scope → Zep graphId mapping

Memory scopes are derived from `(project_id, agent_id?, task_id?)` and normalized
into a flat `graphId` per `v0.5-protocol-specs.md` §4:

```
project-wide:  proj_${normalize(project_id)}
per-agent:     proj_${normalize(project_id)}__agent_${normalize(agent_id)}
per-task:      proj_${normalize(project_id)}__agent_${normalize(agent_id)}__task_${normalize(task_id)}
```

`normalize()` applies, in order: lowercase, replace any char not in `[a-z0-9_-]`
with `-`, collapse runs of `-`, trim leading/trailing `-`, truncate to 64 chars,
and fall back to `sha256(input)[0..16]` if the result is empty. The original
un-normalized segments are also recorded in Zep episode metadata so reverse
lookup is possible.

**Why this matters for `memory/list_scopes`:** the prefix filter uses the same
`normalize()` function on the caller's `project_id`. Filtering by a raw
`"Project Alpha!"` id would never match the stored `proj_project-alpha` graphId.
This is enforced by the unit tests.

## Capabilities (advertised on `initialize`)

```jsonc
{
  "memory_store": {
    "crate_version": "0.1.0",
    "extra": {
      "native_ttl":          false,   // Zep has no TTL primitive
      "native_key_get":      false,   // memory/get is search-based
      "strong_consistency":  false,   // Zep ingestion is async
      "max_query_top_k":     50       // Zep search hard cap
    }
  }
}
```

`PutMemoryResponse.indexed_immediately` is **always `false`** for this backend.
Callers needing read-after-write semantics MUST wait before issuing a follow-up
`memory/query`. The daemon surfaces this flag to LLM prompts so agents can
account for it.

## Async-consistency gotchas

Zep's ingestion is asynchronous. After a successful `memory/put`:

- `memory/query` may miss the new entry for a few seconds.
- `memory/get` (which is implemented as a `scope: 'episodes'` search with
  exact metadata-key post-filter, plus an exhaustive-scan fallback — see
  below) is also subject to ingestion latency.

`record_id` is the Zep episode UUID returned from `graph.add`. It is suitable
for audit logs but is not yet wired into a delete-by-id surface.

## `memory/get` lookup strategy

Zep is semantic-search-first; there is no native key-value `GET`. The plugin
recovers exact-key matches in two stages:

1. **Bounded semantic search.** `graph.search({ scope: "episodes", limit: 50 })`
   with the key as the query string. Exact metadata-key post-filter on the
   results. Fast path; covers small scopes and recently-written keys.
2. **Exhaustive most-recent-N scan.** If stage 1 misses (the matching episode
   is past the reranker's first 50, or the scope contains >50 episodes), the
   handler falls back to `graph.episode.getByGraphId({ lastn })` and scans the
   metadata for an exact `key` match. Bounded by the `MEMORY_GET_MAX_SCAN`
   env var (default **500**); episodes older than this are unreachable via
   `memory/get`.

`MEMORY_GET_MAX_SCAN` is the documented upper bound on `memory/get`
completeness for this backend. Callers can raise it at plugin-startup time
but should also note the per-call latency cost of the scan. The capability
flag `native_key_get: false` continues to advertise that this is not an
O(1) operation.

## `memory/list_scopes` scope reconstruction

To list scopes, the plugin walks `graph.listAll` and reconstructs the
un-normalized `(project_id, agent_id?, task_id?)` tuple for each graphId.
The graphId itself uses `__` as a structural delimiter
(`proj_<P>__agent_<A>__task_<T>`), which is ambiguous when a normalized
segment contains `__` (e.g. `agent_id = "a__b"`). To round-trip such ids
verbatim, the plugin reads one episode per graph and pulls the
un-normalized originals from `metadata.{project_id_raw, agent_id_raw,
task_id_raw}` (recorded on every `memory/put`). Falls back to the
structural `__` split when no metadata episode exists yet (e.g. a graph
freshly created by an older plugin version).

## TTL handling

`ttl_secs` is recorded on the episode's metadata as `ttl_s` but does NOT cause
Zep to evict. This is consistent with `native_ttl: false`. If the daemon needs
hard eviction, it must drive a sweeper externally (out of scope for v0.5).

## Error mapping

| Condition | Returned JSON-RPC error code |
|---|---|
| Plugin not initialized | `-32307` (`PROJECT_BINDING_MISMATCH`) |
| `top_k > 50` | `-32306` (`QUERY_TOP_K_EXCEEDED`) |
| Zep `429 Too Many Requests` | `-32305` (`RATE_LIMITED`) |
| Zep `5xx` | `-32304` (`BACKEND_UNAVAILABLE`) |
| Other Zep errors | `-32304` (`BACKEND_UNAVAILABLE`) |
| Invalid params | `-32602` (JSON-RPC standard) |

`memory/delete_scope` treats Zep `404` as success (idempotent).

## Tests

```bash
npm test           # unit tests + a skipped live-Zep round trip
npm run typecheck  # strict TS check
```

The live integration test in `src/integration.test.ts` is `describe.skipIf(!LIVE)`
and only runs when both `RUN_LIVE_ZEP=1` and `ZEP_API_KEY=<key>` are set. As of
v0.1.0, that key is not yet provisioned in CI — see the in-file TODO.

## Known limits and v0.6 design choices

The v0.1.0 release closes the two codex P2 findings from v0.5 review
(`memory/get` exhaustiveness; `list_scopes` `__`-delimiter ambiguity) but
keeps the underlying Zep-imposed constraints:

- **`memory/get` upper bound: `MEMORY_GET_MAX_SCAN` episodes** (default 500).
  A v0.6 design candidate is the **Zep v4 metadata-filter API**, which would
  let us replace the post-filter scan with a server-side
  `metadata.key == <key>` query and remove the bound entirely. Tracked
  pending v4 SDK availability.
- **`memory/list_scopes` issues one extra `getEpisodes(lastn: 1)` call per
  graph** to recover un-normalized scope segments. A v0.6 design candidate
  is a **sidecar sqlite key → episode_uuid index** maintained by the plugin
  process; that would also let `memory/get` go O(1) without the Zep v4
  dependency. Tracked.

Both are deferred — v0.1.0 ships the bounded-but-correct fixes.

## License

Elastic-2.0. See LICENSE.
