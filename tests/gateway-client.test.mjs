import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { attachGateway } from '../server/gateway/ws.ts';
import { GatewayClient } from '../src/chat/gateway.ts';
import { initialState, reduce } from '../src/chat/reducer.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

const ORIGIN = 'https://agents.example.test';
let root, model, manager, server, client, wss;

afterEach(async () => {
  client?.close();
  await manager?.stopAll();
  await model?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  if (root) await rm(root, { recursive: true, force: true });
  client = manager = model = server = root = undefined;
});

async function setup(script) {
  root = await mkdtemp(join(tmpdir(), 'gc-'));
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
  wss = attachGateway(server, { manager, allowedOrigins: [ORIGIN] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${server.address().port}/gateway`;
}
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out');
};
function connect(url, conversationId) {
  let state = initialState;
  const connection = [];
  client = new GatewayClient({
    url,
    conversationId,
    minDelay: 20,
    maxDelay: 50,
    createSocket: (u) => new WebSocket(u, { headers: { origin: ORIGIN } }),
    onEvent: (e) => {
      state = reduce(state, e);
    },
    onConnection: (c) => connection.push(c),
  });
  client.connect();
  return {
    get state() {
      return state;
    },
    connection,
  };
}

test(
  'client + reducer render a streamed turn from the real gateway',
  { timeout: 60000 },
  async () => {
    const url = await setup([{ text: 'rendered end to end' }]);
    const view = connect(url, 'c1');
    await until(() => client.connected);
    assert.equal(client.prompt('hello'), true);
    await until(
      () =>
        view.state.messages.some((m) => m.role === 'assistant' && !m.draft) &&
        !view.state.running
    );
    assert.deepEqual(
      view.state.messages.map((m) => [m.role, m.parts[0].text]),
      [
        ['user', 'hello'],
        ['assistant', 'rendered end to end'],
      ]
    );
  }
);

test(
  'reconnect after a dropped connection restores state from the snapshot without duplicates',
  { timeout: 60000 },
  async () => {
    const url = await setup([{ text: 'survives reconnect' }]);
    const view = connect(url, 'c1');
    await until(() => client.connected);
    client.prompt('hello');
    await until(() => !view.state.running && view.state.messages.length === 2);
    for (const ws of wss.clients) ws.terminate(); // network drop
    await until(() => view.connection.includes(false));
    await until(() => client.connected);
    await until(
      () =>
        view.state.messages.length === 2 &&
        view.state.messages[1].id.startsWith('pi-')
    );
    assert.equal(view.state.messages[1].parts[0].text, 'survives reconnect');
    assert.equal(view.state.messages.length, 2);
  }
);

test('prompt returns false when disconnected and close stops reconnecting', async () => {
  const url = await setup([]);
  const view = connect(url, 'c1');
  await until(() => client.connected);
  client.close();
  assert.equal(client.prompt('x'), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(wss.clients.size, 0);
  assert.equal(view.connection.at(-1), false);
});

test('respondDialog sends exactly the validated shape and reports whether it was sent', async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send: (d) => sent.push(JSON.parse(d)),
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const c = new GatewayClient({
    url: 'ws://x',
    conversationId: 'c1',
    onEvent() {},
    createSocket: () => socket,
  });
  c.connect();
  socket.onopen({});
  assert.equal(c.respondDialog('d1', { confirmed: true }), true);
  assert.equal(c.respondDialog('d2', { value: 'hi' }), true);
  assert.equal(c.respondDialog('d3', { cancelled: true }), true);
  assert.deepEqual(sent.slice(1), [
    {
      v: 1,
      conversationId: 'c1',
      type: 'dialog_response',
      dialogId: 'd1',
      confirmed: true,
    },
    {
      v: 1,
      conversationId: 'c1',
      type: 'dialog_response',
      dialogId: 'd2',
      value: 'hi',
    },
    {
      v: 1,
      conversationId: 'c1',
      type: 'dialog_response',
      dialogId: 'd3',
      cancelled: true,
    },
  ]);
  socket.readyState = 3;
  assert.equal(c.respondDialog('d4', { cancelled: true }), false);
  c.close();
});

test('edit and regenerate send only the entry ID (and new text for edit)', async () => {
  const sent = [];
  const socket = { readyState: 1, send: (d) => sent.push(JSON.parse(d)), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  const c = new GatewayClient({ url: 'ws://x', conversationId: 'c1', onEvent() {}, createSocket: () => socket });
  c.connect();
  socket.onopen({});
  assert.equal(c.edit('u1', 'new words'), true);
  assert.equal(c.regenerate('u1'), true);
  assert.deepEqual(sent.slice(1), [
    { v: 1, conversationId: 'c1', type: 'edit', entryId: 'u1', text: 'new words' },
    { v: 1, conversationId: 'c1', type: 'regenerate', entryId: 'u1' },
  ]);
  socket.readyState = 3;
  assert.equal(c.edit('u1', 'x'), false);
  assert.equal(c.regenerate('u1'), false);
  c.close();
});
