import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { DEFAULT_PROFILES } from '../server/workers/profiles.ts';
import { parseClientCommand } from '../server/gateway/protocol.ts';
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
const MARKER_CODE =
  'const r = await tools.mcp__spike__spike_marker({});\nreturn r.content[0].text;';

const profiles = {
  ...DEFAULT_PROFILES,
  // codemode present, MCP absent: the tool exists but must not reach MCP servers.
  nomcp: {
    label: 'No MCP',
    description: 'test',
    extensions: ['builtin:codemode'],
    tools: '+codemode',
  },
};

async function setup(script) {
  root = await mkdtemp(join(tmpdir(), 'prof-'));
  model = await startFakeModel(script, { fallback: () => ({ text: 'ok' }) });
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
  await writeFile(
    join(root, 'home', 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
  );
  await writeFile(
    join(root, 'home', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        spike: {
          command: process.execPath,
          args: [resolve('tests/fixtures/mcp/spike-server.mjs')],
        },
      },
    })
  );
  manager = makeManager();
}
const makeManager = () =>
  new ConversationManager({
    piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    workspaceRoot: join(root, 'ws'),
    sessionRoot: join(root, 'sessions'),
    agentHome: join(root, 'home'),
    skills: [],
    profiles,
    defaultProfile: 'full',
  });
const watch = (id) => {
  const events = [];
  manager.subscribe(id, (e) => events.push(e));
  return events;
};
const settled = (events) => events.some((e) => e.type === 'settled');
const toolNames = (request) =>
  (request.tools ?? []).map((t) => t.function?.name).sort();
const runTurn = async (id, text, profile) => {
  const events = watch(id);
  await manager.prompt(id, text, profile);
  await until(() => settled(events));
  return events;
};
const resultText = (events) =>
  JSON.stringify(events.find((e) => e.type === 'tool_end')?.result ?? null);

test(
  'each profile offers exactly its own tools',
  { timeout: 120000 },
  async () => {
    await setup([]);
    await runTurn('full', 'hi', 'full');
    await runTurn('work', 'hi', 'workspace');
    await runTurn('chat', 'hi', 'chat');
    const [full, work, chat] = model.requests.map(toolNames);
    for (const name of ['bash', 'codemode', 'run_subagent', 'update_canvas'])
      assert.ok(full.includes(name), `full has ${name}`);
    assert.ok(work.includes('bash') && work.includes('update_canvas'));
    for (const name of ['codemode', 'run_subagent'])
      assert.ok(!work.includes(name), `workspace lacks ${name}`);
    assert.deepEqual(chat, ['update_canvas']);
  }
);

test(
  'codemode and MCP are controlled separately',
  { timeout: 180000 },
  async () => {
    await setup([
      // full: codemode reaches the MCP server
      { toolCalls: [{ name: 'codemode', arguments: { code: MARKER_CODE } }] },
      { text: 'done' },
      // nomcp: codemode exists, but the MCP tool must be unreachable from it
      { toolCalls: [{ name: 'codemode', arguments: { code: MARKER_CODE } }] },
      { text: 'done' },
      // workspace: there is no codemode tool to call at all
      { toolCalls: [{ name: 'codemode', arguments: { code: MARKER_CODE } }] },
      { text: 'done' },
    ]);
    const full = await runTurn('a', 'go', 'full');
    assert.match(resultText(full), /PI_SPIKE_MCP_MARKER/);

    const nomcp = await runTurn('b', 'go', 'nomcp');
    assert.ok(toolNames(model.requests[2]).includes('codemode'));
    assert.match(
      resultText(nomcp),
      /tools\.mcp__spike__spike_marker does not exist/
    );
    assert.doesNotMatch(resultText(nomcp), /PI_SPIKE_MCP_MARKER/);

    const work = await runTurn('c', 'go', 'workspace');
    assert.match(resultText(work), /Tool codemode not found/);
    assert.doesNotMatch(resultText(work), /PI_SPIKE_MCP_MARKER/);
    assert.equal(work.find((e) => e.type === 'tool_end').isError, true);
  }
);

test(
  'the first prompt records the profile; it cannot change afterwards, even across a restart',
  { timeout: 150000 },
  async () => {
    await setup([]);
    await runTurn('c1', 'hi', 'chat');
    assert.equal((await manager.snapshot('c1')).profile, 'chat');
    await assert.rejects(
      manager.prompt('c1', 'again', 'full'),
      /already uses the "chat" profile/
    );
    // Omitting it keeps the recorded one.
    await runTurn('c1', 'again');
    assert.deepEqual(toolNames(model.requests.at(-1)), ['update_canvas']);

    await manager.stopAll();
    manager = makeManager();
    await runTurn('c1', 'after restart');
    assert.deepEqual(toolNames(model.requests.at(-1)), ['update_canvas']);
    assert.equal((await manager.snapshot('c1')).profile, 'chat');
  }
);

test(
  'a conversation that has not run yet can still choose, even after it was opened',
  { timeout: 120000 },
  async () => {
    await setup([]);
    // Opening it (a snapshot) starts an idle worker on the default profile and records nothing.
    const opened = await manager.snapshot('c1');
    assert.equal(opened.profile, null);
    await runTurn('c1', 'hi', 'workspace');
    const names = toolNames(model.requests.at(-1));
    assert.ok(names.includes('bash') && !names.includes('codemode'));
    assert.equal((await manager.snapshot('c1')).profile, 'workspace');
  }
);

test('an unconfigured profile is rejected and names are validated', async () => {
  await setup([]);
  await assert.rejects(manager.prompt('c1', 'hi', 'nope'), /Unknown profile/);
  assert.equal(await manager.launcher.profileOf('c1'), null);
  for (const bad of ['../x', 'A', '', 5, 'a'.repeat(33)])
    assert.throws(
      () =>
        parseClientCommand({
          v: 1,
          type: 'prompt',
          conversationId: 'c',
          text: 'x',
          profile: bad,
        }),
      /Invalid/
    );
  const ok = parseClientCommand({
    v: 1,
    type: 'prompt',
    conversationId: 'c',
    text: 'x',
    profile: 'chat',
  });
  assert.equal(ok.profile, 'chat');
});

test('the browser can list profiles but never sees paths or arguments', async () => {
  await setup([]);
  const list = manager.launcher.listProfiles();
  assert.deepEqual(list.map((p) => p.name).sort(), [
    'chat',
    'full',
    'nomcp',
    'workspace',
  ]);
  assert.ok(!JSON.stringify(list).includes('extensions'));
});
