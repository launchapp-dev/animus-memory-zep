// Memory_store protocol handler. Translates the v0.5 JSON-RPC surface
// (memory/put, memory/get, memory/query, memory/list_scopes,
// memory/delete_scope) onto the Zep Cloud graph API.

import {
  error_codes,
  type DeleteScopeRequest,
  type DeleteScopeResponse,
  type GetMemoryRequest,
  type GetMemoryResponse,
  type ListScopesRequest,
  type ListScopesResponse,
  type MemoryQueryResult,
  type MemoryScope,
  type MemoryStoreCapabilities,
  type PutMemoryRequest,
  type PutMemoryResponse,
  type QueryMemoryRequest,
  type QueryMemoryResponse,
} from './protocol.js';
import {
  graphIdForScope,
  listScopesPrefix,
  normalize,
} from './normalize.js';
import {
  zepErrorStatusCode,
  type ZepGraphClient,
  type ZepEntityEdge,
  type ZepEpisode,
} from './zep_backend.js';

export const CAPABILITIES: MemoryStoreCapabilities = {
  // Zep has no TTL primitive — `ttl_secs` is recorded in metadata only.
  native_ttl: false,
  // Zep is a semantic-search backend. `memory/get` falls back to a search.
  native_key_get: false,
  // Zep ingestion is asynchronous; put → query may miss for a window.
  strong_consistency: false,
  // Zep's per-call search cap.
  max_query_top_k: 50,
};

// Hard backend cap; the protocol-level capability above advertises this so
// the daemon can clamp before we have to error.
const ZEP_SEARCH_HARD_CAP = 50;

// Maximum number of episodes scanned by `memory/get` exhaustive-fallback. The
// initial semantic search is bounded by `ZEP_SEARCH_HARD_CAP`; if the key is
// not found in that page (e.g. the matching episode is buried past the search
// reranker's first 50), the handler falls back to a most-recent-N episodes
// scan capped at this value. Configurable via `MEMORY_GET_MAX_SCAN`.
const MEMORY_GET_MAX_SCAN_DEFAULT = 500;
export const MEMORY_GET_MAX_SCAN = (() => {
  const raw = process.env.MEMORY_GET_MAX_SCAN;
  if (typeof raw !== 'string' || raw.length === 0) return MEMORY_GET_MAX_SCAN_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return MEMORY_GET_MAX_SCAN_DEFAULT;
  return n;
})();

// Stable error envelope returned by the handler. The server translates these
// into JSON-RPC error responses.
export class HandlerError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

// Re-export capabilities-shaped error code helpers for clarity at call sites.
function mapZepError(err: unknown, fallbackMessage: string): HandlerError {
  const status = zepErrorStatusCode(err);
  if (status === 429) {
    return new HandlerError(error_codes.RATE_LIMITED, `zep rate-limited: ${describe(err)}`);
  }
  if (status !== undefined && status >= 500) {
    return new HandlerError(
      error_codes.BACKEND_UNAVAILABLE,
      `zep ${status}: ${describe(err)}`,
    );
  }
  return new HandlerError(error_codes.BACKEND_UNAVAILABLE, `${fallbackMessage}: ${describe(err)}`);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function validateScope(scope: unknown): asserts scope is MemoryScope {
  if (typeof scope !== 'object' || scope === null) {
    throw new HandlerError(-32602, 'scope must be an object');
  }
  const s = scope as MemoryScope;
  if (typeof s.project_id !== 'string' || s.project_id.length === 0) {
    throw new HandlerError(-32602, 'scope.project_id must be a non-empty string');
  }
  if (s.agent_id !== undefined && s.agent_id !== null && typeof s.agent_id !== 'string') {
    throw new HandlerError(-32602, 'scope.agent_id must be a string or null');
  }
  if (s.task_id !== undefined && s.task_id !== null && typeof s.task_id !== 'string') {
    throw new HandlerError(-32602, 'scope.task_id must be a string or null');
  }
  if (s.task_id && !s.agent_id) {
    throw new HandlerError(-32602, 'scope.task_id requires scope.agent_id');
  }
}

/**
 * Bundle of Zep-side state per RPC. `boundProjectRoot` is not used inside the
 * handler today (project_id is supplied by the caller in the scope), but is
 * preserved so callers needing finer enforcement can add it without a
 * signature change.
 */
export interface HandlerDeps {
  client: ZepGraphClient;
  /** Logger for non-fatal warnings (e.g. metadata cap clamp). */
  log?: (msg: string) => void;
}

export class MemoryStoreHandler {
  constructor(private readonly deps: HandlerDeps) {}

  // ---------- memory/put ----------
  async put(req: PutMemoryRequest): Promise<PutMemoryResponse> {
    if (typeof req.key !== 'string' || req.key.length === 0) {
      throw new HandlerError(-32602, 'put.key must be a non-empty string');
    }
    validateScope(req.scope);
    const graphId = graphIdForScope(req.scope);

    // Ensure the graph exists. Zep returns 409 on duplicate create — treat
    // that as success (idempotent ensure-exists).
    await this.ensureGraph(graphId, req.scope);

    // Build metadata. Zep caps metadata at 10 scalar keys; we use a fixed set
    // well under that. The un-normalized scope is also recorded so a reverse
    // lookup from graphId → original scope is possible.
    const metadata: Record<string, unknown> = {
      key: req.key,
      project_id_raw: req.scope.project_id,
    };
    if (req.scope.agent_id) metadata.agent_id_raw = req.scope.agent_id;
    if (req.scope.task_id) metadata.task_id_raw = req.scope.task_id;
    if (typeof req.ttl_secs === 'number' && Number.isFinite(req.ttl_secs)) {
      metadata.ttl_s = req.ttl_secs;
    }

    const payload = JSON.stringify({ key: req.key, value: req.value });

    let episode: ZepEpisode;
    try {
      episode = await this.deps.client.add({
        graphId,
        type: 'text',
        data: payload,
        metadata,
        sourceDescription: 'animus-memory-zep',
      });
    } catch (err) {
      throw mapZepError(err, 'memory/put: graph.add failed');
    }

    return {
      ack: true,
      // Zep ingestion is asynchronous — search will catch up eventually.
      indexed_immediately: false,
      record_id: typeof episode?.uuid === 'string' ? episode.uuid : '',
    };
  }

  // ---------- memory/get ----------
  async get(req: GetMemoryRequest): Promise<GetMemoryResponse> {
    if (typeof req.key !== 'string' || req.key.length === 0) {
      throw new HandlerError(-32602, 'get.key must be a non-empty string');
    }
    validateScope(req.scope);
    const graphId = graphIdForScope(req.scope);

    // Search-based fallback — Zep has no native key-value get. Two-stage:
    //   1. Bounded semantic search (`scope: 'episodes'`, limit = Zep hard cap)
    //      with exact post-filter on `metadata.key`. Fast path for small
    //      scopes and recently-written keys.
    //   2. If not found, walk `graph.episode.getByGraphId({ lastn })` for an
    //      exhaustive scan capped at `MEMORY_GET_MAX_SCAN` (default 500) so
    //      exact-key recall does not silently fail for scopes larger than the
    //      Zep search cap or when the reranker buries the match past page 1.
    //
    // Documented limit: scopes whose key resides past episode
    // `MEMORY_GET_MAX_SCAN` (most-recent-N ordering) will still report
    // `found: false`. The capability flag `native_key_get: false` tells the
    // daemon not to rely on `get` for completeness.
    let results;
    try {
      results = await this.deps.client.search({
        graphId,
        query: req.key,
        scope: 'episodes',
        limit: ZEP_SEARCH_HARD_CAP,
      });
    } catch (err) {
      const status = zepErrorStatusCode(err);
      if (status === 404) {
        return { found: false };
      }
      throw mapZepError(err, 'memory/get: graph.search failed');
    }

    const searched = results.episodes ?? [];
    for (const ep of searched) {
      const meta = ep.metadata ?? {};
      if (typeof meta.key === 'string' && meta.key === req.key) {
        return { found: true, value: extractValueFromEpisode(ep) };
      }
    }

    // Fallback: exhaustive most-recent-N episode scan, bounded by
    // MEMORY_GET_MAX_SCAN. Catches exact-key matches that fell outside the
    // semantic search's reranked first 50.
    let fallback;
    try {
      fallback = await this.deps.client.getEpisodes(graphId, {
        lastn: MEMORY_GET_MAX_SCAN,
      });
    } catch (err) {
      const status = zepErrorStatusCode(err);
      if (status === 404) {
        return { found: false };
      }
      throw mapZepError(err, 'memory/get: graph.episode.getByGraphId failed');
    }

    const scanned = fallback.episodes ?? [];
    for (const ep of scanned) {
      const meta = ep.metadata ?? {};
      if (typeof meta.key === 'string' && meta.key === req.key) {
        return { found: true, value: extractValueFromEpisode(ep) };
      }
    }
    return { found: false };
  }

  // ---------- memory/query ----------
  async query(req: QueryMemoryRequest): Promise<QueryMemoryResponse> {
    if (typeof req.query !== 'string' || req.query.length === 0) {
      throw new HandlerError(-32602, 'query.query must be a non-empty string');
    }
    if (typeof req.top_k !== 'number' || !Number.isInteger(req.top_k) || req.top_k <= 0) {
      throw new HandlerError(-32602, 'query.top_k must be a positive integer');
    }
    validateScope(req.scope);

    if (req.top_k > ZEP_SEARCH_HARD_CAP) {
      throw new HandlerError(
        error_codes.QUERY_TOP_K_EXCEEDED,
        `query.top_k=${req.top_k} exceeds backend max ${ZEP_SEARCH_HARD_CAP}`,
        { max_query_top_k: ZEP_SEARCH_HARD_CAP },
      );
    }

    const graphId = graphIdForScope(req.scope);

    let results;
    try {
      results = await this.deps.client.search({
        graphId,
        query: req.query,
        scope: 'edges',
        limit: Math.min(req.top_k, ZEP_SEARCH_HARD_CAP),
        reranker: 'rrf',
      });
    } catch (err) {
      const status = zepErrorStatusCode(err);
      if (status === 404) {
        // Graph doesn't exist yet — semantically "no results".
        return { results: [] };
      }
      throw mapZepError(err, 'memory/query: graph.search failed');
    }

    const out: MemoryQueryResult[] = [];
    for (const edge of results.edges ?? []) {
      out.push(edgeToMemoryResult(edge));
    }
    return { results: out };
  }

  // ---------- memory/list_scopes ----------
  async listScopes(req: ListScopesRequest): Promise<ListScopesResponse> {
    const pageSize = clampPageSize(req.page_size);
    const pageNumber = parseCursor(req.cursor);

    let raw;
    try {
      raw = await this.deps.client.listAll({
        pageNumber,
        pageSize,
      });
    } catch (err) {
      throw mapZepError(err, 'memory/list_scopes: graph.listAll failed');
    }

    const graphs = raw.graphs ?? [];

    // CRITICAL: filter by the NORMALIZED prefix (`proj_${normalize(project_id)}`)
    // not the raw project_id. A "Project Alpha!" id would never match against
    // the stored `proj_project-alpha` graphId without normalization.
    const prefix =
      typeof req.project_id === 'string' && req.project_id.length > 0
        ? listScopesPrefix(req.project_id)
        : null;
    // Expected normalized project segment for post-metadata verification (see
    // below). Equal to `normalize(req.project_id)` without the `proj_` prefix.
    const expectedProjectSegment =
      prefix !== null ? prefix.slice('proj_'.length) : null;

    const scopes: MemoryScope[] = [];
    for (const g of graphs) {
      const gid = typeof g.graphId === 'string' ? g.graphId : '';
      if (gid === '' || !gid.startsWith('proj_')) continue;
      if (prefix !== null && !graphIdMatchesProjectPrefix(gid, prefix)) continue;

      // Prefer the un-normalized scope metadata stored on episode `*_raw`
      // fields. This round-trips ids whose segments contain the `__`
      // delimiter (e.g. `agent_id = "a__b"`) verbatim instead of mis-splitting
      // the graphId. Falls back to the structural `__` split for graphs that
      // pre-date this fix (no metadata episode yet).
      const fromMeta = await this.fetchScopeMetadata(gid);
      if (fromMeta !== null) {
        // Guard: the graphId-prefix check above is performed on the
        // normalized graphId, but the metadata round-trips the
        // UN-normalized project_id. If the caller filtered by a raw
        // project_id whose normalized form happens to collide with a
        // delimiter-bearing segment of another scope's graphId (e.g.
        // `listScopes({ project_id: 'p__agent_a' })` would prefix-match
        // `proj_p__agent_a__b` whose real scope is project=`p`,
        // agent=`a__b`), re-verify that the recovered raw project_id
        // still normalizes back to the requested project segment.
        // Without this check we'd leak the un-related scope.
        if (
          expectedProjectSegment !== null &&
          normalize(fromMeta.project_id) !== expectedProjectSegment
        ) {
          continue;
        }
        scopes.push(fromMeta);
        continue;
      }
      const scope = scopeFromGraphId(gid);
      if (scope !== null) {
        scopes.push(scope);
      }
    }

    // Pagination: if Zep returned a full page, hand the caller the next page
    // number as the cursor. Otherwise we're exhausted.
    let next_cursor: string | null | undefined;
    if (graphs.length >= pageSize) {
      next_cursor = String(pageNumber + 1);
    } else {
      next_cursor = undefined;
    }
    return { scopes, ...(next_cursor !== undefined ? { next_cursor } : {}) };
  }

  // ---------- memory/delete_scope ----------
  async deleteScope(req: DeleteScopeRequest): Promise<DeleteScopeResponse> {
    validateScope(req.scope);
    const graphId = graphIdForScope(req.scope);
    try {
      await this.deps.client.delete(graphId);
    } catch (err) {
      const status = zepErrorStatusCode(err);
      // Idempotent: 404 is not an error.
      if (status === 404) return { ack: true };
      throw mapZepError(err, 'memory/delete_scope: graph.delete failed');
    }
    return { ack: true };
  }

  /**
   * Read one episode from `graphId` and return the un-normalized scope tuple
   * recorded in metadata (`project_id_raw`, `agent_id_raw?`, `task_id_raw?`).
   * Returns `null` if the graph has no episodes yet, the metadata is missing,
   * or the backend errors (caller will fall back to structural parsing).
   */
  private async fetchScopeMetadata(graphId: string): Promise<MemoryScope | null> {
    let res;
    try {
      res = await this.deps.client.getEpisodes(graphId, { lastn: 1 });
    } catch (err) {
      // Don't propagate — list_scopes should degrade gracefully.
      this.deps.log?.(
        `list_scopes: fetchScopeMetadata(${graphId}) failed: ${describe(err)}`,
      );
      return null;
    }
    const ep = (res.episodes ?? [])[0];
    if (!ep) return null;
    const meta = ep.metadata ?? {};
    const projectRaw = meta.project_id_raw;
    if (typeof projectRaw !== 'string' || projectRaw.length === 0) return null;
    const scope: MemoryScope = { project_id: projectRaw };
    if (typeof meta.agent_id_raw === 'string' && meta.agent_id_raw.length > 0) {
      scope.agent_id = meta.agent_id_raw;
    }
    if (typeof meta.task_id_raw === 'string' && meta.task_id_raw.length > 0) {
      // `task_id` without `agent_id` violates the scope schema; refuse rather
      // than emit a malformed scope.
      if (!scope.agent_id) return null;
      scope.task_id = meta.task_id_raw;
    }
    return scope;
  }

  // ---------- helpers ----------
  private async ensureGraph(graphId: string, scope: MemoryScope): Promise<void> {
    try {
      await this.deps.client.create({
        graphId,
        name: graphId,
        description: scopeDescription(scope),
      });
    } catch (err) {
      const status = zepErrorStatusCode(err);
      // 409 = already exists, treat as success (idempotent).
      if (status === 409) return;
      throw mapZepError(err, 'memory/put: graph.create failed');
    }
  }
}

function scopeDescription(scope: MemoryScope): string {
  const parts: string[] = [`project=${scope.project_id}`];
  if (scope.agent_id) parts.push(`agent=${scope.agent_id}`);
  if (scope.task_id) parts.push(`task=${scope.task_id}`);
  return parts.join(' | ');
}

function clampPageSize(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 100;
  return Math.min(Math.floor(raw), 500);
}

function parseCursor(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

/**
 * Match a stored graphId against a project-level prefix. Either an exact
 * `proj_<normproj>` match (project-wide scope) OR a `proj_<normproj>__agent_`
 * or `proj_<normproj>__task_` continuation. Guards against `proj_alpha`
 * accidentally matching `proj_alpha2`.
 */
function graphIdMatchesProjectPrefix(graphId: string, prefix: string): boolean {
  if (graphId === prefix) return true;
  return graphId.startsWith(`${prefix}__`);
}

/**
 * Recover the scope tuple (project_id, agent_id, task_id) from a graphId.
 * Returns the NORMALIZED form (since we don't have the un-normalized original
 * unless we fetched the metadata). Callers that need the raw original should
 * use `MemoryStoreHandler.fetchScopeMetadata` first; this function is the
 * structural fallback for graphs with no episodes yet.
 *
 * Known structural limit: a normalized segment containing the `__` delimiter
 * (e.g. an agent_id of `a__b` which is already lowercase + `[a-z0-9_-]`)
 * produces a graphId this parser mis-splits. The handler routes around this
 * by reading un-normalized `*_raw` values from episode metadata; this
 * function returns `null` in the ambiguous case rather than emitting a
 * mis-parsed scope.
 */
export function scopeFromGraphId(graphId: string): MemoryScope | null {
  if (!graphId.startsWith('proj_')) return null;
  const rest = graphId.slice('proj_'.length);
  // Patterns:
  //   <proj>
  //   <proj>__agent_<agent>
  //   <proj>__agent_<agent>__task_<task>
  const parts = rest.split('__');
  if (parts.length === 1) {
    return { project_id: parts[0] };
  }
  if (parts.length === 2 && parts[1].startsWith('agent_')) {
    return { project_id: parts[0], agent_id: parts[1].slice('agent_'.length) };
  }
  if (parts.length === 3 && parts[1].startsWith('agent_') && parts[2].startsWith('task_')) {
    return {
      project_id: parts[0],
      agent_id: parts[1].slice('agent_'.length),
      task_id: parts[2].slice('task_'.length),
    };
  }
  // Unrecognized shape — skip silently rather than poisoning the list.
  return null;
}

function extractValueFromEpisode(ep: ZepEpisode): unknown {
  // Content is JSON-stringified `{ key, value }` per `memory/put`. Parse and
  // return the value. Fall back to the raw content if parsing fails so
  // callers always get something.
  const content = typeof ep.content === 'string' ? ep.content : '';
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && 'value' in parsed) {
      return (parsed as { value: unknown }).value;
    }
  } catch {
    // fall through
  }
  return content;
}

function edgeToMemoryResult(edge: ZepEntityEdge): MemoryQueryResult {
  const attrs = edge.attributes ?? {};
  // Edges are derived from episodes; the `fact` field is the human-readable
  // summary. We surface the edge name (key) when possible, else the uuid.
  let key = '';
  if (typeof attrs.key === 'string') key = attrs.key;
  else if (typeof edge.name === 'string') key = edge.name;
  else if (typeof edge.uuid === 'string') key = edge.uuid;

  const value: unknown = typeof edge.fact === 'string' ? edge.fact : edge;
  const score = typeof edge.score === 'number' ? edge.score : 0;
  return { key, value, score };
}

export { normalize };
