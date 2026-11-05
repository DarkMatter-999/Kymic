import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { LoginManager, createLoginRouter } from '../server/gateway/login.ts';

const ORIGIN = 'https://agents.example.test';
let server, base, manager, authed;

/** A scriptable stand-in for Pi's ModelRuntime. */
function fakeRuntime(script) {
  const creds = [];
  return {
    creds,
    getProviders: () => [
      {
        id: 'sub',
        name: 'Subscription',
        auth: { oauth: { name: 'Sub OAuth', loginLabel: 'Sign in' } },
      },
      {
        id: 'key',
        name: 'Keyed',
        auth: { apiKey: { name: 'API key', login: () => {} } },
      },
      { id: 'ambient', name: 'Env only', auth: { apiKey: { name: 'env' } } },
    ],
    listCredentials: async () => creds,
    login: async (providerId, type, interaction) => {
      await script(interaction, type);
      creds.push({ providerId, type });
      return {};
    },
    logout: async (id) => {
      const i = creds.findIndex((c) => c.providerId === id);
      if (i >= 0) creds.splice(i, 1);
    },
  };
}

async function boot(script, options) {
  authed = true;
  manager = new LoginManager(fakeRuntime(script), options);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/pi',
    createLoginRouter({
      login: manager,
      allowedOrigins: [ORIGIN],
      authenticate: () => authed,
    })
  );
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/pi`;
}
afterEach(async () => {
  manager?.close();
  server?.closeAllConnections?.();
  if (server) await new Promise((r) => server.close(r));
  server = undefined;
});

const post = (path, body, origin = ORIGIN) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body ?? {}),
  });
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met');
};
const eventTypes = () => manager.current()?.events.map((e) => e.type);

test('lists only providers that can sign in interactively, and whether they are configured', async () => {
  await boot(async () => {});
  const list = await (await fetch(base + '/providers')).json();
  assert.deepEqual(
    list.map((p) => [p.id, p.configured, p.methods.map((m) => m.type)]),
    [
      ['sub', false, ['oauth']],
      ['key', false, ['api_key']],
    ]
  );
});

test('requires authentication, an allowed Origin and JSON for state changes', async () => {
  await boot(async () => {});
  authed = false;
  assert.equal((await fetch(base + '/providers')).status, 401);
  assert.equal((await post('/login', {})).status, 401);
  authed = true;
  assert.equal(
    (
      await post(
        '/login',
        { providerId: 'sub', authType: 'oauth' },
        'https://evil.example'
      )
    ).status,
    403
  );
  const noType = await fetch(base + '/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(noType.status, 415);
  assert.equal((await post('/login', { providerId: 'sub' })).status, 400);
  assert.equal(
    (await post('/login', { providerId: 'ambient', authType: 'api_key' }))
      .status,
    409
  );
});

test('an OAuth flow shows the link, takes a pasted code, and marks the provider configured', async () => {
  await boot(async (i) => {
    i.notify({
      type: 'auth_url',
      url: 'https://auth.example/authorize?x=1',
      instructions: 'Open it',
    });
    const code = await i.prompt({
      type: 'manual_code',
      message: 'Paste the redirect URL',
    });
    assert.equal(code, 'the-code');
  });
  const res = await post('/login', { providerId: 'sub', authType: 'oauth' });
  assert.equal(res.status, 201);
  const { loginId } = await res.json();

  const prompt = await until(() =>
    manager.current().events.find((e) => e.type === 'prompt')
  );
  assert.equal(prompt.kind, 'manual_code');
  assert.equal(
    manager.current().events.find((e) => e.type === 'auth_url').url,
    'https://auth.example/authorize?x=1'
  );

  assert.equal(
    (
      await post(`/login/${loginId}/respond`, {
        promptId: prompt.promptId,
        value: 'the-code',
      })
    ).status,
    204
  );
  await until(() => manager.current().status === 'done');
  assert.ok(eventTypes().includes('prompt_closed'));
  const list = await (await fetch(base + '/providers')).json();
  assert.equal(list.find((p) => p.id === 'sub').configured, true);
});

test('secrets are never echoed back in events', async () => {
  await boot(async (i) => {
    const key = await i.prompt({ type: 'secret', message: 'API key' });
    i.notify({ type: 'progress', message: 'verifying' });
    assert.equal(key, 'sk-super-secret');
  });
  const { loginId } = await (
    await post('/login', { providerId: 'key', authType: 'api_key' })
  ).json();
  const prompt = await until(() =>
    manager.current().events.find((e) => e.type === 'prompt')
  );
  await post(`/login/${loginId}/respond`, {
    promptId: prompt.promptId,
    value: 'sk-super-secret',
  });
  await until(() => manager.current().status === 'done');
  assert.ok(!JSON.stringify(manager.current()).includes('sk-super-secret'));
});

test('stale prompt ids, wrong login ids and unoffered select options are rejected', async () => {
  await boot(async (i) => {
    await i.prompt({
      type: 'select',
      message: 'Pick',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
  });
  const { loginId } = await (
    await post('/login', { providerId: 'sub', authType: 'oauth' })
  ).json();
  const prompt = await until(() =>
    manager.current().events.find((e) => e.type === 'prompt')
  );
  assert.equal(
    (await post(`/login/${loginId}/respond`, { promptId: 'nope', value: 'a' }))
      .status,
    400
  );
  assert.equal(
    (
      await post(`/login/other/respond`, {
        promptId: prompt.promptId,
        value: 'a',
      })
    ).status,
    400
  );
  assert.equal(
    (
      await post(`/login/${loginId}/respond`, {
        promptId: prompt.promptId,
        value: 'zzz',
      })
    ).status,
    400
  );
  assert.equal(
    (
      await post(`/login/${loginId}/respond`, {
        promptId: prompt.promptId,
        value: 'b',
      })
    ).status,
    204
  );
  await until(() => manager.current().status === 'done');
  // answering twice fails
  assert.equal(
    (
      await post(`/login/${loginId}/respond`, {
        promptId: prompt.promptId,
        value: 'b',
      })
    ).status,
    400
  );
});

test('only http(s) links reach the browser', async () => {
  await boot(async (i) => {
    i.notify({ type: 'auth_url', url: 'javascript:alert(1)' });
    i.notify({
      type: 'info',
      message: 'see',
      links: [
        { url: 'data:text/html,x' },
        { url: 'https://ok.example/', label: 'ok' },
      ],
    });
  });
  await post('/login', { providerId: 'sub', authType: 'oauth' });
  await until(() => manager.current().status === 'done');
  const events = manager.current().events;
  assert.ok(!events.some((e) => e.type === 'auth_url'));
  assert.deepEqual(events.find((e) => e.type === 'info').links, [
    { url: 'https://ok.example/', label: 'ok' },
  ]);
});

test('one login at a time; cancel aborts the flow and frees the slot', async () => {
  let aborted = false;
  await boot(async (i) => {
    i.signal.addEventListener('abort', () => (aborted = true));
    await i.prompt({ type: 'text', message: 'wait' });
  });
  const { loginId } = await (
    await post('/login', { providerId: 'sub', authType: 'oauth' })
  ).json();
  assert.equal(
    (await post('/login', { providerId: 'key', authType: 'api_key' })).status,
    409
  );
  assert.equal((await post(`/login/${loginId}/cancel`, {})).status, 204);
  assert.equal(manager.current().status, 'cancelled');
  assert.ok(aborted);
  assert.equal(
    (await post('/login', { providerId: 'key', authType: 'api_key' })).status,
    201
  );
});

test('a failing provider reports a failure and leaves it unconfigured', async () => {
  await boot(async () => {
    throw new Error('invalid_grant');
  });
  await post('/login', { providerId: 'sub', authType: 'oauth' });
  await until(() => manager.current().status === 'failed');
  assert.match(manager.current().events.at(-1).message, /invalid_grant/);
  const list = await (await fetch(base + '/providers')).json();
  assert.equal(list.find((p) => p.id === 'sub').configured, false);
});

test('prompts time out instead of hanging forever', async () => {
  await boot(
    async (i) => {
      await i.prompt({ type: 'text', message: 'never answered' });
    },
    { promptTimeoutMs: 50 }
  );
  await post('/login', { providerId: 'sub', authType: 'oauth' });
  await until(() => manager.current().status === 'failed');
  assert.match(manager.current().events.at(-1).message, /Timed out/);
});

test('the event stream replays history then ends when the login does', async () => {
  await boot(async (i) => {
    i.notify({ type: 'progress', message: 'step 1' });
    await new Promise((r) => setTimeout(r, 100));
  });
  const { loginId } = await (
    await post('/login', { providerId: 'sub', authType: 'oauth' })
  ).json();
  const res = await fetch(`${base}/login/${loginId}/events`);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const body = await res.text(); // resolves because the server ends the stream
  const events = body
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));
  assert.deepEqual(
    events.map((e) => e.type),
    ['progress', 'done']
  );
});

test('logout removes the credential and is refused mid-login', async () => {
  await boot(async () => {});
  await post('/login', { providerId: 'sub', authType: 'oauth' });
  await until(() => manager.current().status === 'done');
  assert.equal((await post('/providers/sub/logout', {})).status, 204);
  assert.equal(
    (await (await fetch(base + '/providers')).json()).find(
      (p) => p.id === 'sub'
    ).configured,
    false
  );
  assert.equal((await post('/providers/nope/logout', {})).status, 400);
});
