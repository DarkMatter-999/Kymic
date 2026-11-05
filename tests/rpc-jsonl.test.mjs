import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('RPC JSONL decoder handles split UTF-8, CRLF, and Unicode line separators', async () => {
  assert.ok(existsSync('server/gateway/jsonl.ts'), 'RPC decoder must exist');
  const { JsonlDecoder } = await import('../server/gateway/jsonl.ts');
  const decoder = new JsonlDecoder();
  const encoded = Buffer.from('{"text":"é\u2028x"}\r\n{"n":2}\n');
  const accent = encoded.indexOf(Buffer.from('é'));
  assert.deepEqual(decoder.push(encoded.subarray(0, accent + 1)), []);
  assert.deepEqual(decoder.push(encoded.subarray(accent + 1)), [{ text: 'é\u2028x' }, { n: 2 }]);
});
