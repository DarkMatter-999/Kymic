import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog, createModelRouter } from '../server/gateway/models.ts';
import { parseClientCommand } from '../server/gateway/protocol.ts';
import { LoginManager } from '../server/gateway/login.ts';

const ORIGIN = 'https://agents.example.test';
let dir, server, base, catalog, authed, available, refreshErrors;

const runtime = () => ({
  getAvailable: async () => available,
  getProvider: (id) => ({
    name: { openai: 'OpenAI', local: 'Local server' }[id] ?? id,
  }),
  refresh: async () => ({ errors: refreshErrors }),
});
const model = (provider, id, extra = {}) => ({
  provider,
  id,
  name: id.toUpperCase(),
  reasoning: false,
  input: ['text'],
  contextWindow: 1000,
  ...extra,
});

async function boot() {
  catalog = new ModelCatalog(runtime(), dir);
  await catalog.load();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/pi/models',
    createModelRouter({
      catalog,
      allowedOrigins: [ORIGIN],
      authenticate: () => authed,
    })
  );
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/pi/models`;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'models-'));
  authed = true;
  refreshErrors = new Map();
  available = [
    model('openai', 'zeta', { reasoning: true, input: ['text', 'image'] }),
    model('local', 'alpha'),
    model('openai', 'beta'),
  ];
});
afterEach(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise((r) => server.close(r));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});
const post = (path, body, origin = ORIGIN) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

test('lists available models grouped and sorted by provider name, with capabilities', async () => {
  await boot();
  const { models, default: def } = await (await fetch(base)).json();
  assert.equal(def, null);
  assert.deepEqual(
    models.map((m) => `${m.providerName}/${m.id}`),
    ['Local server/alpha', 'OpenAI/beta', 'OpenAI/zeta']
  );
  const zeta = models.find((m) => m.id === 'zeta');
  assert.deepEqual(
    [zeta.reasoning, zeta.images, zeta.contextWindow],
    [true, true, 1000]
  );
});

test('only a model the signed-in providers offer can become the default, and it persists', async () => {
  await boot();
  assert.equal(
    (await post('/default', { provider: 'openai', id: 'beta' })).status,
    200
  );
  assert.deepEqual(catalog.getDefault(), { provider: 'openai', id: 'beta' });
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')),
    { provider: 'openai', id: 'beta' }
  );

  for (const bad of [
    { provider: 'openai', id: 'gpt-secret' },
    { provider: 'nope', id: 'beta' },
    { provider: '../x', id: 'beta' },
    { provider: 'openai' },
    {},
    { provider: 5, id: 'beta' },
  ]) {
    const res = await post('/default', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(catalog.getDefault(), { provider: 'openai', id: 'beta' }); // unchanged

  // A new catalog (gateway restart) reads it back.
  const again = new ModelCatalog(runtime(), dir);
  await again.load();
  assert.deepEqual(again.getDefault(), { provider: 'openai', id: 'beta' });
});

test('requires authentication, an allowed Origin and JSON for changes', async () => {
  await boot();
  authed = false;
  assert.equal((await fetch(base)).status, 401);
  assert.equal(
    (await post('/default', { provider: 'openai', id: 'beta' })).status,
    401
  );
  authed = true;
  assert.equal(
    (
      await post(
        '/default',
        { provider: 'openai', id: 'beta' },
        'https://evil.example'
      )
    ).status,
    403
  );
  assert.equal((await post('/refresh', {}, null)).status, 403);
  const text = await fetch(base + '/default', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(text.status, 415);
});

test('refresh reports providers that could not be reached', async () => {
  await boot();
  assert.deepEqual(await (await post('/refresh')).json(), { failed: [] });
  refreshErrors = new Map([['local', new Error('connection refused')]]);
  assert.deepEqual(await (await post('/refresh')).json(), {
    failed: ['local'],
  });
});

test('a model that disappears (signed out) can no longer be chosen', async () => {
  await boot();
  await catalog.setDefault({ provider: 'openai', id: 'beta' });
  available = [model('local', 'alpha')];
  await assert.rejects(
    catalog.validate({ provider: 'openai', id: 'beta' }),
    /not available/
  );
  assert.equal((await (await fetch(base)).json()).models.length, 1);
});

test('set_model commands are parsed strictly', () => {
  const ok = parseClientCommand({
    v: 1,
    type: 'set_model',
    conversationId: 'c1',
    provider: 'openai',
    modelId: 'gpt-6-luna',
    extra: 1,
  });
  assert.deepEqual(ok, {
    v: 1,
    type: 'set_model',
    conversationId: 'c1',
    provider: 'openai',
    modelId: 'gpt-6-luna',
  });
  assert.equal(
    parseClientCommand({
      v: 1,
      type: 'set_model',
      conversationId: 'c1',
      provider: 'openrouter',
      modelId: 'openai/gpt-5:free',
    }).modelId,
    'openai/gpt-5:free'
  );
  for (const bad of [
    { provider: '../x', modelId: 'a' },
    { provider: 'a', modelId: '' },
    { provider: 'a' },
    { modelId: 'a' },
    { provider: 5, modelId: 'a' },
    { provider: 'a', modelId: 'x'.repeat(300) },
    { provider: 'a', modelId: '--flag' },
  ])
    assert.throws(
      () =>
        parseClientCommand({
          v: 1,
          type: 'set_model',
          conversationId: 'c1',
          ...bad,
        }),
      /Invalid/,
      JSON.stringify(bad)
    );
});

test('signing in or out tells the gateway that credentials changed', async () => {
  let changes = 0;
  const creds = [];
  const fake = {
    getProviders: () => [
      { id: 'sub', name: 'Sub', auth: { oauth: { name: 'Sub' } } },
    ],
    listCredentials: async () => creds,
    login: async (id, type) => {
      creds.push({ providerId: id, type });
      return {};
    },
    logout: async (id) => {
      creds.splice(
        0,
        creds.length,
        ...creds.filter((c) => c.providerId !== id)
      );
    },
  };
  const login = new LoginManager(fake, {
    onCredentialsChanged: () => {
      changes++;
    },
  });
  await login.start('sub', 'oauth');
  for (let i = 0; i < 50 && changes === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(changes, 1);
  await login.logout('sub');
  assert.equal(changes, 2);

  // A failing restart hook must not break sign-in.
  const failing = new LoginManager(fake, {
    onCredentialsChanged: () => {
      throw new Error('boom');
    },
  });
  await failing.start('sub', 'oauth');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(failing.current().status, 'done');
});
