// Public library surface for `@launchapp-dev/animus-memory-zep`.
//
// Most users will not import this — the binary entrypoint is `dist/main.js`
// (see `src/main.ts`). Library exports are provided so the plugin can be
// embedded into integration tests and so the protocol shapes can be shared.

export { CAPABILITIES, HandlerError, MemoryStoreHandler } from './handler.js';
export type { HandlerDeps } from './handler.js';
export { buildManifest, createServer } from './server.js';
export type { ServerConfig } from './server.js';
export {
  graphIdForAgent,
  graphIdForProject,
  graphIdForScope,
  graphIdForTask,
  listScopesPrefix,
  normalize,
} from './normalize.js';
export {
  error_codes,
  JsonRpcError,
  KIND,
  METHOD_MEMORY_DELETE_SCOPE,
  METHOD_MEMORY_GET,
  METHOD_MEMORY_LIST_SCOPES,
  METHOD_MEMORY_PUT,
  METHOD_MEMORY_QUERY,
  PROTOCOL_VERSION,
} from './protocol.js';
export type {
  DeleteScopeRequest,
  DeleteScopeResponse,
  GetMemoryRequest,
  GetMemoryResponse,
  InitializeParams,
  ListScopesRequest,
  ListScopesResponse,
  MemoryQueryResult,
  MemoryScope,
  MemoryStoreCapabilities,
  ProjectBinding,
  PutMemoryRequest,
  PutMemoryResponse,
  QueryMemoryRequest,
  QueryMemoryResponse,
} from './protocol.js';
export type {
  ZepEntityEdge,
  ZepEpisode,
  ZepGraph,
  ZepGraphClient,
  ZepGraphListResponse,
  ZepGraphSearchResults,
} from './zep_backend.js';
export { createZepGraphClient } from './zep_client_adapter.js';
