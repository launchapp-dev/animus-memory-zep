#!/usr/bin/env node
// Production entrypoint for the `animus-memory-zep` plugin binary.
//
// Behaviour:
//   - `--manifest` / `-m` → print the static plugin manifest as JSON and exit 0
//     (used by the daemon's discovery pass before spawning a long-running
//     plugin process).
//   - default → read ZEP_API_KEY / ZEP_BASE_URL from the env, construct the
//     Zep client adapter, and run the JSON-RPC stdio loop.
//
// Stdout is reserved for protocol frames. Diagnostics go to stderr.

import process from 'node:process';

import { createServer, buildManifest } from './server.js';
import { createZepGraphClient } from './zep_client_adapter.js';

const NAME = '@launchapp-dev/animus-memory-zep';
const VERSION = '0.1.0';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--manifest') || args.includes('-m')) {
    await flushManifest();
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      `${NAME} ${VERSION} - Animus v0.5 memory_store plugin (Zep Cloud)\n` +
        'Usage:\n' +
        `  ${NAME} --manifest    Print plugin manifest as JSON and exit\n` +
        `  ${NAME}               Run JSON-RPC loop on stdin/stdout\n` +
        '\n' +
        'Environment:\n' +
        '  ZEP_API_KEY  (required) Zep Cloud API key\n' +
        '  ZEP_BASE_URL (optional) Override Zep base URL (BYOC)\n',
    );
    process.exit(0);
  }

  const apiKey = process.env.ZEP_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    process.stderr.write(
      `[${NAME}] ZEP_API_KEY is required. Set it before starting the plugin.\n`,
    );
    process.exit(1);
  }
  const baseUrl = process.env.ZEP_BASE_URL || undefined;
  const client = createZepGraphClient({ apiKey, baseUrl });

  const server = createServer({
    name: NAME,
    version: VERSION,
    handlerDeps: { client },
  });
  await server.run();
}

async function flushManifest(): Promise<void> {
  const manifest = buildManifest(NAME, VERSION);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(manifest)}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[${NAME}] fatal: ${String(err)}\n`);
  process.exit(1);
});
