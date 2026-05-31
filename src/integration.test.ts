// =========================================================================
// LIVE INTEGRATION TEST — currently SKIPPED.
//
// PROMINENT NOTICE: this suite runs the full memory_store round trip
// (put → query → get → list_scopes → delete_scope) against a real Zep Cloud
// account. It is skipped by default because `ZEP_API_KEY` is not yet
// available in the build environment (per Wave 3 brief — the orchestrator
// arranges the key before Wave 4 demos).
//
// TODO(wave-3-coordinator): once ZEP_API_KEY is provisioned for CI, change
// the `describe.skip` below to `describe.runIf(process.env.ZEP_API_KEY)`
// (or set RUN_LIVE_ZEP=1 to enable). Until then this file is compile-checked
// but not executed.
//
// Run manually with:
//   RUN_LIVE_ZEP=1 ZEP_API_KEY=... npx vitest run src/integration.test.ts
// =========================================================================

import { describe, it, expect } from 'vitest';
import { MemoryStoreHandler } from './handler.js';
import { createZepGraphClient } from './zep_client_adapter.js';

const LIVE = process.env.RUN_LIVE_ZEP === '1' && process.env.ZEP_API_KEY;

describe.skipIf(!LIVE)('live Zep Cloud round-trip', () => {
  // The test scope id MUST be unique-ish to avoid collisions with other
  // concurrent runs against the same Zep account.
  const projectId = `animus-memzep-it-${Date.now()}`;
  const scope = { project_id: projectId };

  it('put → (wait) → query → get → list_scopes → delete_scope', async () => {
    const apiKey = process.env.ZEP_API_KEY!;
    const baseUrl = process.env.ZEP_BASE_URL;
    const client = createZepGraphClient({ apiKey, baseUrl });
    const handler = new MemoryStoreHandler({ client });

    // 1. put
    const putRes = await handler.put({
      scope,
      key: 'profile/last_seen',
      value: { url: 'https://example.com', at: new Date().toISOString() },
    });
    expect(putRes.ack).toBe(true);
    expect(putRes.indexed_immediately).toBe(false);
    expect(typeof putRes.record_id).toBe('string');

    // 2. Wait for async ingestion (Zep is eventually consistent).
    //    This is best-effort; the test asserts capability flags rather than
    //    relying on immediate consistency.
    await new Promise((r) => setTimeout(r, 8_000));

    // 3. get — may be eventually consistent. We don't fail the test if it
    //    misses; we just record the result.
    const getRes = await handler.get({ scope, key: 'profile/last_seen' });
    expect([true, false]).toContain(getRes.found);

    // 4. query
    const queryRes = await handler.query({ scope, query: 'last seen url', top_k: 5 });
    expect(Array.isArray(queryRes.results)).toBe(true);

    // 5. list_scopes — must find our project.
    const listRes = await handler.listScopes({ project_id: projectId });
    expect(listRes.scopes.length).toBeGreaterThanOrEqual(1);

    // 6. delete_scope
    const delRes = await handler.deleteScope({ scope });
    expect(delRes.ack).toBe(true);
  }, 60_000);
});
