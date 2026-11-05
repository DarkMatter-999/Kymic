import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../server/scheduler/scheduler.ts';

let dir;
let clock;
let exec;
const schedulers = [];

class FakeExecutor {
  constructor() {
    this.prompts = [];
    this.running = new Set();
    this.listeners = new Map();
    this.failNext = null;
  }
  isRunning(id) {
    return this.running.has(id);
  }
  subscribe(id, fn) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id).delete(fn);
  }
  async prompt(id, text) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.prompts.push({ id, text });
    this.running.add(id);
  }
  emit(id, event) {
    for (const fn of this.listeners.get(id) ?? [])
      fn({ v: 1, conversationId: id, ...event });
  }
  finish(id, text = 'ok', aborted = false) {
    this.emit(id, {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    this.running.delete(id);
    this.emit(id, { type: 'settled', aborted });
  }
}

const make = (overrides = {}) => {
  const s = new Scheduler({
    dbPath: join(dir, 'sched.db'),
    executor: exec,
    now: () => clock,
    minIntervalMs: 1000,
    graceMs: 5000,
    ...overrides,
  });
  schedulers.push(s);
  return s;
};
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sched-'));
  clock = T0;
  exec = new FakeExecutor();
});
afterEach(async () => {
  schedulers.splice(0).forEach((s) => s.close());
  await rm(dir, { recursive: true, force: true });
});

test('a due schedule launches with no client connected and records the outcome', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'daily report',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  assert.equal(sch.nextOccurrence, T0 + 60_000);
  await s.tick();
  assert.equal(exec.prompts.length, 0);
  clock = T0 + 60_000;
  await s.tick();
  assert.deepEqual(exec.prompts, [{ id: 'c1', text: 'daily report' }]);
  assert.equal(s.runs(sch.id)[0].status, 'running');
  exec.finish('c1', 'report done');
  const [run] = s.runs(sch.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 'report done');
  assert.equal(s.get(sch.id).nextOccurrence, T0 + 120_000);
});

test('an occurrence is launched at most once, even across two scheduler instances', async () => {
  const a = make();
  const b = make();
  const sch = a.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  clock = T0 + 60_000;
  await Promise.all([a.tick(), b.tick(), a.tick()]);
  assert.equal(exec.prompts.length, 1);
  assert.equal(a.runs(sch.id).length, 1);
});

test('overlap: a due occurrence is skipped (and recorded) while the conversation is busy', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  clock = T0 + 60_000;
  await s.tick();
  clock = T0 + 120_000;
  await s.tick(); // first run still going
  assert.equal(exec.prompts.length, 1);
  const statuses = s
    .runs(sch.id)
    .map((r) => r.status)
    .sort();
  assert.deepEqual(statuses, ['running', 'skipped_overlap']);
  assert.equal(s.get(sch.id).nextOccurrence, T0 + 180_000);
});

test('a conversation busy with a user turn also blocks the launch', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  exec.running.add('c1');
  clock = T0 + 60_000;
  await s.tick();
  assert.equal(exec.prompts.length, 0);
  assert.equal(s.runs(sch.id)[0].status, 'skipped_overlap');
});

test('restart after a missed occurrence skips it instead of running late', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  s.close();
  clock = T0 + 10 * 60_000 + 30_000; // gateway was down for 10+ intervals
  const restarted = make();
  await restarted.tick();
  assert.equal(exec.prompts.length, 0);
  const runs = restarted.runs(sch.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'skipped_missed');
  assert.match(runs[0].error, /10 missed/);
  assert.equal(restarted.get(sch.id).nextOccurrence, T0 + 11 * 60_000);
});

test('restart within the grace window runs only the latest occurrence', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  s.close();
  clock = T0 + 3 * 60_000 + 2000; // latest due 2s ago, two earlier ones missed
  const restarted = make();
  await restarted.tick();
  assert.equal(exec.prompts.length, 1);
  const statuses = restarted
    .runs(sch.id)
    .map((r) => r.status)
    .sort();
  assert.deepEqual(statuses, ['running', 'skipped_missed']);
});

test('a crash during a run marks it interrupted on restart and never re-runs it', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  clock = T0 + 60_000;
  await s.tick();
  assert.equal(exec.prompts.length, 1);
  s.close(); // simulated crash: status is still 'running' in the database
  exec.running.clear();
  const restarted = make();
  assert.equal(restarted.runs(sch.id)[0].status, 'interrupted');
  clock = T0 + 60_000 + 1000;
  await restarted.tick();
  assert.equal(exec.prompts.length, 1);
});

test('executor failures, worker errors and aborts are recorded distinctly', async () => {
  const s = make();
  const a = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  exec.failNext = new Error('boom');
  clock = T0 + 60_000;
  await s.tick();
  assert.equal(s.runs(a.id)[0].status, 'failed');
  assert.match(s.runs(a.id)[0].error, /boom/);

  clock = T0 + 120_000;
  await s.tick();
  exec.emit('c1', { type: 'error', message: 'worker died' });
  exec.running.delete('c1');
  exec.emit('c1', { type: 'status', running: false });
  assert.equal(s.runs(a.id)[0].status, 'failed');
  assert.match(s.runs(a.id)[0].error, /worker died/);

  clock = T0 + 180_000;
  await s.tick();
  exec.finish('c1', 'partial', true);
  assert.equal(s.runs(a.id)[0].status, 'cancelled');
});

test('disabled schedules never launch and enabling resumes from the next future occurrence', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  s.setEnabled(sch.id, false);
  clock = T0 + 5 * 60_000;
  await s.tick();
  assert.equal(exec.prompts.length, 0);
  assert.equal(s.runs(sch.id).length, 0);
  s.setEnabled(sch.id, true);
  assert.equal(s.get(sch.id).nextOccurrence, T0 + 6 * 60_000);
});

test('validation and limits', () => {
  const s = make({ maxSchedules: 2, maxPromptLength: 20 });
  const ok = {
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  };
  assert.throws(() => s.create({ ...ok, conversationId: '../x' }), /Invalid/);
  assert.throws(() => s.create({ ...ok, prompt: '' }), /Invalid/);
  assert.throws(() => s.create({ ...ok, prompt: 'x'.repeat(21) }), /Invalid/);
  assert.throws(() => s.create({ ...ok, everyMs: 10 }), /Invalid/);
  assert.throws(() => s.create({ ...ok, timezone: 'Not/AZone' }), /Invalid/);
  s.create(ok);
  s.create(ok);
  assert.throws(() => s.create(ok), /Too many/);
});

test('delete removes the schedule and its history', async () => {
  const s = make();
  const sch = s.create({
    conversationId: 'c1',
    prompt: 'p',
    everyMs: 60_000,
    timezone: 'UTC',
  });
  clock = T0 + 60_000;
  await s.tick();
  s.delete(sch.id);
  assert.equal(s.get(sch.id), undefined);
  assert.deepEqual(s.runs(sch.id), []);
});
