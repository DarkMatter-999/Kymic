import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Scheduler } from '../server/scheduler/scheduler.ts';

const NY = 'America/New_York';
let dir, clock, exec;
const schedulers = [];
const iso = (ms) => new Date(ms).toISOString();

class FakeExecutor {
  prompts = [];
  running = new Set();
  listeners = new Map();
  isRunning(id) {
    return this.running.has(id);
  }
  subscribe(id, fn) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id).delete(fn);
  }
  async prompt(id, text) {
    this.prompts.push({ id, text });
    this.running.add(id);
  }
  finish(id) {
    this.running.delete(id);
    for (const fn of this.listeners.get(id) ?? [])
      fn({ v: 1, conversationId: id, type: 'settled', aborted: false });
  }
}
const make = (overrides = {}) => {
  const s = new Scheduler({
    dbPath: join(dir, 'sched.db'),
    executor: exec,
    now: () => clock,
    graceMs: 5000,
    ...overrides,
  });
  schedulers.push(s);
  return s;
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sched-cal-'));
  exec = new FakeExecutor();
  clock = Date.UTC(2026, 0, 15, 12); // 07:00 in New York
});
afterEach(async () => {
  schedulers.splice(0).forEach((s) => s.close());
  await rm(dir, { recursive: true, force: true });
});

const daily = (s, time = '09:00', tz = NY) =>
  s.create({
    conversationId: 'c1',
    prompt: 'go',
    kind: 'daily',
    timeOfDay: time,
    timezone: tz,
  });

test('a daily schedule is due at the local time, once a day', async () => {
  const s = make();
  const sched = daily(s);
  assert.equal(iso(sched.nextOccurrence), '2026-01-15T14:00:00.000Z');
  clock = sched.nextOccurrence;
  await s.tick();
  assert.equal(exec.prompts.length, 1);
  exec.finish('c1');
  await s.tick();
  assert.equal(exec.prompts.length, 1);
  assert.equal(iso(s.get(sched.id).nextOccurrence), '2026-01-16T14:00:00.000Z');
});

test('across spring forward the daily run follows local time (one run, correct instant)', async () => {
  const s = make();
  clock = Date.UTC(2026, 2, 7, 12);
  const sched = daily(s, '09:00');
  const fired = [];
  for (let day = 0; day < 3; day++) {
    clock = s.get(sched.id).nextOccurrence;
    await s.tick();
    fired.push(iso(clock));
    exec.finish('c1');
  }
  assert.deepEqual(fired, [
    '2026-03-07T14:00:00.000Z',
    '2026-03-08T13:00:00.000Z',
    '2026-03-09T13:00:00.000Z',
  ]);
  assert.equal(exec.prompts.length, 3);
});

test('a nonexistent 02:30 runs once on the spring-forward day', async () => {
  const s = make();
  clock = Date.UTC(2026, 2, 7, 5);
  const sched = daily(s, '02:30');
  clock = s.get(sched.id).nextOccurrence; // 2026-03-07 02:30 EST
  await s.tick();
  exec.finish('c1');
  clock = s.get(sched.id).nextOccurrence;
  assert.equal(iso(clock), '2026-03-08T07:30:00.000Z');
  await s.tick();
  exec.finish('c1');
  assert.equal(exec.prompts.length, 2);
  assert.equal(iso(s.get(sched.id).nextOccurrence), '2026-03-09T06:30:00.000Z');
});

test('a repeated 01:30 runs once on the fall-back day', async () => {
  const s = make();
  clock = Date.UTC(2026, 10, 1, 0);
  const sched = daily(s, '01:30');
  clock = s.get(sched.id).nextOccurrence;
  assert.equal(iso(clock), '2026-11-01T05:30:00.000Z');
  await s.tick();
  exec.finish('c1');
  clock += 3_600_000; // the second 01:30
  await s.tick();
  assert.equal(exec.prompts.length, 1);
  assert.equal(iso(s.get(sched.id).nextOccurrence), '2026-11-02T06:30:00.000Z');
});

test('a weekly schedule only fires on its weekdays', async () => {
  const s = make();
  clock = Date.UTC(2026, 0, 11, 12); // Sunday
  const sched = s.create({
    conversationId: 'c1',
    prompt: 'go',
    kind: 'weekly',
    weekdays: [1, 3],
    timeOfDay: '08:00',
    timezone: NY,
  });
  const days = [];
  for (let i = 0; i < 4; i++) {
    clock = s.get(sched.id).nextOccurrence;
    days.push(new Date(clock).getUTCDay());
    await s.tick();
    exec.finish('c1');
  }
  assert.deepEqual(days, [1, 3, 1, 3]);
});

test('after downtime a daily schedule skips missed days and does not burst', async () => {
  const s = make();
  const sched = daily(s, '09:00');
  clock = sched.nextOccurrence + 3 * 86_400_000 + 1000; // three days later, within grace of the newest
  await s.tick();
  assert.equal(exec.prompts.length, 1);
  const runs = s.runs(sched.id);
  assert.ok(
    runs.some((r) => r.status === 'skipped_missed' && /3 missed/.test(r.error))
  );
  assert.ok(s.get(sched.id).nextOccurrence > clock);
});

test('resuming a paused calendar schedule lands on the next future occurrence', () => {
  const s = make();
  const sched = daily(s, '09:00');
  s.setEnabled(sched.id, false);
  clock = sched.nextOccurrence + 5 * 86_400_000 + 3_600_000;
  s.setEnabled(sched.id, true);
  assert.equal(iso(s.get(sched.id).nextOccurrence), '2026-01-21T14:00:00.000Z');
});

test('a restart does not re-run a claimed occurrence and marks in-flight runs interrupted', async () => {
  let s = make();
  const sched = daily(s);
  clock = sched.nextOccurrence;
  await s.tick();
  assert.equal(exec.prompts.length, 1); // running when the process "dies"
  s.close();
  exec = new FakeExecutor();
  s = make();
  await s.tick();
  assert.equal(exec.prompts.length, 0);
  assert.equal(s.runs(sched.id)[0].status, 'interrupted');
  clock = s.get(sched.id).nextOccurrence;
  await s.tick();
  assert.equal(exec.prompts.length, 1); // next day runs normally
});

test('validates calendar input', () => {
  const s = make();
  const bad = (o) =>
    assert.throws(
      () =>
        s.create({ conversationId: 'c1', prompt: 'go', timezone: NY, ...o }),
      /Invalid schedule/
    );
  bad({ kind: 'daily' });
  bad({ kind: 'daily', timeOfDay: '25:00' });
  bad({ kind: 'weekly', timeOfDay: '09:00' });
  bad({ kind: 'weekly', timeOfDay: '09:00', weekdays: [7] });
  bad({ kind: 'weekly', timeOfDay: '09:00', weekdays: [] });
  bad({ kind: 'monthly', timeOfDay: '09:00' });
  bad({ kind: 'daily', timeOfDay: '09:00', timezone: 'Mars/Olympus' });
});

test('a database from before calendar recurrence is migrated in place and keeps working', async () => {
  const path = join(dir, 'old.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, prompt TEXT NOT NULL, timezone TEXT NOT NULL, every_ms INTEGER NOT NULL, enabled INTEGER NOT NULL, next_occurrence INTEGER NOT NULL);
    CREATE TABLE runs (occurrence_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, conversation_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT, result TEXT);`);
  db.prepare(
    "INSERT INTO schedules VALUES ('old1','c1','legacy',?,60000,1,?)"
  ).run('UTC', clock + 60_000);
  db.close();
  const s = make({ dbPath: path });
  const old = s.get('old1');
  assert.deepEqual(
    [old.kind, old.everyMs, old.timeOfDay, old.weekdays],
    ['interval', 60000, null, []]
  );
  clock += 60_000;
  await s.tick();
  assert.equal(exec.prompts[0].text, 'legacy');
});
