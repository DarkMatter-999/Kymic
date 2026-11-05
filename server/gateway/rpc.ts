import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { JsonlDecoder } from './jsonl.js';

/** Transport only: a successful prompt response does not mean the agent settled. */
export class RpcClient {
  private readonly decoder = new JsonlDecoder();
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private readonly input: Writable;
  private readonly onEvent: (event: unknown) => void;
  private closed = false;

  constructor(input: Writable, output: Readable, onEvent: (event: unknown) => void) {
    this.input = input;
    this.onEvent = onEvent;
    output.on('data', (chunk: Buffer) => {
      try {
        for (const record of this.decoder.push(chunk)) this.receive(record);
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
    output.on('end', () => this.close());
    output.on('error', error => this.close(error));
    input.on('error', error => this.close(error));
  }

  command(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('RPC transport closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ ...params, id, type }) + '\n', error => {
        if (error) this.close(error);
      });
    });
  }

  close(error = new Error('RPC transport closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('Invalid RPC record');
    const record = value as Record<string, unknown>;
    if (record.type !== 'response') {
      this.onEvent(value);
      return;
    }
    if (typeof record.id !== 'string') throw new Error('RPC response missing id');
    const request = this.pending.get(record.id);
    if (!request) return;
    this.pending.delete(record.id);
    if (record.success === true) request.resolve(record.data);
    else request.reject(new Error(typeof record.error === 'string' ? record.error : 'RPC command failed'));
  }
}
