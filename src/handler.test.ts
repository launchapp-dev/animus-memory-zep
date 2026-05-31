import { describe, it, expect, beforeEach } from 'vitest';
import { CAPABILITIES, HandlerError, MemoryStoreHandler, scopeFromGraphId } from './handler.js';
import { error_codes } from './protocol.js';
import { graphIdForScope, listScopesPrefix } from './normalize.js';
import { StubZepClient, makeStatusError } from './_fixtures/stub_zep.js';

describe('CAPABILITIES', () => {
  it('declares Zep-accurate capability flags', () => {
    expect(CAPABILITIES.native_ttl).toBe(false);
    expect(CAPABILITIES.native_key_get).toBe(false);
    expect(CAPABILITIES.strong_consistency).toBe(false);
    expect(CAPABILITIES.max_query_top_k).toBe(50);
  });
});

describe('MemoryStoreHandler.put', () => {
  let stub: StubZepClient;
  let handler: MemoryStoreHandler;
  beforeEach(() => {
    stub = new StubZepClient();
    handler = new MemoryStoreHandler({ client: stub });
  });

  it('creates the graph and adds the episode with key in metadata', async () => {
    const res = await handler.put({
      scope: { project_id: 'proj' },
      key: 'last_seen',
      value: { url: 'https://example.com' },
    });
    expect(res.ack).toBe(true);
    // CRITICAL: indexed_immediately is on the wire and is always false for Zep.
    expect(res.indexed_immediately).toBe(false);
    expect(res.record_id).toBe('ep-1');

    expect(stub.createCalls).toHaveLength(1);
    expect(stub.createCalls[0]).toMatchObject({ graphId: 'proj_proj' });
    expect(stub.addCalls).toHaveLength(1);
    const add = stub.addCalls[0];
    expect(add.graphId).toBe('proj_proj');
    expect(add.type).toBe('text');
    // Data must be JSON-stringified {key, value}.
    const parsed = JSON.parse(add.data) as { key: string; value: unknown };
    expect(parsed.key).toBe('last_seen');
    expect(parsed.value).toEqual({ url: 'https://example.com' });
    expect(add.metadata).toMatchObject({
      key: 'last_seen',
      project_id_raw: 'proj',
    });
  });

  it('records ttl_secs in metadata when provided', async () => {
    await handler.put({
      scope: { project_id: 'proj' },
      key: 'k',
      value: 1,
      ttl_secs: 3600,
    });
    expect(stub.addCalls[0].metadata).toMatchObject({ ttl_s: 3600 });
  });

  it('records un-normalized scope segments in metadata for reverse lookup', async () => {
    await handler.put({
      scope: { project_id: 'Project With Spaces!', agent_id: 'Researcher-α', task_id: 'TASK-1' },
      key: 'k',
      value: 'v',
    });
    const md = stub.addCalls[0].metadata!;
    expect(md.project_id_raw).toBe('Project With Spaces!');
    expect(md.agent_id_raw).toBe('Researcher-α');
    expect(md.task_id_raw).toBe('TASK-1');
    // GraphId is normalized regardless. The Unicode 'α' in 'Researcher-α'
    // becomes '-' under normalize() and the trailing dash is trimmed, leaving
    // 'researcher'. The raw value is preserved in metadata above.
    expect(stub.addCalls[0].graphId).toBe(
      'proj_project-with-spaces__agent_researcher__task_task-1',
    );
  });

  it('treats Zep 409 on create as success (idempotent ensure-exists)', async () => {
    // Pre-create the graph so the stub returns 409 next time.
    await stub.create({ graphId: 'proj_proj' });
    const res = await handler.put({
      scope: { project_id: 'proj' },
      key: 'k',
      value: 'v',
    });
    expect(res.ack).toBe(true);
    expect(res.indexed_immediately).toBe(false);
  });

  it('maps Zep 429 to RATE_LIMITED', async () => {
    // Patch create to throw 429.
    stub.create = async () => {
      throw makeStatusError(429, 'rate limited');
    };
    await expect(
      handler.put({ scope: { project_id: 'p' }, key: 'k', value: 'v' }),
    ).rejects.toMatchObject({ code: error_codes.RATE_LIMITED });
  });

  it('maps Zep 5xx to BACKEND_UNAVAILABLE', async () => {
    stub.create = async () => {
      throw makeStatusError(503, 'service unavailable');
    };
    await expect(
      handler.put({ scope: { project_id: 'p' }, key: 'k', value: 'v' }),
    ).rejects.toMatchObject({ code: error_codes.BACKEND_UNAVAILABLE });
  });

  it('rejects empty key', async () => {
    await expect(
      handler.put({ scope: { project_id: 'p' }, key: '', value: 'v' }),
    ).rejects.toBeInstanceOf(HandlerError);
  });

  it('rejects empty project_id', async () => {
    await expect(
      handler.put({ scope: { project_id: '' }, key: 'k', value: 'v' }),
    ).rejects.toBeInstanceOf(HandlerError);
  });
});

describe('MemoryStoreHandler.get (search-based fallback)', () => {
  let stub: StubZepClient;
  let handler: MemoryStoreHandler;
  beforeEach(() => {
    stub = new StubZepClient();
    handler = new MemoryStoreHandler({ client: stub });
  });

  it('returns the stored value when an episode matches the metadata key exactly', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'k1', value: { x: 1 } });
    await handler.put({ scope: { project_id: 'p' }, key: 'k2', value: { x: 2 } });
    const out = await handler.get({ scope: { project_id: 'p' }, key: 'k1' });
    expect(out.found).toBe(true);
    expect(out.value).toEqual({ x: 1 });
    // Confirm we routed to scope=episodes per spec.
    expect(stub.searchCalls[0].scope).toBe('episodes');
  });

  it('returns found=false when no episode has matching key metadata', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'k1', value: 1 });
    const out = await handler.get({ scope: { project_id: 'p' }, key: 'nope' });
    expect(out.found).toBe(false);
  });

  it('returns found=false when graph does not exist', async () => {
    const out = await handler.get({ scope: { project_id: 'unknown' }, key: 'k' });
    expect(out.found).toBe(false);
  });
});

describe('MemoryStoreHandler.query', () => {
  let stub: StubZepClient;
  let handler: MemoryStoreHandler;
  beforeEach(() => {
    stub = new StubZepClient();
    handler = new MemoryStoreHandler({ client: stub });
  });

  it('translates edges to MemoryQueryResult and uses scope=edges, reranker=rrf', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'seed', value: 'v' });
    stub.preseededEdges = [
      { uuid: 'e1', name: 'k1', fact: 'The sky is blue', score: 0.9, attributes: { key: 'k1' } },
      { uuid: 'e2', name: 'k2', fact: 'Grass is green', score: 0.4 },
    ];
    const out = await handler.query({
      scope: { project_id: 'p' },
      query: 'sky color',
      top_k: 5,
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ key: 'k1', value: 'The sky is blue', score: 0.9 });
    expect(out.results[1]).toMatchObject({ key: 'k2', value: 'Grass is green', score: 0.4 });
    const call = stub.searchCalls.at(-1)!;
    expect(call.scope).toBe('edges');
    expect(call.reranker).toBe('rrf');
    expect(call.limit).toBe(5);
  });

  it('rejects top_k > 50 with QUERY_TOP_K_EXCEEDED', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'seed', value: 'v' });
    await expect(
      handler.query({ scope: { project_id: 'p' }, query: 'q', top_k: 51 }),
    ).rejects.toMatchObject({ code: error_codes.QUERY_TOP_K_EXCEEDED });
  });

  it('clamps top_k=50 (boundary) to the backend max', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'seed', value: 'v' });
    await handler.query({ scope: { project_id: 'p' }, query: 'q', top_k: 50 });
    expect(stub.searchCalls.at(-1)!.limit).toBe(50);
  });

  it('returns empty results when graph does not exist', async () => {
    const out = await handler.query({ scope: { project_id: 'missing' }, query: 'q', top_k: 5 });
    expect(out.results).toEqual([]);
  });
});

describe('MemoryStoreHandler.listScopes', () => {
  let stub: StubZepClient;
  let handler: MemoryStoreHandler;
  beforeEach(() => {
    stub = new StubZepClient();
    handler = new MemoryStoreHandler({ client: stub });
  });

  it('returns scopes under all project prefixes when no project_id is given', async () => {
    await handler.put({ scope: { project_id: 'A' }, key: 'k', value: 'v' });
    await handler.put({ scope: { project_id: 'B', agent_id: 'r' }, key: 'k', value: 'v' });
    const out = await handler.listScopes({});
    const ids = out.scopes.map((s) => graphIdForScope(s)).sort();
    expect(ids).toContain('proj_a');
    expect(ids).toContain('proj_b__agent_r');
  });

  it('filters by NORMALIZED project_id prefix (not raw)', async () => {
    // Insert scopes for two different projects.
    await handler.put({ scope: { project_id: 'Project Alpha!' }, key: 'k', value: 'v' });
    await handler.put({
      scope: { project_id: 'Project Alpha!', agent_id: 'researcher' },
      key: 'k',
      value: 'v',
    });
    await handler.put({ scope: { project_id: 'OtherProj' }, key: 'k', value: 'v' });

    // Filtering by the RAW project_id would never match `proj_project-alpha`.
    // The handler MUST normalize the filter prefix before comparing.
    const out = await handler.listScopes({ project_id: 'Project Alpha!' });
    const ids = out.scopes.map((s) => graphIdForScope(s));
    expect(ids).toEqual(expect.arrayContaining(['proj_project-alpha', 'proj_project-alpha__agent_researcher']));
    expect(ids).not.toContain('proj_otherproj');

    // Sanity check: the filter prefix is exactly `proj_${normalize('Project Alpha!')}`.
    expect(listScopesPrefix('Project Alpha!')).toBe('proj_project-alpha');
  });

  it('does not match prefix overruns (proj_alpha vs proj_alpha2)', async () => {
    await handler.put({ scope: { project_id: 'alpha' }, key: 'k', value: 'v' });
    await handler.put({ scope: { project_id: 'alpha2' }, key: 'k', value: 'v' });
    const out = await handler.listScopes({ project_id: 'alpha' });
    const ids = out.scopes.map((s) => graphIdForScope(s));
    expect(ids).toContain('proj_alpha');
    expect(ids).not.toContain('proj_alpha2');
  });

  it('paginates via cursor (Zep page-number) and emits next_cursor when more pages remain', async () => {
    // Insert 5 scopes; request page_size=2.
    for (let i = 0; i < 5; i++) {
      await handler.put({ scope: { project_id: `p${i}` }, key: 'k', value: 'v' });
    }
    const page1 = await handler.listScopes({ page_size: 2 });
    expect(page1.scopes).toHaveLength(2);
    expect(page1.next_cursor).toBe('2');

    const page2 = await handler.listScopes({ page_size: 2, cursor: page1.next_cursor });
    expect(page2.scopes).toHaveLength(2);
    expect(page2.next_cursor).toBe('3');

    const page3 = await handler.listScopes({ page_size: 2, cursor: page2.next_cursor });
    expect(page3.scopes).toHaveLength(1);
    // Final page returns no next_cursor.
    expect(page3.next_cursor).toBeUndefined();
  });

  it('clamps invalid page_size to default 100', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'k', value: 'v' });
    await handler.listScopes({ page_size: -3 });
    expect(stub.listAllCalls.at(-1)?.pageSize).toBe(100);
  });
});

describe('MemoryStoreHandler.deleteScope', () => {
  let stub: StubZepClient;
  let handler: MemoryStoreHandler;
  beforeEach(() => {
    stub = new StubZepClient();
    handler = new MemoryStoreHandler({ client: stub });
  });

  it('deletes the graph by normalized id', async () => {
    await handler.put({ scope: { project_id: 'p' }, key: 'k', value: 'v' });
    const out = await handler.deleteScope({ scope: { project_id: 'p' } });
    expect(out.ack).toBe(true);
    expect(stub.deleteCalls).toContain('proj_p');
    expect(stub.graphs.has('proj_p')).toBe(false);
  });

  it('is idempotent on missing graph (Zep 404 → ack=true)', async () => {
    const out = await handler.deleteScope({ scope: { project_id: 'nope' } });
    expect(out.ack).toBe(true);
  });
});

describe('scopeFromGraphId', () => {
  it('round-trips project-only graphId', () => {
    expect(scopeFromGraphId('proj_p')).toEqual({ project_id: 'p' });
  });
  it('round-trips agent-level graphId', () => {
    expect(scopeFromGraphId('proj_p__agent_a')).toEqual({ project_id: 'p', agent_id: 'a' });
  });
  it('round-trips task-level graphId', () => {
    expect(scopeFromGraphId('proj_p__agent_a__task_t')).toEqual({
      project_id: 'p',
      agent_id: 'a',
      task_id: 't',
    });
  });
  it('rejects non-proj-prefixed ids', () => {
    expect(scopeFromGraphId('other_p')).toBeNull();
  });
});
