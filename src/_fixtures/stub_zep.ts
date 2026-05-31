// In-memory Zep stub used by unit tests. Implements the minimum surface
// required by `MemoryStoreHandler` and lets tests assert exact request shapes
// without needing `ZEP_API_KEY`.

import type {
  ZepAddDataRequest,
  ZepEpisode,
  ZepEntityEdge,
  ZepGraph,
  ZepGraphClient,
  ZepGraphCreateRequest,
  ZepGraphListAllRequest,
  ZepGraphListResponse,
  ZepGraphSearchRequest,
  ZepGraphSearchResults,
} from '../zep_backend.js';

export interface StubGraph {
  graphId: string;
  name?: string;
  description?: string;
  episodes: ZepEpisode[];
}

export class StubZepClient implements ZepGraphClient {
  graphs = new Map<string, StubGraph>();
  createCalls: ZepGraphCreateRequest[] = [];
  addCalls: ZepAddDataRequest[] = [];
  searchCalls: ZepGraphSearchRequest[] = [];
  listAllCalls: (ZepGraphListAllRequest | undefined)[] = [];
  deleteCalls: string[] = [];
  episodeCounter = 0;
  /** If set, `add` returns the next pre-seeded edge from this list for `search` calls. */
  preseededEdges: ZepEntityEdge[] = [];

  async create(request: ZepGraphCreateRequest): Promise<ZepGraph> {
    this.createCalls.push(request);
    if (this.graphs.has(request.graphId)) {
      // Emit a thrown 409, like Zep does for duplicate graphIds.
      throw makeStatusError(409, `graph already exists: ${request.graphId}`);
    }
    const g: StubGraph = {
      graphId: request.graphId,
      name: request.name,
      description: request.description,
      episodes: [],
    };
    this.graphs.set(request.graphId, g);
    return { graphId: g.graphId, name: g.name, description: g.description };
  }

  async add(request: ZepAddDataRequest): Promise<ZepEpisode> {
    this.addCalls.push(request);
    const gid = request.graphId ?? '';
    const g = this.graphs.get(gid);
    if (!g) throw makeStatusError(404, `graph not found: ${gid}`);
    const episode: ZepEpisode = {
      uuid: `ep-${++this.episodeCounter}`,
      content: request.data,
      metadata: request.metadata,
    };
    g.episodes.push(episode);
    return episode;
  }

  async search(request: ZepGraphSearchRequest): Promise<ZepGraphSearchResults> {
    this.searchCalls.push(request);
    const g = this.graphs.get(request.graphId);
    if (!g) throw makeStatusError(404, `graph not found: ${request.graphId}`);
    if (request.scope === 'episodes') {
      // Return all episodes in the graph; handler filters by metadata.key.
      return { episodes: g.episodes };
    }
    if (request.scope === 'edges') {
      // Edges-shaped result. Tests pre-seed this list.
      return { edges: this.preseededEdges.slice(0, request.limit ?? 10) };
    }
    return {};
  }

  async listAll(request?: ZepGraphListAllRequest): Promise<ZepGraphListResponse> {
    this.listAllCalls.push(request);
    const all: ZepGraph[] = [];
    for (const g of this.graphs.values()) {
      all.push({ graphId: g.graphId, name: g.name, description: g.description });
    }
    const pageSize = request?.pageSize ?? 100;
    const pageNumber = request?.pageNumber ?? 1;
    const start = (pageNumber - 1) * pageSize;
    const end = start + pageSize;
    return {
      graphs: all.slice(start, end),
      rowCount: Math.min(pageSize, Math.max(0, all.length - start)),
      totalCount: all.length,
    };
  }

  async delete(graphId: string): Promise<unknown> {
    this.deleteCalls.push(graphId);
    if (!this.graphs.delete(graphId)) {
      throw makeStatusError(404, `graph not found: ${graphId}`);
    }
    return { success: true };
  }
}

export function makeStatusError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}
