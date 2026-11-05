import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { RpcClient } from '../server/gateway/rpc.ts';

test('correlates out-of-order responses and forwards events', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events = [];
  const client = new RpcClient(input, output, (event) => events.push(event));
  let sent = '';
  input.on('data', (chunk) => {
    sent += chunk.toString();
  });
  const first = client.command('get_state');
  const second = client.command('get_messages');
  const [a, b] = sent.trim().split('\n').map(JSON.parse);
  output.write(JSON.stringify({ type: 'agent_end' }) + '\n');
  output.write(
    JSON.stringify({
      type: 'response',
      id: b.id,
      command: b.type,
      success: true,
      data: { messages: [] },
    }) + '\n'
  );
  output.write(
    JSON.stringify({
      type: 'response',
      id: a.id,
      command: a.type,
      success: true,
      data: { isStreaming: false },
    }) + '\n'
  );
  assert.deepEqual(await first, { isStreaming: false });
  assert.deepEqual(await second, { messages: [] });
  assert.deepEqual(events, [{ type: 'agent_end' }]);
  client.close();
});

test('rejects pending commands when the RPC output ends', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new RpcClient(input, output, () => {});
  const pending = client.command('get_state');
  output.end();
  await assert.rejects(pending, /closed/i);
  await assert.rejects(client.command('get_state'), /closed/i);
});

test('rejects a failed command without losing subsequent events', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events = [];
  const client = new RpcClient(input, output, (event) => events.push(event));
  let sent = '';
  input.on('data', (chunk) => {
    sent += chunk.toString();
  });
  const pending = client.command('set_model');
  const { id } = JSON.parse(sent);
  output.write(
    JSON.stringify({
      type: 'response',
      id,
      command: 'set_model',
      success: false,
      error: 'Model not found',
    }) + '\n'
  );
  await assert.rejects(pending, /Model not found/);
  output.write('{"type":"agent_settled"}\n');
  assert.deepEqual(events, [{ type: 'agent_settled' }]);
  client.close();
});
