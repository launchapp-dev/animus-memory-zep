// Wire types and constants for the v0.5 memory_store protocol.
//
// Mirrors `animus-memory-store-protocol` (Rust crate, animus-protocol v0.5.0):
// https://github.com/launchapp-dev/animus-protocol/tree/v0.5.0
//
// All field names use snake_case to match the Rust serde wire format. All
// method strings are snake_case verbs under the `memory/` namespace.

export const KIND = 'memory_store' as const;

// Method constants — keep in sync with `animus_memory_store_protocol::METHOD_*`.
export const METHOD_MEMORY_PUT = 'memory/put';
export const METHOD_MEMORY_GET = 'memory/get';
export const METHOD_MEMORY_QUERY = 'memory/query';
export const METHOD_MEMORY_LIST_SCOPES = 'memory/list_scopes';
export const METHOD_MEMORY_DELETE_SCOPE = 'memory/delete_scope';

// Per-spec error codes (`animus_memory_store_protocol::error_codes`).
export const error_codes = {
  SCOPE_NOT_FOUND: -32301,
  KEY_NOT_FOUND: -32302,
  MEMORY_SCOPE_COLLISION: -32303,
  BACKEND_UNAVAILABLE: -32304,
  RATE_LIMITED: -32305,
  QUERY_TOP_K_EXCEEDED: -32306,
  PROJECT_BINDING_MISMATCH: -32307,
} as const;

// JSON-RPC standard error codes (subset).
export const JsonRpcError = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface MemoryScope {
  project_id: string;
  agent_id?: string | null;
  task_id?: string | null;
}

export interface PutMemoryRequest {
  scope: MemoryScope;
  key: string;
  value: unknown;
  /** Advisory; backends with `native_ttl: false` only record this in metadata. */
  ttl_secs?: number | null;
}

export interface PutMemoryResponse {
  ack: boolean;
  /**
   * Whether the backend has fully indexed the value such that `query` is
   * expected to find it immediately. Zep ingestion is async → always `false`.
   */
  indexed_immediately: boolean;
  /** Backend-issued identifier (Zep episode UUID). May be empty if unavailable. */
  record_id: string;
}

export interface GetMemoryRequest {
  scope: MemoryScope;
  key: string;
}

export interface GetMemoryResponse {
  found: boolean;
  value?: unknown;
}

export interface QueryMemoryRequest {
  scope: MemoryScope;
  query: string;
  top_k: number;
}

export interface QueryMemoryResponse {
  results: MemoryQueryResult[];
}

export interface MemoryQueryResult {
  key: string;
  value: unknown;
  score: number;
}

export interface ListScopesRequest {
  project_id?: string | null;
  cursor?: string | null;
  page_size?: number | null;
}

export interface ListScopesResponse {
  scopes: MemoryScope[];
  next_cursor?: string | null;
}

export interface DeleteScopeRequest {
  scope: MemoryScope;
}

export interface DeleteScopeResponse {
  ack: boolean;
}

export interface MemoryStoreCapabilities {
  native_ttl: boolean;
  native_key_get: boolean;
  strong_consistency: boolean;
  max_query_top_k: number;
}

// `animus-plugin-protocol` v1.1.0 handshake shape (subset needed here).
export interface InitializeParams {
  protocol_version?: string;
  init_extensions?: Record<string, unknown>;
  // Other fields ignored.
  [key: string]: unknown;
}

export interface ProjectBinding {
  project_root: string;
  repo_scope?: string;
}

export const PROTOCOL_VERSION = '1.1.0';
