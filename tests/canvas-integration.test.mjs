import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

let root, model, manager;
afterEach(async () => {
  await manager?.stopAll();
  await model?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = model = manager = undefined;
});

const until = async (check, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
};

async function setup(script) {
  root = await mkdtemp(join(tmpdir(), 'canvas-'));
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
    extensions: [
      'builtin:mcp',
      'builtin:codemode',
      resolve('extensions/canvas.mjs'),
    ],
  });
}
const watch = (id = 'c1') => {
  const events = [];
  manager.subscribe(id, (e) => events.push(e));
  return events;
};
const settled = (events) => events.some((e) => e.type === 'settled');
const canvasCall = (args) => ({
  toolCalls: [{ name: 'update_canvas', arguments: args }],
});

test(
  'the canvas tool result reaches the conversation that ran it, with no model-supplied target',
  { timeout: 90000 },
  async () => {
    await setup([
      canvasCall({
        html: '<h1 id="x">hi</h1>',
        css: 'h1{color:red}',
        js: 'document.title="t"',
        conversationId: 'someone-else',
      }),
      { text: 'done' },
    ]);
    const mine = watch('c1');
    const other = watch('c2');
    await manager.prompt('c1', 'draw');
    await until(() => settled(mine));
    const canvas = mine.find((e) => e.type === 'canvas');
    assert.deepEqual(canvas.canvas, {
      html: '<h1 id="x">hi</h1>',
      css: 'h1{color:red}',
      js: 'document.title="t"',
    });
    assert.equal(canvas.conversationId, 'c1');
    assert.equal(other.length, 0);
  }
);

test(
  'the canvas survives a reload because it is derived from Pi history',
  { timeout: 90000 },
  async () => {
    await setup([canvasCall({ html: '<p>kept</p>' }), { text: 'done' }]);
    const events = watch();
    await manager.prompt('c1', 'draw');
    await until(() => settled(events));
    const snapshot = await manager.snapshot('c1');
    assert.deepEqual(snapshot.canvas, { html: '<p>kept</p>', css: '', js: '' });
    // The post-turn snapshot carries it too, so a client that missed the live event converges.
    assert.deepEqual(
      events.findLast((e) => e.type === 'snapshot').canvas.html,
      '<p>kept</p>'
    );
  }
);

test(
  'a rejected canvas (oversized field) shows nothing',
  { timeout: 90000 },
  async () => {
    await setup([
      canvasCall({ html: 'x'.repeat(200_001) }),
      { text: 'could not' },
    ]);
    const events = watch();
    await manager.prompt('c1', 'draw');
    await until(() => settled(events));
    assert.equal(
      events.some((e) => e.type === 'canvas'),
      false
    );
    assert.equal((await manager.snapshot('c1')).canvas, null);
    assert.equal(events.find((e) => e.type === 'tool_end').isError, true);
  }
);

test(
  'editing the message that produced the canvas removes it from the active branch',
  { timeout: 120000 },
  async () => {
    await setup([
      canvasCall({ html: '<p>old</p>' }),
      { text: 'done' },
      { text: 'plain answer' },
    ]);
    const events = watch();
    await manager.prompt('c1', 'draw');
    await until(() => settled(events));
    const first = (await manager.snapshot('c1')).messages.find(
      (m) => m.role === 'user'
    );
    events.length = 0;
    await manager.forkAndPrompt('c1', first.entryId, 'just talk');
    await until(() => settled(events));
    assert.equal((await manager.snapshot('c1')).canvas, null);
  }
);
