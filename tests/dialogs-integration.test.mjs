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

let root, model, manager, server;
afterEach(async () => {
  await manager?.stopAll();
  await model?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = model = manager = server = undefined;
});

const until = async (check, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
};

async function setup(toolCalls, options = {}) {
  root = await mkdtemp(join(tmpdir(), 'dlg-'));
  model = await startFakeModel([
    {
      toolCalls: toolCalls.map((arguments_, i) => ({
        name: arguments_.__tool ?? 'ask_user',
        arguments: { ...arguments_, __tool: undefined },
      })),
    },
    { text: 'finished' },
  ]);
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
    extensions: [
      'builtin:mcp',
      'builtin:codemode',
      resolve('tests/fixtures/extensions/dialog-ext.mjs'),
    ],
    ...options,
  });
}
const watch = (id = 'c1') => {
  const events = [];
  const off = manager.subscribe(id, (e) => events.push(e));
  return { events, off };
};
const answerOf = (events) =>
  events.find((e) => e.type === 'tool_end')?.result?.content?.[0]?.text;
const settled = (events) => events.some((e) => e.type === 'settled');
const dialog = (events) => events.find((e) => e.type === 'dialog_request');

for (const [method, answer, expected] of [
  ['confirm', { confirmed: true }, 'ANSWER:true'],
  ['select', { value: 'Block' }, 'ANSWER:"Block"'],
  ['input', { value: 'Ada' }, 'ANSWER:"Ada"'],
  ['editor', { value: 'a\nb\nc' }, 'ANSWER:"a\\nb\\nc"'],
]) {
  test(
    `${method} dialog: request reaches the browser and the answer reaches the extension`,
    { timeout: 60000 },
    async () => {
      await setup([{ method }]);
      const { events } = watch();
      await manager.prompt('c1', 'ask me');
      await until(() => dialog(events));
      const d = dialog(events);
      assert.equal(d.method, method);
      assert.ok(d.title.length > 0);
      if (method === 'select') assert.deepEqual(d.options, ['Allow', 'Block']);
      if (method === 'editor') assert.equal(d.prefill, 'line1\nline2');
      manager.respondDialog('c1', d.dialogId, answer);
      await until(() => settled(events));
      assert.equal(answerOf(events), expected);
      assert.equal(
        events.find((e) => e.type === 'dialog_closed').reason,
        'answered'
      );
    }
  );
}

test(
  'cancelling a dialog is a denial: confirm returns false',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm' }]);
    const { events } = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => dialog(events));
    manager.respondDialog('c1', dialog(events).dialogId, { cancelled: true });
    await until(() => settled(events));
    assert.equal(answerOf(events), 'ANSWER:false');
  }
);

test(
  'a duplicate answer is rejected and has no effect on the run',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm' }]);
    const { events } = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => dialog(events));
    const id = dialog(events).dialogId;
    manager.respondDialog('c1', id, { confirmed: true });
    assert.throws(
      () => manager.respondDialog('c1', id, { confirmed: false }),
      /already answered|unknown/i
    );
    assert.throws(
      () => manager.respondDialog('c1', 'never-existed', { confirmed: true }),
      /unknown/i
    );
    await until(() => settled(events));
    assert.equal(answerOf(events), 'ANSWER:true');
  }
);

test(
  'unattended: with no answer the gateway deadline denies and the run finishes',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm' }], { dialogTimeoutMs: 500 });
    const { events } = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => settled(events));
    assert.equal(
      events.find((e) => e.type === 'dialog_closed').reason,
      'timeout'
    );
    assert.equal(answerOf(events), 'ANSWER:false');
  }
);

test(
  'a Pi-side timeout resolves the dialog and the gateway forgets it',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm', timeout: 400 }]);
    const { events } = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => settled(events));
    // Pi resolved it on its own; the gateway forgets it shortly after (no stale dialog).
    await until(() => events.some((e) => e.type === 'dialog_closed'));
    assert.equal(
      events.find((e) => e.type === 'dialog_closed').reason,
      'timeout'
    );
    assert.equal(answerOf(events), 'ANSWER:false');
    assert.deepEqual((await manager.snapshot('c1')).dialogs, []);
  }
);

test(
  'closing the browser with a question open cancels it after the grace period',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm' }], { disconnectGraceMs: 300 });
    const first = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => dialog(first.events));
    first.off();
    // Nobody is listening, so the close event is not delivered; the run just finishes.
    await until(() => !manager.isRunning('c1'));
    assert.deepEqual((await manager.snapshot('c1')).dialogs, []);
    const history = JSON.stringify((await manager.snapshot('c1')).messages);
    assert.ok(history.includes('ANSWER:false'));
  }
);

test(
  'reconnecting within the grace period shows the open question in the snapshot',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'select' }], { disconnectGraceMs: 5000 });
    const first = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => dialog(first.events));
    first.off();
    const snapshot = await manager.snapshot('c1');
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.dialogs.length, 1);
    assert.equal(snapshot.dialogs[0].method, 'select');
    const second = watch();
    manager.respondDialog('c1', snapshot.dialogs[0].dialogId, {
      value: 'Allow',
    });
    await until(() => settled(second.events));
    assert.equal(answerOf(second.events), 'ANSWER:"Allow"');
  }
);

test(
  'a worker that dies with a question open clears it and the running state',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm' }]);
    const { events } = watch();
    await manager.prompt('c1', 'ask me');
    await until(() => dialog(events));
    manager.launcher.peek('c1').child.kill('SIGKILL');
    await until(() => !manager.isRunning('c1'));
    assert.equal(
      events.find((e) => e.type === 'dialog_closed').reason,
      'worker_exited'
    );
    assert.throws(
      () =>
        manager.respondDialog('c1', dialog(events).dialogId, {
          confirmed: true,
        }),
      /unknown/i
    );
  }
);

test(
  'notify is a notice and other UI methods are reported as unsupported',
  { timeout: 60000 },
  async () => {
    await setup([{ __tool: 'ui_noise' }]);
    const { events } = watch();
    await manager.prompt('c1', 'make noise');
    await until(() => settled(events));
    const notice = events.find((e) => e.type === 'notice');
    assert.deepEqual(
      { level: notice.level, message: notice.message },
      { level: 'warning', message: 'hello notice' }
    );
    assert.deepEqual(
      events
        .filter((e) => e.type === 'ui_unsupported')
        .map((e) => e.method)
        .sort(),
      ['setStatus', 'setWidget']
    );
  }
);

test(
  'over the WebSocket: dialog_request arrives and dialog_response is routed once',
  { timeout: 60000 },
  async () => {
    await setup([{ method: 'confirm' }]);
    server = createServer();
    attachGateway(server, {
      manager,
      allowedOrigins: ['https://x.test'],
      authenticate: () => true,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/gateway`,
      { headers: { origin: 'https://x.test' } }
    );
    const events = [];
    ws.on('message', (d) => events.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    const send = (c) =>
      ws.send(JSON.stringify({ v: 1, conversationId: 'c1', ...c }));
    send({ type: 'prompt', text: 'ask me' });
    await until(() => dialog(events));
    const id = dialog(events).dialogId;
    send({ type: 'dialog_response', dialogId: id, value: 'not a boolean' });
    await until(() =>
      events.some((e) => e.type === 'error' && /confirm/i.test(e.message))
    );
    send({ type: 'dialog_response', dialogId: id, confirmed: true });
    send({ type: 'dialog_response', dialogId: id, confirmed: true });
    await until(() => settled(events));
    await until(() => events.filter((e) => e.type === 'error').length >= 2);
    assert.equal(answerOf(events), 'ANSWER:true');
    ws.close();
  }
);
