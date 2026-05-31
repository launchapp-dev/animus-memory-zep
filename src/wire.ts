// Minimal newline-delimited JSON-RPC 2.0 transport over stdio. Mirrors the
// shape of `@launchapp-dev/animus-plugin-sdk`'s wire helper but is vendored
// here because the published SDK (v0.1.x) does not yet wire the memory_store
// role.
//
// Stdout is reserved for protocol frames; diagnostics go to stderr.

import { stdin as nodeStdin, stdout as nodeStdout } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: RpcId;
  result: unknown;
}

export interface RpcErrorEnvelope {
  jsonrpc: '2.0';
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcErrorEnvelope;

export type FrameHandler = (
  frame: RpcRequest,
) => Promise<RpcResponse | undefined> | RpcResponse | undefined;

export function okResponse(id: RpcId | undefined, result: unknown): RpcSuccess {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function errorResponse(
  id: RpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
): RpcErrorEnvelope {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function encodeFrame(frame: RpcResponse | RpcRequest): string {
  return `${JSON.stringify(frame)}\n`;
}

export function parseFrame(line: string): RpcRequest {
  const value = JSON.parse(line) as unknown;
  if (typeof value !== 'object' || value === null) {
    throw new Error('frame is not a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    throw new Error(`unsupported jsonrpc version: ${String(obj.jsonrpc)}`);
  }
  if (typeof obj.method !== 'string' || obj.method.length === 0) {
    throw new Error('frame missing string `method`');
  }
  const frame: RpcRequest = { jsonrpc: '2.0', method: obj.method };
  if ('id' in obj) frame.id = obj.id as RpcId;
  if ('params' in obj) frame.params = obj.params;
  return frame;
}

export interface WireOptions {
  input?: Readable;
  output?: Writable;
  logger?: (msg: string, err?: unknown) => void;
}

export interface Wire {
  sendResponse(response: RpcResponse): Promise<void>;
  run(handler: FrameHandler): Promise<void>;
}

const defaultLogger = (msg: string, err?: unknown): void => {
  if (err !== undefined) {
    process.stderr.write(`[animus-memory-zep] ${msg}: ${String(err)}\n`);
  } else {
    process.stderr.write(`[animus-memory-zep] ${msg}\n`);
  }
};

class WriteQueue {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly output: Writable) {}

  enqueue(payload: string): Promise<void> {
    const next = this.chain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.output.write(payload, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function createWire(options: WireOptions = {}): Wire {
  const input = options.input ?? nodeStdin;
  const output = options.output ?? nodeStdout;
  const log = options.logger ?? defaultLogger;
  const queue = new WriteQueue(output);

  const sendResponse: Wire['sendResponse'] = (response) => queue.enqueue(encodeFrame(response));

  const run: Wire['run'] = (handler) =>
    new Promise<void>((resolve, reject) => {
      let buffer = '';
      let closed = false;
      const decoder = new StringDecoder('utf8');
      let dispatchChain: Promise<void> = Promise.resolve();

      const handleOne = async (line: string): Promise<void> => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let frame: RpcRequest;
        try {
          frame = parseFrame(trimmed);
        } catch (err) {
          log('invalid JSON-RPC frame', err);
          return;
        }
        try {
          const response = await handler(frame);
          if (response !== undefined) {
            await sendResponse(response);
          }
        } catch (err) {
          log(`handler error for method '${frame.method}'`, err);
        }
      };

      const enqueue = (line: string): void => {
        dispatchChain = dispatchChain.then(() => handleOne(line));
      };

      const onData = (chunk: Buffer | string): void => {
        buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          enqueue(line);
          idx = buffer.indexOf('\n');
        }
      };

      const finish = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        buffer += decoder.end();
        if (buffer.length > 0) {
          enqueue(buffer);
          buffer = '';
        }
        await dispatchChain;
        resolve();
      };

      const onError = (err: Error): void => {
        if (closed) return;
        closed = true;
        reject(err);
      };

      input.on('data', onData);
      input.once('end', () => {
        void finish();
      });
      input.once('close', () => {
        void finish();
      });
      input.once('error', onError);
    });

  return { sendResponse, run };
}
