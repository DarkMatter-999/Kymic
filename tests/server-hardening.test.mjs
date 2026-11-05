// Black-box checks against the real server process (no Docker needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const ORIGIN = 'https://agents.example.test';
const PASSWORD = 'correct horse battery staple';
let root, main;
const children = [];

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function boot(extraEnv = {}) {
  const port = await freePort();
  const dataDir = join(root, `data-${port}`);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        GATEWAY_PASSWORD: PASSWORD,
        ALLOWED_ORIGINS: ORIGIN,
        PI_DATA_DIR: dataDir,
        PI_AGENT_HOME: join(root, 'home'),
        STATIC_DIR: join(root, 'static'),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start:\n${log}`)),
      30000
    );
    const poll = setInterval(() => {
      if (log.includes('Server running')) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 50);
    child.once('exit', () => reject(new Error(`server exited:\n${log}`)));
  });
  return { port, base: `http://127.0.0.1:${port}`, dataDir, log: () => log };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'harden-'));
  await mkdir(join(root, 'static'), { recursive: true });
  await writeFile(
    join(root, 'static', 'index.html'),
    '<!doctype html><title>APP</title>'
  );
  main = await boot();
});
after(async () => {
  for (const c of children) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  await rm(root, { recursive: true, force: true });
});

const json = (path, body, origin = ORIGIN, cookie) =>
  fetch(main.base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const loginCookie = async () => {
  const res = await json('/api/auth/login', { password: PASSWORD });
  assert.equal(res.status, 204);
  return res.headers.get('set-cookie').split(';')[0];
};
const wsStatus = (headers, path = '/gateway') =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${main.port}${path}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    ws.on('error', () => {});
  });

test('liveness and readiness need no login and reveal nothing', async () => {
  assert.deepEqual(await (await fetch(`${main.base}/health`)).json(), {
    status: 'ok',
  });
  assert.deepEqual(await (await fetch(`${main.base}/health/ready`)).json(), {
    status: 'ready',
  });
});

test('an unusable runtime is reported as not ready, without saying why', async () => {
  const broken = await boot({ PI_CLI: join(root, 'missing', 'cli.js') });
  const live = await fetch(`${broken.base}/health`);
  const ready = await fetch(`${broken.base}/health/ready`);
  assert.equal(live.status, 200); // the process is fine
  assert.equal(ready.status, 503);
  const body = await ready.text();
  assert.deepEqual(JSON.parse(body), { status: 'unavailable' });
  assert.ok(!body.includes('missing'));
  assert.match(broken.log(), /Pi CLI is not readable/); // the operator sees the reason in the log
});

test('responses carry basic security headers and do not advertise Express', async () => {
  const res = await fetch(`${main.base}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('the SPA fallback serves the app but never answers API or socket paths', async () => {
  assert.match(await (await fetch(`${main.base}/`)).text(), /APP/);
  assert.match(
    await (await fetch(`${main.base}/some/deep/route`)).text(),
    /APP/
  );
  for (const path of ['/api/nope', '/api/pi/nope', '/gateway'])
    assert.doesNotMatch(
      await (await fetch(main.base + path)).text(),
      /APP/,
      path
    );
  assert.equal((await fetch(`${main.base}/api/nope`)).status, 404);
});

test('request bodies are size limited', async () => {
  const res = await json('/api/auth/login', { password: 'x'.repeat(300_000) });
  assert.equal(res.status, 413);
});

test('everything but health and login needs a session', async () => {
  for (const path of [
    '/api/schedules',
    '/api/pi/providers',
    '/api/pi/profiles',
    '/api/pi/login',
  ])
    assert.equal(
      (await fetch(main.base + path, { headers: { origin: ORIGIN } })).status,
      401,
      path
    );
  assert.equal(await wsStatus({ origin: ORIGIN }), 401);
});

test('hostile origins are refused for login, sockets and cross-origin reads', async () => {
  assert.equal(
    (
      await json(
        '/api/auth/login',
        { password: PASSWORD },
        'https://evil.example'
      )
    ).status,
    403
  );
  assert.equal(
    (await json('/api/auth/login', { password: PASSWORD }, null)).status,
    403
  );
  const cookie = await loginCookie();
  assert.equal(await wsStatus({ origin: 'https://evil.example', cookie }), 403);
  assert.equal(await wsStatus({ cookie }), 403); // no Origin at all
  assert.equal(await wsStatus({ origin: ORIGIN, cookie }), 'open');
  // State-changing API calls need the allowed Origin too, even with a valid session.
  assert.equal(
    (await json('/api/schedules', { x: 1 }, 'https://evil.example', cookie))
      .status,
    403
  );
  const cors = await fetch(`${main.base}/api/auth/session`, {
    headers: { origin: 'https://evil.example', cookie },
  });
  assert.equal(cors.headers.get('access-control-allow-origin'), null);
  const allowed = await fetch(`${main.base}/api/auth/session`, {
    headers: { origin: ORIGIN, cookie },
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
});

test('clients cannot inject extensions, tools, paths or arguments', async () => {
  const cookie = await loginCookie();
  const send = (message) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${main.port}/gateway`, {
        headers: { origin: ORIGIN, cookie },
      });
      ws.on('open', () => ws.send(JSON.stringify(message)));
      ws.on('message', (d) => {
        const e = JSON.parse(d);
        if (e.type === 'error') {
          ws.close();
          resolve(e.message);
        }
      });
      setTimeout(() => {
        ws.close();
        resolve('no error');
      }, 4000);
    });
  const base = { v: 1, type: 'prompt', text: 'hi' };
  assert.match(await send({ ...base, conversationId: '../escape' }), /Invalid/);
  assert.match(
    await send({ ...base, conversationId: 'ok1', profile: '../../etc/passwd' }),
    /Invalid/
  );
  assert.match(
    await send({ ...base, conversationId: 'ok2', profile: 'not-configured' }),
    /Unknown profile/
  );
  // Extra fields are dropped, not forwarded.
  await assert.rejects(access(join(root, 'escape')));
  await assert.rejects(access(join(main.dataDir, '..', 'escape')));
  // Sign-in input is validated against the provider list.
  const res = await json(
    '/api/pi/login',
    { providerId: '../../x', authType: 'oauth' },
    ORIGIN,
    cookie
  );
  assert.equal(res.status, 409);
  assert.equal(
    (
      await json(
        '/api/pi/login',
        { providerId: 'openai', authType: 'shell' },
        ORIGIN,
        cookie
      )
    ).status,
    400
  );
  // Profiles are names and labels only.
  const profiles = await (
    await fetch(`${main.base}/api/pi/profiles`, {
      headers: { cookie, origin: ORIGIN },
    })
  ).json();
  assert.ok(profiles.length >= 3);
  assert.ok(!JSON.stringify(profiles).match(/extensions|\.mjs|builtin:/));
});
