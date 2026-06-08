// Plugin server: wires the JSON-RPC stdio loop to the memory_store handler.
//
// Implements the v0.5 plugin handshake:
//   - `initialize` — validates `init_extensions.project_binding.project_root`
//     and pins the plugin to that root.
//   - `health/check` — returns a static healthy report (Zep liveness is checked
//     lazily on each RPC; surfacing it on every health probe would burn quota).
//   - `shutdown` / `exit` — graceful shutdown.
//   - `memory/*` — dispatched to `MemoryStoreHandler`.

import {
  CAPABILITIES,
  HandlerError,
  MemoryStoreHandler,
  type HandlerDeps,
} from './handler.js';
import {
  error_codes,
  JsonRpcError,
  METHOD_MEMORY_DELETE_SCOPE,
  METHOD_MEMORY_GET,
  METHOD_MEMORY_LIST_SCOPES,
  METHOD_MEMORY_PUT,
  METHOD_MEMORY_QUERY,
  PROTOCOL_VERSION,
  type InitializeParams,
  type ProjectBinding,
} from './protocol.js';
import {
  createWire,
  errorResponse,
  okResponse,
  type FrameHandler,
  type RpcRequest,
  type RpcResponse,
  type Wire,
  type WireOptions,
} from './wire.js';

export interface ServerConfig {
  handlerDeps: HandlerDeps;
  name: string;
  version: string;
  wire?: WireOptions;
  /**
   * Optional pre-bound project root. When provided, `initialize` is treated
   * as already complete (useful in tests). Production code receives the
   * binding via `initialize`.
   */
  initialProjectRoot?: string;
}

interface ServerState {
  initialized: boolean;
  projectRoot: string | null;
  handler: MemoryStoreHandler;
}

export function buildManifest(name: string, version: string): Record<string, unknown> {
  // Mirrors the `PluginManifest` wire shape from `animus-plugin-protocol`.
  // `capabilities` is a flat list of RPC method names (PluginManifest
  // .capabilities: Vec<String>), NOT a nested object. Streaming /
  // progress / cancellation flags belong on the `initialize` response's
  // `capabilities.<kind>` object, not on the static manifest.
  return {
    name,
    version,
    plugin_kind: 'memory_store',
    description: 'Animus v0.5 memory_store plugin backed by Zep Cloud.',
    protocol_version: PROTOCOL_VERSION,
    capabilities: [
      'initialize',
      '$/ping',
      'health/check',
      'shutdown',
      'exit',
      METHOD_MEMORY_PUT,
      METHOD_MEMORY_GET,
      METHOD_MEMORY_QUERY,
      METHOD_MEMORY_LIST_SCOPES,
      METHOD_MEMORY_DELETE_SCOPE,
    ],
    env_required: [
      {
        name: 'ZEP_API_KEY',
        description: 'API key for Zep Cloud. Required at runtime.',
        required: true,
        sensitive: true,
      },
      {
        name: 'ZEP_BASE_URL',
        description: 'Override the Zep Cloud base URL (BYOC). Optional.',
        required: false,
        sensitive: false,
      },
      {
        name: 'MEMORY_GET_MAX_SCAN',
        description:
          'Upper bound on episodes scanned by the memory/get exhaustive-fallback path. Default 500.',
        required: false,
        sensitive: false,
      },
    ],
  };
}

function buildInitializeResult(name: string, version: string): Record<string, unknown> {
  return {
    protocol_version: PROTOCOL_VERSION,
    kinds: ['memory_store'],
    capabilities: {
      memory_store: {
        crate_version: '0.1.0',
        extra: CAPABILITIES,
      },
    },
    server_info: { name, version },
  };
}

export function createServer(config: ServerConfig): {
  manifest: () => Record<string, unknown>;
  dispatch: FrameHandler;
  run: () => Promise<void>;
} {
  const state: ServerState = {
    initialized: config.initialProjectRoot !== undefined,
    projectRoot: config.initialProjectRoot ?? null,
    handler: new MemoryStoreHandler(config.handlerDeps),
  };

  const dispatch: FrameHandler = async (frame: RpcRequest): Promise<RpcResponse | undefined> => {
    const id = frame.id;

    if (id === undefined) {
      if (frame.method === 'exit') {
        setImmediate(() => process.exit(0));
        return undefined;
      }
      if (frame.method === 'initialized' || frame.method.startsWith('$/')) {
        return undefined;
      }
      return undefined;
    }

    switch (frame.method) {
      case 'initialize':
        return handleInitialize(id, frame.params, state, config);
      case '$/ping':
        return okResponse(id, {});
      case 'health/check':
        return okResponse(id, {
          status: 'healthy',
          uptime_ms: null,
          memory_usage_bytes: null,
          last_error: null,
        });
      case 'shutdown':
        return okResponse(id, {});
      case 'exit':
        setImmediate(() => process.exit(0));
        return okResponse(id, {});
      case METHOD_MEMORY_PUT:
      case METHOD_MEMORY_GET:
      case METHOD_MEMORY_QUERY:
      case METHOD_MEMORY_LIST_SCOPES:
      case METHOD_MEMORY_DELETE_SCOPE:
        return dispatchMemory(id, frame, state);
      default:
        return errorResponse(
          id,
          JsonRpcError.METHOD_NOT_FOUND,
          `method '${frame.method}' not supported`,
        );
    }
  };

  return {
    manifest: () => buildManifest(config.name, config.version),
    dispatch,
    run: async () => {
      const wire: Wire = createWire(config.wire);
      await wire.run(dispatch);
    },
  };
}

function handleInitialize(
  id: RpcRequest['id'],
  params: unknown,
  state: ServerState,
  config: ServerConfig,
): RpcResponse {
  const p = (params ?? {}) as InitializeParams;
  // The host must include project_binding under init_extensions. Refuse if
  // missing — the spec mandates project-scope binding for every v0.5 plugin
  // process.
  const ext = (p.init_extensions ?? {}) as Record<string, unknown>;
  const binding = ext.project_binding as ProjectBinding | undefined;
  if (!binding || typeof binding.project_root !== 'string' || binding.project_root.length === 0) {
    return errorResponse(
      id,
      JsonRpcError.INVALID_PARAMS,
      'initialize requires init_extensions.project_binding.project_root',
    );
  }

  // If the plugin has already been bound (re-init attempt or test fixture
  // pre-binding) and the host now passes a different root, refuse per spec
  // — one plugin process serves exactly one project root.
  if (state.projectRoot !== null && state.projectRoot !== binding.project_root) {
    return errorResponse(
      id,
      error_codes.PROJECT_BINDING_MISMATCH,
      `plugin already bound to project_root='${state.projectRoot}', cannot rebind to '${binding.project_root}'`,
    );
  }
  state.projectRoot = binding.project_root;
  state.initialized = true;
  return okResponse(id, buildInitializeResult(config.name, config.version));
}

async function dispatchMemory(
  id: RpcRequest['id'],
  frame: RpcRequest,
  state: ServerState,
): Promise<RpcResponse> {
  if (!state.initialized || state.projectRoot === null) {
    return errorResponse(
      id,
      error_codes.PROJECT_BINDING_MISMATCH,
      'plugin not initialized; call `initialize` first',
    );
  }
  const params = (frame.params ?? {}) as Record<string, unknown>;
  try {
    switch (frame.method) {
      case METHOD_MEMORY_PUT:
        return okResponse(id, await state.handler.put(params as never));
      case METHOD_MEMORY_GET:
        return okResponse(id, await state.handler.get(params as never));
      case METHOD_MEMORY_QUERY:
        return okResponse(id, await state.handler.query(params as never));
      case METHOD_MEMORY_LIST_SCOPES:
        return okResponse(id, await state.handler.listScopes(params as never));
      case METHOD_MEMORY_DELETE_SCOPE:
        return okResponse(id, await state.handler.deleteScope(params as never));
      default:
        return errorResponse(
          id,
          JsonRpcError.METHOD_NOT_FOUND,
          `method '${frame.method}' not supported`,
        );
    }
  } catch (err) {
    if (err instanceof HandlerError) {
      return errorResponse(id, err.code, err.message, err.data);
    }
    return errorResponse(
      id,
      JsonRpcError.INTERNAL_ERROR,
      `${frame.method} handler threw: ${describeUnknown(err)}`,
    );
  }
}

function describeUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
