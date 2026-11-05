import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../server/scheduler/scheduler.ts';
import { createScheduleRouter } from '../server/scheduler/http.ts';

const ORIGIN = 'https://agents.example.test';
let dir, scheduler, server, base, authed;
const executor = {
  isRunning: () => false,
  prompt: async () => {},
  subscribe: () => () => {},
};

async function start() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/schedules',
    createScheduleRouter({
      scheduler,
      allowedOrigins: [ORIGIN],
      authenticate: () => authed,
    })
  );
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}/api/schedules`;
}
beforeEach(async () => {
  authed = true;
  dir = await mkdtemp(join(tmpdir(), 'sh-'));
  scheduler = new Scheduler({
    dbPath: join(dir, 's.db'),
    executor,
    minIntervalMs: 1000,
  });
  await start();
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  scheduler.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (
  path,
  { method = 'GET', body, origin = ORIGIN, type = 'application/json' } = {}
) =>
  fetch(base + path, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(body ? { 'content-type': type } : {}),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
const valid = {
  conversationId: 'c1',
  prompt: 'nightly summary',
  everyMs: 60_000,
  timezone: 'UTC',
};

test('unauthenticated requests are rejected before touching anything', async () => {
  authed = false;
  assert.equal((await call('')).status, 401);
  assert.equal((await call('', { method: 'POST', body: valid })).status, 401);
  assert.equal(scheduler.list().length, 0);
});

test('state-changing requests require an allowed Origin and a JSON content type', async () => {
  assert.equal(
    (
      await call('', {
        method: 'POST',
        body: valid,
        origin: 'https://evil.example',
      })
    ).status,
    403
  );
  assert.equal(
    (await call('', { method: 'POST', body: valid, origin: null })).status,
    403
  );
  assert.equal(
    (
      await call('', {
        method: 'POST',
        body: JSON.stringify(valid),
        type: 'text/plain',
      })
    ).status,
    415
  );
  assert.equal(scheduler.list().length, 0);
});

test('create, list, disable, enable, inspect runs, delete', async () => {
  const created = await call('', { method: 'POST', body: valid });
  assert.equal(created.status, 201);
  const schedule = await created.json();
  assert.equal(schedule.conversationId, 'c1');
  assert.equal((await (await call('')).json()).length, 1);

  assert.equal(
    (
      await call(`/${schedule.id}/enabled`, {
        method: 'POST',
        body: { enabled: false },
      })
    ).status,
    204
  );
  assert.equal(scheduler.get(schedule.id).enabled, false);
  assert.equal(
    (
      await call(`/${schedule.id}/enabled`, {
        method: 'POST',
        body: { enabled: true },
      })
    ).status,
    204
  );

  assert.deepEqual(await (await call(`/${schedule.id}/runs`)).json(), []);
  assert.equal(
    (await call(`/${schedule.id}`, { method: 'DELETE' })).status,
    204
  );
  assert.equal(scheduler.list().length, 0);
});

test('validation errors are 400 and unknown schedules are 404', async () => {
  assert.equal(
    (await call('', { method: 'POST', body: { ...valid, everyMs: 5 } })).status,
    400
  );
  assert.equal(
    (
      await call('', {
        method: 'POST',
        body: { ...valid, conversationId: '../x' },
      })
    ).status,
    400
  );
  assert.equal(
    (await call('/nope/enabled', { method: 'POST', body: { enabled: true } }))
      .status,
    404
  );
  assert.equal((await call('/nope/runs')).status, 404);
  const s = await (await call('', { method: 'POST', body: valid })).json();
  assert.equal(
    (
      await call(`/${s.id}/enabled`, {
        method: 'POST',
        body: { enabled: 'yes' },
      })
    ).status,
    400
  );
});
