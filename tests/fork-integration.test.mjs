import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
  readdir,
} from 'node:fs/promises';
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
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
};
const newManager = () =>
  new ConversationManager({
    piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    workspaceRoot: join(root, 'ws'),
    sessionRoot: join(root, 'sessions'),
    agentHome: join(root, 'home'),
    skills: [],
  });
async function setup(script) {
  root = await mkdtemp(join(tmpdir(), 'fork-'));
  model = await startFakeModel(script);
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
  await writeFile(
    join(root, 'home', 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
  );
  manager = newManager();
}
const text = (m) => m.content.map((b) => b.text ?? '').join('');
const view = (snap) =>
  snap.messages
    .filter((m) => m.role !== 'toolResult')
    .map((m) => `${m.role}:${text(m)}`);
async function turn(id, prompt) {
  const events = [];
  const off = manager.subscribe(id, (e) => events.push(e));
  await manager.prompt(id, prompt);
  await until(
    () => events.some((e) => e.type === 'settled') && !manager.isRunning(id)
  );
  off();
  return events;
}
async function forkTurn(id, entryId, newText) {
  const events = [];
  const off = manager.subscribe(id, (e) => events.push(e));
  await manager.forkAndPrompt(id, entryId, newText);
  await until(
    () => events.some((e) => e.type === 'settled') && !manager.isRunning(id)
  );
  off();
  return events;
}
const sessionFile = async (id) =>
  (await (await manager.launcher.start(id)).rpc.command('get_state'))
    .sessionFile;
const userEntry = (snap, str) =>
  snap.messages.find((m) => m.role === 'user' && text(m) === str).entryId;
const sessionDir = (id) => join(root, 'sessions', id);

test(
  'a settled turn publishes Pi’s authoritative history with entry IDs before settled',
  { timeout: 60000 },
  async () => {
    await setup([{ text: 'answer one' }]);
    const events = await turn('c1', 'question one');
    const snap = events.find((e) => e.type === 'snapshot');
    assert.ok(snap, 'snapshot event published');
    assert.equal(snap.running, false);
    assert.deepEqual(view(snap), ['user:question one', 'assistant:answer one']);
    assert.ok(
      snap.messages.every(
        (m) => typeof m.entryId === 'string' && m.entryId.length > 0
      )
    );
    assert.ok(typeof snap.leafId === 'string');
    const order = events.map((e) => e.type);
    assert.ok(order.indexOf('snapshot') < order.indexOf('settled'));
    assert.equal(order.at(-1), 'status');
  }
);

test(
  'edit forks the session: new branch shown, original preserved, nothing replayed to the model',
  { timeout: 90000 },
  async () => {
    await setup([
      { text: 'answer one' },
      { text: 'answer two' },
      { text: 'answer to the edit' },
    ]);
    await turn('c1', 'question one');
    await turn('c1', 'question two');
    const before = await manager.snapshot('c1');
    const originalFile = await sessionFile('c1');
    const target = userEntry(before, 'question two');

    const events = await forkTurn('c1', target, 'a different question');
    const after = await manager.snapshot('c1');
    assert.deepEqual(view(after), [
      'user:question one',
      'assistant:answer one',
      'user:a different question',
      'assistant:answer to the edit',
    ]);
    assert.notEqual(after.leafId, before.leafId);
    // The fork is published as soon as it exists, before the new reply.
    assert.ok(events.some((e) => e.type === 'snapshot'));

    const forkedFile = await sessionFile('c1');
    assert.notEqual(forkedFile, originalFile);
    const original = await readFile(originalFile, 'utf8');
    assert.ok(
      original.includes('answer two') && original.includes('question two')
    );
    assert.ok(
      !original.includes('answer to the edit') &&
        !original.includes('a different question')
    );

    // The model only saw the surviving branch plus the edit: no replay of the old exchange.
    const lastRequest = JSON.stringify(model.requests.at(-1).messages);
    assert.ok(
      lastRequest.includes('question one') &&
        lastRequest.includes('a different question')
    );
    assert.ok(
      !lastRequest.includes('question two') &&
        !lastRequest.includes('answer two')
    );
    assert.equal(
      JSON.parse(await readFile(join(sessionDir('c1'), 'current.json'), 'utf8'))
        .sessionFile,
      forkedFile
    );
  }
);

test(
  'regenerate re-asks the same prompt on a new branch without duplicating it',
  { timeout: 90000 },
  async () => {
    await setup([{ text: 'answer one' }, { text: 'a better answer' }]);
    await turn('c1', 'question one');
    const first = await manager.snapshot('c1');
    const originalFile = await sessionFile('c1');
    await forkTurn('c1', userEntry(first, 'question one'));
    const after = await manager.snapshot('c1');
    assert.deepEqual(view(after), [
      'user:question one',
      'assistant:a better answer',
    ]);
    const userMessages = model.requests
      .at(-1)
      .messages.filter((m) => m.role === 'user');
    assert.equal(userMessages.length, 1);
    assert.ok((await readFile(originalFile, 'utf8')).includes('answer one'));
  }
);

test(
  'after a restart the conversation resumes the fork by explicit mapping, not by file age',
  { timeout: 90000 },
  async () => {
    await setup([
      { text: 'answer one' },
      { text: 'answer two' },
      { text: 'forked answer' },
    ]);
    await turn('c1', 'question one');
    await turn('c1', 'question two');
    const originalFile = await sessionFile('c1');
    await forkTurn(
      'c1',
      userEntry(await manager.snapshot('c1'), 'question two'),
      'edited question'
    );
    await manager.stopAll();
    // Make the ORIGINAL file the newest on disk: "--continue" alone would now pick it.
    const future = new Date(Date.now() + 3_600_000);
    await utimes(originalFile, future, future);
    manager = newManager();
    const resumed = await manager.snapshot('c1');
    assert.deepEqual(view(resumed), [
      'user:question one',
      'assistant:answer one',
      'user:edited question',
      'assistant:forked answer',
    ]);
    assert.equal(
      (await readdir(sessionDir('c1'))).filter((f) => f.endsWith('.jsonl'))
        .length,
      2
    );
  }
);

test(
  'bad entry IDs fail cleanly and change nothing',
  { timeout: 90000 },
  async () => {
    await setup([{ text: 'answer one' }, { text: 'still works' }]);
    await turn('c1', 'question one');
    const snap = await manager.snapshot('c1');
    const fileBefore = await sessionFile('c1');
    const assistantEntry = snap.messages.find(
      (m) => m.role === 'assistant'
    ).entryId;
    await assert.rejects(manager.forkAndPrompt('c1', 'does-not-exist', 'x'));
    await assert.rejects(manager.forkAndPrompt('c1', assistantEntry, 'x')); // only user messages can be forked
    assert.equal(manager.isRunning('c1'), false);
    assert.equal(await sessionFile('c1'), fileBefore);
    assert.deepEqual(view(await manager.snapshot('c1')), view(snap));
    await assert.rejects(readFile(join(sessionDir('c1'), 'current.json')));
    await turn('c1', 'second question'); // the conversation is still usable
    assert.ok(
      view(await manager.snapshot('c1')).includes('assistant:still works')
    );
  }
);

test(
  'forking is refused while a turn is running, and blocks other prompts while it runs',
  { timeout: 90000 },
  async () => {
    await setup([
      { text: 'answer one' },
      { text: 'slow answer please', chunkDelayMs: 300 },
    ]);
    await turn('c1', 'question one');
    const entry = userEntry(await manager.snapshot('c1'), 'question one');
    const events = [];
    manager.subscribe('c1', (e) => events.push(e));
    const running = manager.forkAndPrompt('c1', entry, 'edited');
    await assert.rejects(manager.prompt('c1', 'sneaky'), /busy/i);
    await assert.rejects(manager.forkAndPrompt('c1', entry, 'again'), /busy/i);
    await running;
    await until(
      () => events.some((e) => e.type === 'settled') && !manager.isRunning('c1')
    );
    assert.ok(
      view(await manager.snapshot('c1')).includes(
        'assistant:slow answer please'
      )
    );
  }
);

test('a forked run can be aborted', { timeout: 90000 }, async () => {
  await setup([
    { text: 'answer one' },
    { text: 'a long answer that will be cut short', chunkDelayMs: 400 },
  ]);
  await turn('c1', 'question one');
  const entry = userEntry(await manager.snapshot('c1'), 'question one');
  const events = [];
  manager.subscribe('c1', (e) => events.push(e));
  await manager.forkAndPrompt('c1', entry, 'edited');
  await until(() => events.some((e) => e.type === 'text_delta'));
  await manager.abort('c1');
  await until(() => events.some((e) => e.type === 'settled'));
  assert.equal(events.find((e) => e.type === 'settled').aborted, true);
  await until(() => !manager.isRunning('c1'));
});

test(
  'compaction does not hide earlier history, and pre-compaction prompts can still be forked',
  { timeout: 90000 },
  async () => {
    await setup([
      { text: 'answer one' },
      { text: 'answer two' },
      { text: 'answer three' },
      { text: 'SUMMARY of the conversation' },
    ]);
    // Tiny retention so Pi will compact a small session.
    await writeFile(
      join(root, 'home', 'settings.json'),
      JSON.stringify({
        defaultProvider: 'fake',
        defaultModel: 'fake-1',
        compaction: { enabled: false, keepRecentTokens: 1 },
      })
    );
    await turn('c1', 'question one');
    await turn('c1', 'question two');
    await turn('c1', 'question three');
    const worker = await manager.launcher.start('c1');
    await worker.rpc.command('compact');
    const entries = await worker.rpc.command('get_entries');
    assert.ok(
      entries.entries.some((e) => e.type === 'compaction'),
      'a compaction entry was written'
    );

    const snap = await manager.snapshot('c1');
    assert.deepEqual(snap.messages.filter((m) => m.role === 'user').map(text), [
      'question one',
      'question two',
      'question three',
    ]);
    assert.ok(snap.messages.every((m) => m.entryId));

    // Compaction may use more than one model call; queue the fork's reply afterwards.
    model.queue.length = 0;
    model.queue.push({ text: 'answer after fork' });
    // The first prompt predates the compaction; it is still a valid fork point.
    await forkTurn('c1', userEntry(snap, 'question one'), 'start over');
    assert.deepEqual(view(await manager.snapshot('c1')), [
      'user:start over',
      'assistant:answer after fork',
    ]);
  }
);

test(
  'over the WebSocket: edit and regenerate are routed, and bad IDs return an error event',
  { timeout: 90000 },
  async () => {
    await setup([
      { text: 'answer one' },
      { text: 'edited answer' },
      { text: 'regenerated answer' },
    ]);
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
    const settledCount = () =>
      events.filter((e) => e.type === 'settled').length;
    const lastSnapshot = () =>
      events.filter((e) => e.type === 'snapshot').at(-1);

    send({ type: 'prompt', text: 'question one' });
    await until(() => settledCount() === 1);
    const entry = userEntry(lastSnapshot(), 'question one');

    send({ type: 'edit', entryId: 'nope', text: 'x' });
    await until(() => events.some((e) => e.type === 'error'));

    send({ type: 'edit', entryId: entry, text: 'edited question' });
    await until(() => settledCount() === 2);
    assert.deepEqual(view(lastSnapshot()), [
      'user:edited question',
      'assistant:edited answer',
    ]);

    send({
      type: 'regenerate',
      entryId: userEntry(lastSnapshot(), 'edited question'),
    });
    await until(() => settledCount() === 3);
    assert.deepEqual(view(lastSnapshot()), [
      'user:edited question',
      'assistant:regenerated answer',
    ]);
    ws.close();
  }
);
