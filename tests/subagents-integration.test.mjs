import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const until = async (check, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
};

// Unique per run so a process search cannot match anything but our own child.
const SLOW = `ROLE-SLOW-${process.pid}-${Date.now()}`;
const system = (req) =>
  String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const hasToolResult = (req) => req.messages.some((m) => m.role === 'tool');
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] });

/** Routes by role so parent and children can share one scripted model server. */
function router(parentCalls, extra = {}) {
  return (req) => {
    const sys = system(req);
    if (sys.includes('ROLE-A'))
      return {
        text: 'answer A with enough words to stream in pieces',
        chunkDelayMs: 60,
      };
    if (sys.includes('ROLE-B'))
      return hasToolResult(req)
        ? { text: 'answer B' }
        : call('bash', { command: 'echo child-tool' });
    if (sys.includes('ROLE-SLOW'))
      return { text: 'slow '.repeat(200), chunkDelayMs: 400 };
    if (extra.child?.(sys, req)) return extra.child(sys, req);
    return hasToolResult(req)
      ? { text: 'parent finished' }
      : { toolCalls: parentCalls };
  };
}

async function setup(parentCalls, extra) {
  root = await mkdtemp(join(tmpdir(), 'sub-'));
  model = await startFakeModel([], { fallback: router(parentCalls, extra) });
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
      resolve('extensions/subagents.mjs'),
    ],
  });
}
const watch = (id = 'c1') => {
  const events = [];
  manager.subscribe(id, (e) => events.push(e));
  return events;
};
const settled = (events) => events.some((e) => e.type === 'settled');
const subs = (events) =>
  events.filter((e) => e.type === 'subagent').map((e) => e.subagent);
const run = (task, systemPrompt) => ({
  name: 'run_subagent',
  arguments: { task, systemPrompt },
});

test(
  'parallel subagents report real lifecycle events with distinct stable IDs',
  { timeout: 120000 },
  async () => {
    await setup([run('task A', 'ROLE-A'), run('task B', 'ROLE-B')]);
    const events = watch();
    await manager.prompt('c1', 'go');
    await until(() => settled(events));

    const all = subs(events);
    const ids = [...new Set(all.map((s) => s.id))];
    assert.equal(ids.length, 2);
    const byId = (id) => all.filter((s) => s.id === id);
    const a = byId(ids.find((id) => byId(id)[0].task === 'task A'));
    const b = byId(ids.find((id) => byId(id)[0].task === 'task B'));

    assert.equal(a.at(-1).state, 'finished');
    assert.equal(
      a.at(-1).result,
      'answer A with enough words to stream in pieces'
    );
    assert.ok(
      a.some((s) => s.state === 'running' && s.text),
      'streamed text updates'
    );
    assert.equal(b.at(-1).state, 'finished');
    assert.equal(b.at(-1).result, 'answer B');
    assert.ok(
      b.some((s) => s.state === 'tool_call'),
      'tool call state seen'
    );

    // Lifecycle is monotonic: nothing follows a terminal state.
    for (const list of [a, b]) {
      const firstTerminal = list.findIndex((s) =>
        ['finished', 'error', 'cancelled'].includes(s.state)
      );
      assert.equal(firstTerminal, list.length - 1);
    }
    // The ordinary tool cards still exist for the transcript.
    assert.equal(
      events.filter(
        (e) => e.type === 'tool_end' && e.toolName === 'run_subagent'
      ).length,
      2
    );
  }
);

test(
  'finished subagents come back from history after a reload, with the same IDs',
  { timeout: 120000 },
  async () => {
    await setup([run('task A', 'ROLE-A')]);
    const events = watch();
    await manager.prompt('c1', 'go');
    await until(() => settled(events));
    const liveId = subs(events)[0].id;
    const snapshot = await manager.snapshot('c1');
    assert.deepEqual(
      snapshot.subagents.map((s) => [s.id, s.state, s.result]),
      [[liveId, 'finished', 'answer A with enough words to stream in pieces']]
    );
    // A fresh manager (gateway restart) rebuilds the same list from Pi's session alone.
    await manager.stopAll();
    const restarted = new ConversationManager({ ...manager.launcher.config });
    const again = await restarted.snapshot('c1');
    await restarted.stopAll();
    assert.deepEqual(
      again.subagents.map((s) => [s.id, s.state]),
      [[liveId, 'finished']]
    );
  }
);

test(
  'aborting the turn cancels running subagents and kills their processes',
  { timeout: 120000 },
  async () => {
    await setup([run('slow task', SLOW)]);
    const events = watch();
    await manager.prompt('c1', 'go');
    await until(() =>
      subs(events).some((s) => s.state === 'running' && s.text)
    );
    const workerPid = manager.launcher.peek('c1').child.pid;
    assert.ok(childCount(workerPid) >= 1);
    await manager.abort('c1');
    await until(() => settled(events));
    assert.equal(subs(events).at(-1).state, 'cancelled');
    await until(() => childCount(workerPid) === 0, 15000);
  }
);

test(
  'a failing subagent call is reported as an error, not left running',
  { timeout: 120000 },
  async () => {
    await setup([run('x'.repeat(20_001), 'ROLE-A')]);
    const events = watch();
    await manager.prompt('c1', 'go');
    await until(() => settled(events));
    const last = subs(events).at(-1);
    assert.equal(last.state, 'error');
    assert.ok(
      (await manager.snapshot('c1')).subagents.every((s) => s.state === 'error')
    );
  }
);

test(
  'an ordinary tool call is never presented as a subagent',
  { timeout: 120000 },
  async () => {
    await setup([{ name: 'bash', arguments: { command: 'echo hi' } }]);
    const events = watch();
    await manager.prompt('c1', 'go');
    await until(() => settled(events));
    assert.equal(subs(events).length, 0);
    assert.deepEqual((await manager.snapshot('c1')).subagents, []);
  }
);

test(
  'children cannot start their own subagents (no extension in the child)',
  { timeout: 120000 },
  async () => {
    await setup([run('task A', 'ROLE-A')]);
    const events = watch();
    await manager.prompt('c1', 'go');
    await until(() => settled(events));
    const childRequest = model.requests.find((r) =>
      system(r).includes('ROLE-A')
    );
    const toolNames = (childRequest.tools ?? []).map((t) => t.function?.name);
    assert.ok(!toolNames.includes('run_subagent'));
    assert.ok(toolNames.includes('codemode'));
  }
);

/** Direct children of the worker process: the subagent processes (no MCP servers are configured). */
function childCount(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}
