import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { Scheduler } from '../server/scheduler/scheduler.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

let root, model, manager, scheduler;
afterEach(async () => {
  scheduler?.close();
  await manager?.stopAll();
  await model?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = model = manager = scheduler = undefined;
});
const until = async (check, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

test(
  'a schedule runs a real Pi turn with no browser; the outcome and history are persisted',
  { timeout: 90000 },
  async () => {
    root = await mkdtemp(join(tmpdir(), 'sint-'));
    model = await startFakeModel([{ text: 'scheduled hello' }]);
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
    await writeFile(
      join(root, 'home', 'settings.json'),
      JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
    );
    manager = new ConversationManager({
      piCli: resolve(
        'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
      ),
      workspaceRoot: join(root, 'ws'),
      sessionRoot: join(root, 'sessions'),
      agentHome: join(root, 'home'),
      skills: [],
    });
    scheduler = new Scheduler({
      dbPath: join(root, 'sched.db'),
      executor: manager,
      minIntervalMs: 500,
      graceMs: 5000,
    });
    const schedule = scheduler.create({
      conversationId: 'sched-1',
      prompt: 'run the nightly task',
      everyMs: 1000,
      timezone: 'UTC',
    });
    scheduler.start(100);

    await until(() =>
      scheduler.runs(schedule.id).some((r) => r.status === 'completed')
    );
    scheduler.setEnabled(schedule.id, false); // one occurrence is enough
    const run = scheduler
      .runs(schedule.id)
      .find((r) => r.status === 'completed');
    assert.equal(run.result, 'scheduled hello');
    assert.equal(run.error, null);
    assert.ok(run.finishedAt >= run.startedAt);

    // "Reopen the browser": Pi's own history has the scheduled turn.
    const snapshot = await manager.snapshot('sched-1');
    assert.equal(snapshot.running, false);
    assert.ok(
      JSON.stringify(snapshot.messages).includes('run the nightly task')
    );
    assert.ok(JSON.stringify(snapshot.messages).includes('scheduled hello'));
  }
);
