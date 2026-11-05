// Opt-in acceptance test against the real production image and compose file.
//   DOCKER_TESTS=1 node --import tsx --test tests/docker-acceptance.test.mjs
// It builds the image, starts app + egress + nginx, and drives the real stack
// through nginx with a scripted model running on the host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { startFakeModel } from './fixtures/fake-model.mjs';

const enabled = process.env.DOCKER_TESTS === '1';
// ACCEPTANCE_TLS=1 runs the same checks through the TLS edge with a throwaway
// self-signed certificate (certs/ is gitignored; the files are removed afterwards).
const tls = process.env.ACCEPTANCE_TLS === '1';
if (tls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // test-only: self-signed certificate
let httpPortForTests = 0;
const run = promisify(execFile);
const PASSWORD = 'acceptance-password-123';
const project = `cmatest${process.pid}`;
const compose = (...args) =>
  run(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'docker-compose.prod.yml',
      '-f',
      'tests/fixtures/docker-compose.test.yml',
      ...args,
    ],
    { env, maxBuffer: 20_000_000 }
  );
let env, model, base, origin, wsBase;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PROBE = [
  'echo "uid=$(id -u)"',
  '(touch /app/pwn 2>/dev/null && echo APP_WRITABLE) || echo APP_READONLY',
  '(cat /data/gateway/auth.db >/dev/null 2>&1 && echo GATEWAY_DATA_READABLE) || echo GATEWAY_DATA_PROTECTED',
  '(ls /data/gateway >/dev/null 2>&1 && echo GATEWAY_DIR_LISTABLE) || echo GATEWAY_DIR_PROTECTED',
  "(printenv | grep -E 'GATEWAY_PASSWORD|ALLOWED_ORIGINS' >/dev/null && echo SECRETS_IN_ENV) || echo ENV_CLEAN",
  '(ls /var/run/docker.sock >/dev/null 2>&1 && echo DOCKER_SOCKET) || echo NO_DOCKER_SOCKET',
  "(timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && echo DIRECT_INTERNET) || echo NO_DIRECT_INTERNET",
  `node -e "fetch('https://example.com').then(r=>console.log('FETCH_OK',r.status)).catch(e=>console.log('FETCH_BLOCKED'))"`,
].join('; ');

before(async () => {
  if (!enabled) return;
  const modelPort = await freePort();
  model = await startFakeModel([], {
    port: modelPort,
    host: '0.0.0.0',
    fallback: (req) => {
      const last = req.messages.at(-1);
      if (last.role === 'tool') return { text: 'probe finished' };
      const content = req.messages.findLast((m) => m.role === 'user')?.content;
      const userText = Array.isArray(content)
        ? content.map((c) => c.text ?? '').join('')
        : String(content ?? '');
      if (userText.includes('probe'))
        return { toolCalls: [{ name: 'bash', arguments: { command: PROBE } }] };
      return { text: 'pong from the container' };
    },
  });
  const httpPort = await freePort();
  const httpsPort = await freePort();
  httpPortForTests = httpPort;
  origin = tls
    ? `https://127.0.0.1:${httpsPort}`
    : `http://127.0.0.1:${httpPort}`;
  base = origin;
  wsBase = tls ? `wss://127.0.0.1:${httpsPort}` : `ws://127.0.0.1:${httpPort}`;
  if (tls) {
    await mkdir('certs', { recursive: true });
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      'certs/tls.key',
      '-out',
      'certs/tls.crt',
    ]);
  }
  env = {
    ...process.env,
    ...(tls ? { NGINX_CONF: 'nginx.tls.conf', COOKIE_SECURE: '1' } : {}),
    GATEWAY_PASSWORD: PASSWORD,
    PUBLIC_ORIGIN: origin,
    HTTP_PORT: String(httpPort),
    HTTPS_PORT: String(httpsPort),
    EGRESS_ALLOW_PRIVATE: `host.docker.internal:${modelPort}`,
  };
  await compose('build', 'app');
  // Seed the model configuration into the data volume before the app starts.
  const models = JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://host.docker.internal:${modelPort}/v1`,
        api: 'openai-completions',
        apiKey: 'test',
        models: [
          {
            id: 'fake-1',
            name: 'fake',
            reasoning: false,
            input: ['text'],
            contextWindow: 32000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  });
  await run('docker', ['volume', 'create', `${project}_app-data`]);
  await run('docker', [
    'run',
    '--rm',
    '-v',
    `${project}_app-data:/data`,
    '--entrypoint',
    'sh',
    'code-mode-agents:latest',
    '-c',
    `mkdir -p /data/agent/home && printf '%s' '${models}' > /data/agent/home/models.json && printf '%s' '{"defaultProvider":"fake","defaultModel":"fake-1"}' > /data/agent/home/settings.json`,
  ]);
  await compose('up', '-d', '--wait', '--no-build');
});

after(async () => {
  if (!enabled) return;
  await compose('down', '-v').catch(() => {});
  // The volume was created by hand (to seed config), so `down -v` does not own it.
  await run('docker', ['volume', 'rm', '-f', `${project}_app-data`]).catch(
    () => {}
  );
  if (tls)
    await rm('certs/tls.key', { force: true }).then(() =>
      rm('certs/tls.crt', { force: true })
    );
  await model?.close();
});

const login = async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 204);
  return res.headers.get('set-cookie').split(';')[0];
};

function converse(cookie, conversationId, text, { profile } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/gateway`, {
      headers: { origin, cookie },
      rejectUnauthorized: false,
    });
    const events = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out'));
    }, 60_000);
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'prompt',
          conversationId,
          text,
          ...(profile ? { profile } : {}),
        })
      )
    );
    ws.on('message', (d) => {
      const e = JSON.parse(d);
      events.push(e);
      if (e.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(e.message));
      }
      if (e.type === 'settled') {
        clearTimeout(timer);
        ws.close();
        resolve(events);
      }
    });
    ws.on('error', reject);
  });
}

const opts = {
  skip: !enabled && 'set DOCKER_TESTS=1 to run',
  timeout: 120_000,
};

test('health checks work through the edge proxy', opts, async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
    status: 'ok',
  });
  assert.deepEqual(await (await fetch(`${base}/health/ready`)).json(), {
    status: 'ready',
  });
  assert.equal((await fetch(`${base}/`)).status, 200); // the frontend
});

test(
  'only the edge proxy is reachable from the host; backend and Redis are not published',
  opts,
  async () => {
    const { stdout } = await compose('ps', '--format', 'json');
    const services = stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const published = (svc) =>
      (services.find((s) => s.Service === svc)?.Publishers ?? []).filter(
        (p) => p.PublishedPort
      );
    assert.ok(published('proxy').length > 0, 'the edge publishes a port');
    for (const p of published('proxy'))
      assert.ok(
        p.URL === '127.0.0.1' || p.URL === '',
        `loopback by default, got ${p.URL}`
      );
    for (const svc of ['app', 'egress'])
      assert.equal(published(svc).length, 0, `${svc} must not publish ports`);
    assert.ok(
      !services.some((s) => /redis/i.test(s.Service)),
      'no Redis service'
    );
  }
);

test(
  'unauthenticated and hostile requests are refused through the proxy',
  opts,
  async () => {
    assert.equal((await fetch(`${base}/api/schedules`)).status, 401);
    assert.equal((await fetch(`${base}/api/pi/providers`)).status, 401);
    const hostile = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(hostile.status, 403);
    const wsStatus = (headers) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${wsBase}/gateway`, {
          headers,
          rejectUnauthorized: false,
        });
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
        ws.on('error', () => {});
      });
    assert.equal(await wsStatus({ origin }), 401); // no cookie
    const cookie = await login();
    assert.equal(
      await wsStatus({ origin: 'https://evil.example', cookie }),
      403
    );
    assert.equal(await wsStatus({ origin, cookie }), 'open');
    const big = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: 'x'.repeat(2_000_000) }),
    });
    assert.equal(big.status, 413);
  }
);

test(
  'a real conversation streams through nginx over WebSocket',
  opts,
  async () => {
    const cookie = await login();
    const events = await converse(cookie, 'accept1', 'say pong', {
      profile: 'chat',
    });
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    assert.match(text, /pong from the container/);
  }
);

test(
  'the worker is unprivileged, sandboxed from gateway data, and cannot reach the internet directly',
  opts,
  async () => {
    const cookie = await login();
    const events = await converse(cookie, 'accept2', 'please probe', {
      profile: 'workspace',
    });
    const end = events.find((e) => e.type === 'tool_end');
    assert.ok(
      end,
      `no tool_end in ${JSON.stringify(events.map((e) => e.type + (e.message ? ':' + e.message : '')))}`
    );
    const out = end.result.content.map((c) => c.text).join('');
    assert.match(out, /uid=10001/);
    for (const expected of [
      'APP_READONLY',
      'GATEWAY_DATA_PROTECTED',
      'GATEWAY_DIR_PROTECTED',
      'ENV_CLEAN',
      'NO_DOCKER_SOCKET',
      'NO_DIRECT_INTERNET',
      'FETCH_BLOCKED',
    ])
      assert.ok(out.includes(expected), `${expected} in:\n${out}`);
  }
);

test(
  'the Pi process really runs as the agent user, and the gateway as root',
  opts,
  async () => {
    const script = `
      const fs = require('fs');
      for (const pid of fs.readdirSync('/proc').filter((p) => /^[0-9]+$/.test(p))) {
        try {
          const uid = fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/^Uid:\\s+([0-9]+)/m)[1];
          const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0').join(' ');
          console.log(uid + ' ' + args);
        } catch {}
      }`;
    const { stdout } = await compose('exec', '-T', 'app', 'node', '-e', script);
    // Pi renames its process to "pi", so identify workers by name and owner.
    const workers = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[0-9]+ pi\s*$/.test(l));
    assert.ok(workers.length > 0, `no Pi workers found in:\n${stdout}`);
    for (const w of workers) assert.match(w, /^10001 /, w);
    assert.match(stdout, /^0 node dist-server\/index.js/m);
  }
);

test(
  'a conversation survives an app restart with its profile and history',
  opts,
  async () => {
    await compose('restart', 'app');
    await compose('up', '-d', '--wait', '--no-build');
    const cookie = await login();
    const events = await converse(cookie, 'accept1', 'still there?'); // omit the profile: the recorded one applies
    assert.ok(events.some((e) => e.type === 'settled'));
    const ws = await new Promise((resolve) => {
      const s = new WebSocket(`${wsBase}/gateway`, {
        headers: { origin, cookie },
        rejectUnauthorized: false,
      });
      s.on('open', () =>
        s.send(
          JSON.stringify({ v: 1, type: 'subscribe', conversationId: 'accept1' })
        )
      );
      s.on('message', (d) => {
        const e = JSON.parse(d);
        if (e.type === 'snapshot') {
          s.close();
          resolve(e);
        }
      });
    });
    assert.equal(ws.profile, 'chat');
    assert.ok(
      ws.messages.length >= 4,
      'history from before the restart is still there'
    );
  }
);

test(
  'TLS edge: HTTP redirects to HTTPS, HSTS is set, and the session cookie is Secure',
  { ...opts, skip: !enabled ? opts.skip : !tls && 'set ACCEPTANCE_TLS=1' },
  async () => {
    const plain = await fetch(
      `http://127.0.0.1:${httpPortForTests}/some/page`,
      { redirect: 'manual' }
    );
    assert.equal(plain.status, 301);
    assert.match(
      plain.headers.get('location'),
      /^https:\/\/127\.0\.0\.1.*\/some\/page$/
    );
    // Health checks stay on plain HTTP.
    assert.equal(
      (await fetch(`http://127.0.0.1:${httpPortForTests}/health`)).status,
      200
    );
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('strict-transport-security'), /max-age=\d+/);
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.match(res.headers.get('set-cookie'), /Secure/i);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(res.headers.get('set-cookie'), /SameSite=Strict/i);
  }
);

test(
  'container limits and capabilities are actually applied',
  opts,
  async () => {
    const inspect = async (service) => {
      const { stdout: id } = await compose('ps', '-q', service);
      const { stdout } = await run('docker', ['inspect', id.trim()]);
      return JSON.parse(stdout)[0];
    };
    // Docker reports names with or without the CAP_ prefix depending on version.
    const caps = (list) =>
      (list ?? []).map((c) => c.replace(/^CAP_/, '')).sort();
    const app = await inspect('app');
    assert.equal(app.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(caps(app.HostConfig.CapDrop), ['ALL']);
    assert.deepEqual(caps(app.HostConfig.CapAdd), [
      'CHOWN',
      'DAC_READ_SEARCH',
      'FOWNER',
      'SETGID',
      'SETUID',
    ]);
    assert.ok(app.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.ok(app.HostConfig.PidsLimit > 0 && app.HostConfig.PidsLimit <= 512);
    assert.ok(app.HostConfig.Memory > 0);
    assert.equal(app.HostConfig.Privileged, false);
    assert.ok(!app.HostConfig.Binds?.some((b) => b.includes('docker.sock')));
    assert.deepEqual(
      Object.keys(app.NetworkSettings.Networks).map((n) =>
        n.replace(project + '_', '')
      ),
      ['internal']
    );
    const egress = await inspect('egress');
    assert.equal(egress.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(caps(egress.HostConfig.CapDrop), ['ALL']);
    assert.deepEqual(caps(egress.HostConfig.CapAdd), []);
    assert.equal(egress.Config.User, 'node');
  }
);
