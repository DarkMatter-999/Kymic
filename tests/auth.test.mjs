import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Auth } from '../server/gateway/auth.ts';
import { attachGateway } from '../server/gateway/ws.ts';

const ORIGIN = 'https://agents.example.test';
const PASSWORD = 'correct horse battery staple';
let dir, clock, auth, server, base;
const auths = [];

async function boot(overrides = {}) {
  auth = new Auth({
    dbPath: join(dir, 'auth.db'),
    password: PASSWORD,
    allowedOrigins: [ORIGIN],
    now: () => clock,
    ...overrides,
  });
  auths.push(auth);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router);
  app.get('/api/private', auth.requireAuth, (_req, res) =>
    res.json({ ok: true })
  );
  server = createServer(app);
  attachGateway(server, {
    manager: {
      subscribe: () => () => {},
      snapshot: async () => ({ running: false, messages: [] }),
    },
    allowedOrigins: [ORIGIN],
    authenticate: (req) => auth.authenticate(req),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auth-'));
  clock = Date.UTC(2026, 0, 1);
});
afterEach(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise((r) => server.close(r));
  auths.splice(0).forEach((a) => a.close());
  await rm(dir, { recursive: true, force: true });
  server = undefined;
});

const post = (
  path,
  body,
  { origin = ORIGIN, type = 'application/json', cookie } = {}
) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      ...(origin ? { origin } : {}),
      ...(type ? { 'content-type': type } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const login = (password = PASSWORD, opts) =>
  post('/api/auth/login', { password }, opts);
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];
const getSession = (cookie) =>
  fetch(base + '/api/auth/session', { headers: cookie ? { cookie } : {} });

test('wrong password is rejected without a cookie; the right one sets a hardened cookie', async () => {
  await boot({ secureCookies: true });
  const bad = await login('nope');
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  const good = await login();
  assert.equal(good.status, 204);
  const header = good.headers.get('set-cookie');
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  assert.match(header, /Secure/i);
  assert.match(header, /Path=\//i);
  assert.match(header, /Max-Age=\d+/i);
  assert.ok(!header.includes(PASSWORD));
});

test('cookie is not Secure when secureCookies is off (plain-http local development)', async () => {
  await boot();
  assert.doesNotMatch((await login()).headers.get('set-cookie'), /Secure/i);
});

test('session endpoint and protected routes require a valid cookie', async () => {
  await boot();
  assert.equal((await getSession()).status, 401);
  assert.equal((await fetch(base + '/api/private')).status, 401);
  const cookie = cookieOf(await login());
  assert.equal((await getSession(cookie)).status, 200);
  assert.equal(
    (await fetch(base + '/api/private', { headers: { cookie } })).status,
    200
  );
  assert.equal((await getSession('codemode_session=garbage')).status, 401);
  assert.equal((await getSession(cookie.slice(0, -3) + 'xxx')).status, 401);
});

test('login requires an allowed Origin and a JSON body (CSRF)', async () => {
  await boot();
  assert.equal(
    (await login(PASSWORD, { origin: 'https://evil.example' })).status,
    403
  );
  assert.equal((await login(PASSWORD, { origin: null })).status, 403);
  assert.equal((await login(PASSWORD, { type: 'text/plain' })).status, 415);
  assert.equal((await post('/api/auth/login', '{bad json', {})).status, 400);
  assert.equal((await post('/api/auth/login', {})).status, 400);
});

test('sessions expire', async () => {
  await boot({ sessionTtlMs: 60_000 });
  const cookie = cookieOf(await login());
  clock += 59_000;
  assert.equal((await getSession(cookie)).status, 200);
  clock += 2_000;
  assert.equal((await getSession(cookie)).status, 401);
});

test('logout invalidates the session server-side, so a replayed cookie fails', async () => {
  await boot();
  const cookie = cookieOf(await login());
  assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 204);
  assert.equal((await getSession(cookie)).status, 401);
  assert.equal(
    (
      await post(
        '/api/auth/logout',
        {},
        { origin: 'https://evil.example', cookie }
      )
    ).status,
    403
  );
});

test('only a hash of the session token is stored, and sessions survive a restart', async () => {
  await boot();
  const cookie = cookieOf(await login());
  const token = cookie.split('=')[1];
  assert.ok(!(await readFile(join(dir, 'auth.db'))).includes(token));
  auth.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await boot();
  assert.equal((await getSession(cookie)).status, 200);
});

test('repeated failures are rate limited, even for the correct password, until the window passes', async () => {
  await boot({ maxFailures: 3, failureWindowMs: 60_000 });
  for (let i = 0; i < 3; i++) assert.equal((await login('wrong')).status, 401);
  const blocked = await login();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  clock += 61_000;
  assert.equal((await login()).status, 204);
});

test('a successful login does not reset the global failure budget being abused', async () => {
  await boot({ maxFailures: 3, failureWindowMs: 60_000 });
  await login('wrong');
  await login('wrong');
  assert.equal((await login()).status, 204);
  await login('wrong');
  await login('wrong');
  assert.equal((await login('wrong')).status, 429);
});

test('WebSocket handshakes need the cookie; a token in the URL does not authenticate', async () => {
  await boot();
  const url = base.replace('http', 'ws') + '/gateway';
  const open = (u, headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(u, { headers: { origin: ORIGIN, ...headers } });
      ws.once('open', () => {
        ws.close();
        resolve('open');
      });
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode));
      ws.once('error', reject);
    });
  assert.equal(await open(url, {}), 401);
  const cookie = cookieOf(await login());
  assert.equal(
    await open(
      `${url}?token=${cookie.split('=')[1]}&session=${cookie.split('=')[1]}`,
      {}
    ),
    401
  );
  assert.equal(await open(url, { cookie }), 'open');
  const loggedOut = cookie;
  await post('/api/auth/logout', {}, { cookie });
  assert.equal(await open(url, { cookie: loggedOut }), 401);
});

test('construction refuses a missing or weak password', () => {
  const opts = { dbPath: join(dir, 'a.db'), allowedOrigins: [ORIGIN] };
  assert.throws(() => new Auth({ ...opts, password: '' }), /password/i);
  assert.throws(() => new Auth({ ...opts, password: 'short' }), /password/i);
});
