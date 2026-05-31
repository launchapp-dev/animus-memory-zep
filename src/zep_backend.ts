// Thin abstraction over the Zep Cloud SDK's `graph` resource. Lets the
// handler be unit-tested with an in-memory stub instead of needing a live
// `ZEP_API_KEY`.

export interface ZepGraphCreateRequest {
  graphId: string;
  name?: string;
  description?: string;
}

export interface ZepAddDataRequest {
  graphId: string;
  type: 'text' | 'json' | 'message' | 'fact_triple';
  data: string;
  metadata?: Record<string, unknown>;
  sourceDescription?: string;
}

export interface ZepEpisode {
  uuid: string;
  content: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface ZepGraphSearchRequest {
  graphId: string;
  query: string;
  scope?: 'edges' | 'nodes' | 'episodes' | 'thread_summaries' | 'observations' | 'auto';
  limit?: number;
  reranker?: 'rrf' | 'mmr' | 'node_distance' | 'episode_mentions' | 'cross_encoder';
}

export interface ZepEntityEdge {
  uuid?: string;
  fact?: string;
  factEmbedding?: number[];
  name?: string;
  score?: number;
  attributes?: Record<string, unknown>;
}

export interface ZepGraphSearchResults {
  episodes?: ZepEpisode[];
  edges?: ZepEntityEdge[];
}

export interface ZepGraphListAllRequest {
  pageNumber?: number;
  pageSize?: number;
  search?: string;
  orderBy?: string;
  asc?: boolean;
}

export interface ZepGraph {
  graphId?: string;
  name?: string;
  description?: string;
  uuid?: string;
}

export interface ZepGraphListResponse {
  graphs?: ZepGraph[];
  rowCount?: number;
  totalCount?: number;
}

export interface ZepGraphGetEpisodesRequest {
  /** Most-recent N episodes to retrieve. Mirrors Zep `graph.episode.getByGraphId` `lastn`. */
  lastn?: number;
}

export interface ZepGraphGetEpisodesResponse {
  episodes?: ZepEpisode[];
}

/**
 * Minimal interface the memory plugin needs from a Zep client. Both the real
 * `@getzep/zep-cloud` SDK and the test stubs implement this. Field names are
 * preserved to match the SDK's camelCase API surface.
 */
export interface ZepGraphClient {
  create(request: ZepGraphCreateRequest): Promise<ZepGraph>;
  add(request: ZepAddDataRequest): Promise<ZepEpisode>;
  search(request: ZepGraphSearchRequest): Promise<ZepGraphSearchResults>;
  listAll(request?: ZepGraphListAllRequest): Promise<ZepGraphListResponse>;
  delete(graphId: string): Promise<unknown>;
  /**
   * Exhaustive episode listing for `memory/get` fallback scans and
   * `list_scopes` scope-metadata reconstruction. Returns most-recent N
   * episodes per Zep `graph.episode.getByGraphId({ graphId, lastn })`.
   */
  getEpisodes(
    graphId: string,
    request?: ZepGraphGetEpisodesRequest,
  ): Promise<ZepGraphGetEpisodesResponse>;
}

/**
 * Identify the HTTP status of a thrown Zep error in a duck-typed way so the
 * handler module doesn't take a hard dependency on `@getzep/zep-cloud` error
 * classes (the test stub can throw plain `Error` with a `statusCode`).
 */
export function zepErrorStatusCode(err: unknown): number | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err !== 'object') return undefined;
  const obj = err as { statusCode?: unknown };
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  return undefined;
}
