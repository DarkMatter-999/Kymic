import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { attachGateway } from '../server/gateway/ws.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

const ORIGIN = 'https://agents.example.test';
let root, model, manager, server;

async function setup(script, options = {}) {
  root = await mkdtemp(join(tmpdir(), 'ws-'));
  model = await startFakeModel(script);
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
  await writeFile(
    join(root, 'home', 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
  );
  manager = new ConversationManager({
    piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    workspaceRoot: join(root, 'ws'),
    sessionRoot: join(root, 'sessions'),
    agentHome: join(root, 'home'),
    skills: [],
  });
  server = createServer();
  attachGateway(server, { manager, allowedOrigins: [ORIGIN], ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${server.address().port}/gateway`;
}
afterEach(async () => {
  await manager?.stopAll();
  await model?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  if (root) await rm(root, { recursive: true, force: true });
  manager = model = server = root = undefined;
});

const open = (url, headers = { origin: ORIGIN }) =>
  new Promise((resolveOpen, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.events = [];
    ws.on('message', (d) => ws.events.push(JSON.parse(d.toString())));
    ws.once('open', () => resolveOpen(ws));
    ws.once('unexpected-response', (_req, res) =>
      reject(
        Object.assign(new Error(`HTTP ${res.statusCode}`), {
          status: res.statusCode,
        })
      )
    );
    ws.once('error', reject);
  });
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out');
};
const send = (ws, cmd) => ws.send(JSON.stringify({ v: 1, ...cmd }));

test('rejects foreign, missing and unauthenticated origins at the handshake', async () => {
  const url = await setup([]);
  await assert.rejects(open(url, { origin: 'https://evil.example' }), {
    status: 403,
  });
  await assert.rejects(open(url, {}), { status: 403 });
  await rm(root, { recursive: true, force: true });
  await manager.stopAll();
  await model.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  const denied = await setup([], { authenticate: () => false });
  await assert.rejects(open(denied), { status: 401 });
});

test('invalid commands produce an error event and keep the socket open', async () => {
  const ws = await open(await setup([]));
  ws.send('not json');
  send(ws, { type: 'bash', conversationId: 'c1' });
  send(ws, { type: 'prompt', conversationId: '../x', text: 'hi' });
  await until(() => ws.events.filter((e) => e.type === 'error').length === 3);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test(
  'subscribe returns a snapshot; a prompt streams to settled over the socket',
  { timeout: 60000 },
  async () => {
    const ws = await open(await setup([{ text: 'over the wire' }]));
    send(ws, { type: 'subscribe', conversationId: 'c1' });
    await until(() => ws.events.some((e) => e.type === 'snapshot'));
    assert.deepEqual(ws.events.find((e) => e.type === 'snapshot').messages, []);
    send(ws, { type: 'prompt', conversationId: 'c1', text: 'go' });
    await until(() => ws.events.some((e) => e.type === 'settled'));
    assert.equal(
      ws.events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.delta)
        .join(''),
      'over the wire'
    );
    ws.close();
  }
);

test(
  'a prompt without subscribe still streams to that socket',
  { timeout: 60000 },
  async () => {
    const ws = await open(await setup([{ text: 'implicit' }]));
    send(ws, { type: 'prompt', conversationId: 'c1', text: 'go' });
    await until(() => ws.events.some((e) => e.type === 'settled'));
    ws.close();
  }
);

test(
  'busy prompts return an error event; abort works',
  { timeout: 60000 },
  async () => {
    const ws = await open(
      await setup([{ text: 'a long slow answer indeed', chunkDelayMs: 400 }])
    );
    send(ws, { type: 'prompt', conversationId: 'c1', text: 'one' });
    await until(() => ws.events.some((e) => e.type === 'text_delta'));
    send(ws, { type: 'prompt', conversationId: 'c1', text: 'two' });
    await until(() =>
      ws.events.some((e) => e.type === 'error' && /busy/i.test(e.message))
    );
    send(ws, { type: 'abort', conversationId: 'c1' });
    await until(() => ws.events.some((e) => e.type === 'settled'));
    assert.equal(ws.events.find((e) => e.type === 'settled').aborted, true);
    ws.close();
  }
);

test(
  'closing the socket unsubscribes but the run continues; a new socket gets history',
  { timeout: 60000 },
  async () => {
    const url = await setup([
      { text: 'finished unattended', chunkDelayMs: 150 },
    ]);
    const first = await open(url);
    send(first, { type: 'prompt', conversationId: 'c1', text: 'go' });
    await until(() => first.events.some((e) => e.type === 'text_delta'));
    first.close();
    await until(() => manager.listenerCount('c1') === 0);
    await until(() => !manager.isRunning('c1'));
    const second = await open(url);
    send(second, { type: 'subscribe', conversationId: 'c1' });
    await until(() => second.events.some((e) => e.type === 'snapshot'));
    const snap = second.events.find((e) => e.type === 'snapshot');
    assert.equal(snap.running, false);
    assert.ok(JSON.stringify(snap.messages).includes('finished unattended'));
    second.close();
  }
);

test('oversized frames close the connection', async () => {
  const ws = await open(await setup([]));
  const closed = new Promise((r) => ws.once('close', r));
  ws.send('x'.repeat(2 * 1024 * 1024));
  assert.equal(await closed, 1009);
});

test('other upgrade paths are not handled by the gateway', async () => {
  const url = (await setup([])).replace('/gateway', '/elsewhere');
  const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
  await assert.rejects(
    new Promise((_, reject) => {
      ws.once('error', reject);
      ws.once('open', () => reject(new Error('opened')));
    })
  );
});
