import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

let root; let model; let manager;
const realCli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');

async function setup(script) {
  root = await mkdtemp(join(tmpdir(), 'conv-'));
  model = await startFakeModel(script);
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
  await writeFile(join(root, 'home', 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' }));
  manager = new ConversationManager({
    piCli: realCli, workspaceRoot: join(root, 'ws'), sessionRoot: join(root, 'sessions'),
    agentHome: join(root, 'home'), skills: [],
  });
  return manager;
}
afterEach(async () => { await manager?.stopAll(); await model?.close(); if (root) await rm(root, { recursive: true, force: true }); manager = model = root = undefined; });

const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
};
const record = (m, id) => { const events = []; const off = m.subscribe(id, (e) => events.push(e)); return { events, off }; };

test('streams a turn: status, deltas, final message, settled', { timeout: 60000 }, async () => {
  await setup([{ text: 'hello from the fake model' }]);
  const { events } = record(manager, 'c1');
  await manager.prompt('c1', 'say hello');
  await until(() => events.some((e) => e.type === 'settled'));
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'status');
  assert.deepEqual([events[0].running], [true]);
  assert.ok(types.includes('text_delta'));
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), 'hello from the fake model');
  const finals = events.filter((e) => e.type === 'message' && e.message.role === 'assistant');
  assert.equal(finals.length, 1);
  assert.equal(events.at(-1).type, 'status');
  assert.equal(events.at(-1).running, false);
  assert.equal(manager.isRunning('c1'), false);
});

test('rejects a second prompt while a turn is active, then allows one after settle', { timeout: 60000 }, async () => {
  await setup([{ text: 'slow answer here', chunkDelayMs: 300 }, { text: 'second' }]);
  const { events } = record(manager, 'c1');
  await manager.prompt('c1', 'first');
  assert.equal(manager.isRunning('c1'), true);
  await assert.rejects(manager.prompt('c1', 'again'), /busy/i);
  await until(() => events.some((e) => e.type === 'settled'));
  await manager.prompt('c1', 'third');
  await until(() => events.filter((e) => e.type === 'settled').length === 2);
});

test('different conversations run concurrently and only get their own events', { timeout: 60000 }, async () => {
  await setup([{ text: 'one', chunkDelayMs: 200 }, { text: 'two', chunkDelayMs: 200 }]);
  const a = record(manager, 'ca'); const b = record(manager, 'cb');
  await Promise.all([manager.prompt('ca', 'x'), manager.prompt('cb', 'y')]);
  await until(() => [a, b].every((r) => r.events.some((e) => e.type === 'settled')));
  assert.ok(a.events.every((e) => e.conversationId === 'ca'));
  assert.ok(b.events.every((e) => e.conversationId === 'cb'));
});

test('emits tool events for a tool call', { timeout: 60000 }, async () => {
  await setup([{ toolCalls: [{ name: 'bash', arguments: { command: 'echo tool-marker' } }] }, { text: 'done' }]);
  const { events } = record(manager, 'c1');
  await manager.prompt('c1', 'run it');
  await until(() => events.some((e) => e.type === 'settled'));
  const start = events.find((e) => e.type === 'tool_start');
  const end = events.find((e) => e.type === 'tool_end');
  assert.equal(start.toolName, 'bash');
  assert.equal(end.toolCallId, start.toolCallId);
  assert.ok(JSON.stringify(end.result).includes('tool-marker'));
  assert.equal(end.isError, false);
});

test('worker continues after the browser disconnects; reconnect gets authoritative history', { timeout: 60000 }, async () => {
  await setup([{ text: 'finished while nobody watched', chunkDelayMs: 150 }]);
  const { off } = record(manager, 'c1');
  await manager.prompt('c1', 'long task');
  off(); // browser closes mid-run
  await until(() => !manager.isRunning('c1'));
  const snap = await manager.snapshot('c1');
  assert.equal(snap.running, false);
  assert.ok(JSON.stringify(snap.messages).includes('finished while nobody watched'));
  assert.ok(snap.messages.some((m) => m.role === 'user'));
});

test('snapshot of a running conversation reports running', { timeout: 60000 }, async () => {
  await setup([{ text: 'slow answer here', chunkDelayMs: 400 }]);
  await manager.prompt('c1', 'go');
  const snap = await manager.snapshot('c1');
  assert.equal(snap.running, true);
  await until(() => !manager.isRunning('c1'));
});

test('abort ends the turn as aborted', { timeout: 60000 }, async () => {
  await setup([{ text: 'a very long answer that never ends quickly', chunkDelayMs: 500 }]);
  const { events } = record(manager, 'c1');
  await manager.prompt('c1', 'go');
  await until(() => events.some((e) => e.type === 'text_delta'));
  await manager.abort('c1');
  await until(() => events.some((e) => e.type === 'settled'));
  assert.equal(events.find((e) => e.type === 'settled').aborted, true);
  assert.equal(manager.isRunning('c1'), false);
});

test('invalid conversation IDs are rejected', async () => {
  await setup([]);
  await assert.rejects(manager.prompt('../x', 'hi'), /Invalid conversation ID/);
});

test('a worker that dies mid-turn surfaces an error and clears running state', { timeout: 60000 }, async () => {
  await setup([{ text: 'slow answer here', chunkDelayMs: 500 }]);
  const { events } = record(manager, 'c1');
  await manager.prompt('c1', 'go');
  await until(() => events.some((e) => e.type === 'text_delta'));
  const worker = await manager.launcher.start('c1');
  worker.child.kill('SIGKILL');
  await until(() => !manager.isRunning('c1'));
  assert.ok(events.some((e) => e.type === 'error'));
  assert.equal(events.at(-1).type, 'status');
});
