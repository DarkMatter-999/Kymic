import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
};
const available = [
  { provider: 'fake', id: 'fake-1' },
  { provider: 'fake', id: 'fake-2' },
];

async function setup({ defaultModel } = {}) {
  root = await mkdtemp(join(tmpdir(), 'msw-'));
  model = await startFakeModel([], {
    fallback: () => ({ text: 'ok', chunkDelayMs: 0 }),
  });
  const models = JSON.parse(model.modelsJson());
  const first = models.providers.fake.models[0];
  models.providers.fake.models = [
    first,
    { ...first, id: 'fake-2', name: 'fake two' },
  ];
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'models.json'), JSON.stringify(models));
  await writeFile(
    join(root, 'home', 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
  );
  manager = makeManager({ defaultModel });
}
const makeManager = ({ defaultModel } = {}) =>
  new ConversationManager({
    piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    workspaceRoot: join(root, 'ws'),
    sessionRoot: join(root, 'sessions'),
    metaRoot: join(root, 'meta'),
    agentHome: join(root, 'home'),
    skills: [],
    defaultModel: () => defaultModel,
    validateModel: async (ref) => {
      const hit = available.find(
        (m) => m.provider === ref?.provider && m.id === ref?.id
      );
      if (!hit) throw new Error('That model is not available.');
      return hit;
    },
  });
const watch = (id) => {
  const events = [];
  manager.subscribe(id, (e) => events.push(e));
  return events;
};
const turn = async (id, text) => {
  const events = watch(id);
  await manager.prompt(id, text);
  await until(() => events.some((e) => e.type === 'settled'));
  return events;
};
const lastRequestModel = () => model.requests.at(-1).model;

test(
  'a conversation can switch models; history and session carry over',
  { timeout: 120000 },
  async () => {
    await setup();
    await turn('c1', 'first');
    assert.equal(lastRequestModel(), 'fake-1');
    assert.deepEqual((await manager.snapshot('c1')).model, {
      provider: 'fake',
      id: 'fake-1',
    });

    await manager.setModel('c1', { provider: 'fake', id: 'fake-2' });
    const snapshot = await manager.snapshot('c1');
    assert.deepEqual(snapshot.model, { provider: 'fake', id: 'fake-2' });
    assert.ok(
      snapshot.messages.length >= 2,
      'earlier messages are still there'
    );

    await turn('c1', 'second');
    assert.equal(lastRequestModel(), 'fake-2');
    const sent = model.requests
      .at(-1)
      .messages.map((m) => JSON.stringify(m.content))
      .join(' ');
    assert.match(sent, /first/); // the new model saw the earlier turn: same session
  }
);

test('the choice survives a gateway restart', { timeout: 120000 }, async () => {
  await setup();
  await manager.setModel('c1', { provider: 'fake', id: 'fake-2' });
  await manager.stopAll();
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'meta', 'c1', 'model.json'), 'utf8')),
    { provider: 'fake', id: 'fake-2' }
  );
  manager = makeManager();
  await turn('c1', 'after restart');
  assert.equal(lastRequestModel(), 'fake-2');
});

test(
  'new conversations use the default model; a conversation choice overrides it',
  { timeout: 120000 },
  async () => {
    await setup({ defaultModel: { provider: 'fake', id: 'fake-2' } });
    await turn('a', 'hi');
    assert.equal(lastRequestModel(), 'fake-2');
    await manager.setModel('a', { provider: 'fake', id: 'fake-1' });
    await turn('a', 'again');
    assert.equal(lastRequestModel(), 'fake-1');
  }
);

test(
  'unavailable models and mid-reply changes are refused',
  { timeout: 120000 },
  async () => {
    await setup();
    await assert.rejects(
      manager.setModel('c1', { provider: 'fake', id: 'nope' }),
      /not available/
    );
    await assert.rejects(
      manager.setModel('c1', { provider: 'x', id: '--evil' }),
      /not available/
    );
    await assert.rejects(readFile(join(root, 'meta', 'c1', 'model.json')), {
      code: 'ENOENT',
    }); // nothing stored

    model.queue.push({ text: 'slow reply '.repeat(30), chunkDelayMs: 150 });
    const events = watch('c1');
    await manager.prompt('c1', 'go');
    await until(() => events.some((e) => e.type === 'text_delta'));
    await assert.rejects(
      manager.setModel('c1', { provider: 'fake', id: 'fake-2' }),
      /Wait for the current reply/
    );
    await manager.abort('c1');
    await until(() => events.some((e) => e.type === 'settled'));
  }
);

test(
  'workers started before a sign-in restart so they pick up new credentials',
  { timeout: 120000 },
  async () => {
    await setup();
    await manager.snapshot('c1'); // opening the page starts an idle worker
    const before = manager.launcher.peek('c1').child.pid;
    await manager.credentialsChanged();
    assert.equal(
      manager.launcher.peek('c1'),
      undefined,
      'the stale worker is gone'
    );
    await manager.snapshot('c1'); // the next use starts a fresh one
    const after = manager.launcher.peek('c1').child.pid;
    assert.notEqual(after, before);
  }
);

test(
  'a worker that is mid-reply restarts after the reply, not during it',
  { timeout: 120000 },
  async () => {
    await setup();
    model.queue.push({ text: 'steady reply '.repeat(20), chunkDelayMs: 100 });
    const events = watch('c1');
    await manager.prompt('c1', 'go');
    await until(() => events.some((e) => e.type === 'text_delta'));
    const during = manager.launcher.peek('c1').child.pid;
    await manager.credentialsChanged();
    assert.equal(
      manager.launcher.peek('c1')?.child.pid,
      during,
      'not interrupted'
    );
    await until(() => events.some((e) => e.type === 'settled'));
    await until(() => manager.launcher.peek('c1') === undefined);
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    assert.match(text, /steady reply/); // the reply finished intact
  }
);
