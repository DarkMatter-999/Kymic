import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkerLauncher } from '../server/workers/launcher.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

let root; let launcher;
const fake = resolve('tests/fixtures/fake-pi.mjs');
const realCli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'launcher-')); });
afterEach(async () => { await launcher?.stopAll(); await rm(root, { recursive: true, force: true }); });

function make(overrides = {}) {
  launcher = new WorkerLauncher({
    piCli: fake, workspaceRoot: join(root, 'ws'), sessionRoot: join(root, 'sessions'),
    agentHome: join(root, 'home'), skills: [resolve('skills/spike/SKILL.md')], ...overrides,
  });
  return launcher;
}

test('rejects invalid conversation IDs before spawning', async () => {
  make();
  await assert.rejects(launcher.start('../etc'), /Invalid conversation ID/);
});

test('uses distinct workspaces and a scrubbed fixed environment', async () => {
  process.env.GATEWAY_SECRET = 'must-not-leak';
  make();
  const sentinel = join(root, 'gateway-private.txt');
  await writeFile(sentinel, 'secret');
  const sentinelHandle = await open(sentinel, 'r');
  const a = await launcher.start('conv-a');
  const b = await launcher.start('conv-b');
  const sa = await a.rpc.command('probe');
  const sb = await b.rpc.command('probe');
  assert.notEqual(sa.cwd, sb.cwd);
  assert.equal(sa.cwd, join(root, 'ws', 'conv-a'));
  assert.equal(sa.env.GATEWAY_SECRET, undefined);
  assert.deepEqual(Object.keys(sa.env).sort(), ['HOME', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_TELEMETRY']);
  assert.ok(sa.argv.includes('--mode') && sa.argv.includes('rpc'));
  assert.ok(!sa.fdTargets.some((t) => t.includes(sentinel)), `gateway file leaked to worker: ${sa.fdTargets}`);
  await sentinelHandle.close();
  delete process.env.GATEWAY_SECRET;
});

test('start is idempotent per conversation and stop terminates the process', async () => {
  make();
  const a = await launcher.start('conv-a');
  assert.equal(await launcher.start('conv-a'), a);
  const { pid } = await a.rpc.command('probe');
  await launcher.stop('conv-a');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(a.rpc.command('probe'), /closed/i);
  const again = await launcher.start('conv-a');
  assert.notEqual(again, a);
});

test('workspace data persists across worker restarts', async () => {
  make();
  const a = await launcher.start('conv-a');
  await writeFile(join(a.workspace, 'note.txt'), 'kept');
  await launcher.stop('conv-a');
  const b = await launcher.start('conv-a');
  assert.deepEqual(await readdir(b.workspace), ['note.txt']);
});

test('real Pi resumes the same session after restart, with history', { timeout: 60000 }, async () => {
  const model = await startFakeModel([{ text: 'hello from the fake model' }]);
  try {
    make({ piCli: realCli });
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
    const first = await launcher.start('conv-real');
    await first.rpc.command('set_model', { provider: 'fake', modelId: 'fake-1' });
    const s1 = await first.rpc.command('get_state');
    assert.ok(s1.sessionFile.startsWith(join(root, 'sessions', 'conv-real')), s1.sessionFile);
    await first.rpc.command('prompt', { message: 'say hello' });
    await waitFor(async () => !(await first.rpc.command('get_state')).isStreaming
      && (await first.rpc.command('get_state')).messageCount >= 2);
    await launcher.stop('conv-real');
    const second = await launcher.start('conv-real');
    const s2 = await second.rpc.command('get_state');
    assert.equal(s2.sessionId, s1.sessionId);
    const { messages } = await second.rpc.command('get_messages');
    assert.ok(JSON.stringify(messages).includes('hello from the fake model'));
  } finally { await model.close(); }
});

async function waitFor(check, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timed out');
}

test('drops to the configured agent uid/gid (root only)', { skip: process.getuid() !== 0 }, async () => {
  make({ uid: 12345, gid: 12345 });
  const w = await launcher.start('conv-a');
  const p = await w.rpc.command('probe');
  assert.equal(p.uid, 12345);
  assert.equal(p.gid, 12345);
});
