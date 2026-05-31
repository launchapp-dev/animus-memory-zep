import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, buildManifest } from './server.js';
import { error_codes, PROTOCOL_VERSION } from './protocol.js';
import { StubZepClient } from './_fixtures/stub_zep.js';
import type { RpcRequest, RpcResponse, RpcSuccess, RpcErrorEnvelope } from './wire.js';

function isError(r: RpcResponse): r is RpcErrorEnvelope {
  return 'error' in r;
}

function isOk(r: RpcResponse): r is RpcSuccess {
  return 'result' in r;
}

describe('buildManifest', () => {
  it('declares plugin_kind=memory_store and required env', () => {
    const m = buildManifest('@launchapp-dev/animus-memory-zep', '0.1.0-dev');
    expect(m.plugin_kind).toBe('memory_store');
    const env = m.env_required as Array<{ name: string; required?: boolean }>;
    const apiKey = env.find((e) => e.name === 'ZEP_API_KEY');
    expect(apiKey?.required).toBe(true);
    const baseUrl = env.find((e) => e.name === 'ZEP_BASE_URL');
    expect(baseUrl?.required).toBe(false);
  });
});

describe('server.initialize', () => {
  let stub: StubZepClient;
  beforeEach(() => {
    stub = new StubZepClient();
  });

  const buildFrame = (method: string, params?: unknown, id: number | string = 1): RpcRequest => ({
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });

  it('returns the typed v1.1.0 InitializeResult with memory_store capabilities', async () => {
    const server = createServer({
      name: 'animus-memory-zep',
      version: '0.1.0-dev',
      handlerDeps: { client: stub },
    });
    const r = await server.dispatch(
      buildFrame('initialize', {
        protocol_version: PROTOCOL_VERSION,
        init_extensions: { project_binding: { project_root: '/abs/path/to/project' } },
      }),
    );
    expect(r).toBeDefined();
    expect(isOk(r!)).toBe(true);
    const result = (r as RpcSuccess).result as Record<string, unknown>;
    expect(result.protocol_version).toBe(PROTOCOL_VERSION);
    expect((result.kinds as string[])).toEqual(['memory_store']);
    const caps = result.capabilities as Record<string, { crate_version: string; extra: unknown }>;
    expect(caps.memory_store.crate_version).toBe('0.1.0');
    expect(caps.memory_store.extra).toMatchObject({
      native_ttl: false,
      native_key_get: false,
      strong_consistency: false,
      max_query_top_k: 50,
    });
  });

  it('rejects initialize without project_binding', async () => {
    const server = createServer({
      name: 'animus-memory-zep',
      version: '0.1.0-dev',
      handlerDeps: { client: stub },
    });
    const r = await server.dispatch(
      buildFrame('initialize', { protocol_version: PROTOCOL_VERSION, init_extensions: {} }),
    );
    expect(r).toBeDefined();
    expect(isError(r!)).toBe(true);
    expect((r as RpcErrorEnvelope).error.message).toMatch(/project_binding/);
  });

  it('returns PROJECT_BINDING_MISMATCH if a second initialize uses a different root', async () => {
    const server = createServer({
      name: 'animus-memory-zep',
      version: '0.1.0-dev',
      handlerDeps: { client: stub },
    });
    await server.dispatch(
      buildFrame('initialize', {
        protocol_version: PROTOCOL_VERSION,
        init_extensions: { project_binding: { project_root: '/root/A' } },
      }),
    );
    const second = await server.dispatch(
      buildFrame(
        'initialize',
        {
          protocol_version: PROTOCOL_VERSION,
          init_extensions: { project_binding: { project_root: '/root/B' } },
        },
        2,
      ),
    );
    expect(isError(second!)).toBe(true);
    expect((second as RpcErrorEnvelope).error.code).toBe(error_codes.PROJECT_BINDING_MISMATCH);
  });

  it('refuses memory/* calls before initialize', async () => {
    const server = createServer({
      name: 'animus-memory-zep',
      version: '0.1.0-dev',
      handlerDeps: { client: stub },
    });
    const r = await server.dispatch(
      buildFrame('memory/put', { scope: { project_id: 'p' }, key: 'k', value: 'v' }),
    );
    expect(isError(r!)).toBe(true);
    expect((r as RpcErrorEnvelope).error.code).toBe(error_codes.PROJECT_BINDING_MISMATCH);
  });
});

describe('server.memory dispatch (post-initialize)', () => {
  let stub: StubZepClient;
  let server: ReturnType<typeof createServer>;
  beforeEach(() => {
    stub = new StubZepClient();
    server = createServer({
      name: 'animus-memory-zep',
      version: '0.1.0-dev',
      handlerDeps: { client: stub },
      initialProjectRoot: '/abs/proj',
    });
  });

  it('round-trips put then get through the dispatch layer', async () => {
    const putRes = await server.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'memory/put',
      params: { scope: { project_id: 'p' }, key: 'k', value: { v: 42 } },
    });
    expect(isOk(putRes!)).toBe(true);
    expect((putRes as RpcSuccess).result).toMatchObject({
      ack: true,
      indexed_immediately: false,
    });

    const getRes = await server.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'memory/get',
      params: { scope: { project_id: 'p' }, key: 'k' },
    });
    expect(isOk(getRes!)).toBe(true);
    expect((getRes as RpcSuccess).result).toMatchObject({
      found: true,
      value: { v: 42 },
    });
  });

  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const r = await server.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'memory/explode',
      params: {},
    });
    expect(isError(r!)).toBe(true);
    expect((r as RpcErrorEnvelope).error.code).toBe(-32601);
  });

  it('replies to $/ping', async () => {
    const r = await server.dispatch({ jsonrpc: '2.0', id: 1, method: '$/ping' });
    expect(isOk(r!)).toBe(true);
  });

  it('replies to health/check', async () => {
    const r = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'health/check' });
    expect(isOk(r!)).toBe(true);
    expect((r as RpcSuccess).result).toMatchObject({ status: 'healthy' });
  });
});
