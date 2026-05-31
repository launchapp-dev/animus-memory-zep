// Adapter that conforms the real `@getzep/zep-cloud` SDK to the local
// `ZepGraphClient` interface used by the handler. Keeping the SDK behind an
// interface lets unit tests run without `ZEP_API_KEY`.

import { ZepClient } from '@getzep/zep-cloud';
import type {
  ZepAddDataRequest,
  ZepEpisode,
  ZepGraph,
  ZepGraphClient,
  ZepGraphCreateRequest,
  ZepGraphListAllRequest,
  ZepGraphListResponse,
  ZepGraphSearchRequest,
  ZepGraphSearchResults,
} from './zep_backend.js';

export interface ZepAdapterOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createZepGraphClient(opts: ZepAdapterOptions): ZepGraphClient {
  if (!opts.apiKey || typeof opts.apiKey !== 'string') {
    throw new Error('createZepGraphClient: apiKey is required');
  }
  const client = new ZepClient({
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
  return {
    async create(req: ZepGraphCreateRequest): Promise<ZepGraph> {
      return (await client.graph.create(req)) as ZepGraph;
    },
    async add(req: ZepAddDataRequest): Promise<ZepEpisode> {
      return (await client.graph.add(req)) as ZepEpisode;
    },
    async search(req: ZepGraphSearchRequest): Promise<ZepGraphSearchResults> {
      // The SDK accepts the same camelCase shape directly.
      return (await client.graph.search(req)) as ZepGraphSearchResults;
    },
    async listAll(req?: ZepGraphListAllRequest): Promise<ZepGraphListResponse> {
      return (await client.graph.listAll(req)) as ZepGraphListResponse;
    },
    async delete(graphId: string): Promise<unknown> {
      return await client.graph.delete(graphId);
    },
  };
}
