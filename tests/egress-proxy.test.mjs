import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createEgressProxy, isPrivateAddress } from '../server/egress-proxy.ts';

const closers = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      closers.push(
        () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          })
      );
      resolve(server.address().port);
    });
  });

async function echoServer() {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('data', (d) => s.write(`echo:${d}`));
    s.on('error', () => {});
  });
  const port = await listen(server);
  // net.Server cannot drop connections itself, and close() waits for them.
  closers.unshift(async () => sockets.forEach((s) => s.destroy()));
  return { port };
}
async function webServer() {
  const server = http.createServer((req, res) =>
    res.end(`web:${req.headers.host}${req.url}`)
  );
  return { port: await listen(server) };
}
const DNS = {
  'allowed.test': '127.0.0.1',
  'api.openai.test': '127.0.0.1',
  'rebind.test': '10.0.0.5',
  'meta.test': '169.254.169.254',
};
const resolve = async (host) => {
  if (!DNS[host]) throw new Error('NXDOMAIN');
  return [{ address: DNS[host], family: 4 }];
};

async function proxy(options) {
  const logs = [];
  const server = createEgressProxy({
    resolve,
    log: (m) => logs.push(m),
    ...options,
  });
  return { port: await listen(server), logs };
}

/** Send a CONNECT; resolves with the status line, the socket and a reader for later chunks. */
function connect(proxyPort, target) {
  return new Promise((resolveConn, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    closers.push(async () => socket.destroy());
    socket.once('error', reject);
    let header = '';
    let headerDone = false;
    const chunks = [];
    const waiting = [];
    socket.on('data', (d) => {
      if (!headerDone) {
        header += d;
        if (!header.includes('\r\n\r\n')) return;
        headerDone = true;
        resolveConn({
          status: header.split('\r\n')[0],
          socket,
          next: () =>
            chunks.length > 0
              ? Promise.resolve(chunks.shift())
              : new Promise((r) => waiting.push(r)),
        });
        return;
      }
      if (waiting.length > 0) waiting.shift()(String(d));
      else chunks.push(String(d));
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

test('tunnels to an allowlisted host and port', async () => {
  const echo = await echoServer();
  const p = await proxy({
    allow: [],
    allowPrivate: [`allowed.test:${echo.port}`],
  });
  const { status, socket, next } = await connect(
    p.port,
    `allowed.test:${echo.port}`
  );
  assert.match(status, /200/);
  socket.write('hello');
  assert.equal(await next(), 'echo:hello');
});

test('refuses everything not on the allowlist, including other ports', async () => {
  const echo = await echoServer();
  const p = await proxy({
    allow: ['api.openai.test'],
    allowPrivate: [`allowed.test:${echo.port}`],
  });
  assert.match((await connect(p.port, 'example.com:443')).status, /403/);
  assert.match((await connect(p.port, 'api.openai.test:22')).status, /403/);
  assert.match(
    (await connect(p.port, `allowed.test:${echo.port + 1}`)).status,
    /403/
  );
  assert.match((await connect(p.port, 'not a target')).status, /400/);
  assert.ok(p.logs.some((l) => l.includes('example.com')));
});

test('an allowlisted name that resolves to a private address is refused', async () => {
  const p = await proxy({
    allow: ['rebind.test', 'meta.test', '169.254.169.254', '127.0.0.1'],
  });
  assert.match((await connect(p.port, 'rebind.test:443')).status, /403/);
  assert.match((await connect(p.port, 'meta.test:443')).status, /403/);
  // Literal addresses get the same check, even when listed.
  assert.match((await connect(p.port, '169.254.169.254:443')).status, /403/);
  assert.match((await connect(p.port, '127.0.0.1:443')).status, /403/);
  assert.match((await connect(p.port, 'nxdomain.test:443')).status, /403/);
});

test('wildcards match subdomains only', async () => {
  const p = await proxy({ allow: ['*.openai.test'] });
  // Allowed by name but resolves private, so a 403 here proves the rule matched only
  // for the cases that should reach the DNS check.
  const logs = () => p.logs.join('\n');
  await connect(p.port, 'api.openai.test:443');
  assert.match(
    logs(),
    /api\.openai\.test:443 \(resolves to a private address\)/
  );
  await connect(p.port, 'openai.test:443');
  assert.match(logs(), /openai\.test:443 \(not on the allowlist\)/);
  await connect(p.port, 'evilopenai.test:443');
  assert.match(logs(), /evilopenai\.test:443 \(not on the allowlist\)/);
  await connect(p.port, 'api.openai.test.evil.com:443');
  assert.match(
    logs(),
    /api\.openai\.test\.evil\.com:443 \(not on the allowlist\)/
  );
});

test('plain HTTP is forwarded only for allowlisted destinations', async () => {
  const web = await webServer();
  const p = await proxy({
    allow: [],
    allowPrivate: [`allowed.test:${web.port}`],
  });
  const get = (url) =>
    new Promise((resolveReq, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: p.port,
          method: 'GET',
          path: url,
          headers: { host: new URL(url).host },
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolveReq({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  const ok = await get(`http://allowed.test:${web.port}/x?y=1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, `web:allowed.test:${web.port}/x?y=1`);
  assert.equal((await get('http://example.com/')).status, 403);
  // Origin-form requests (not meant for a proxy) are rejected.
  const direct = await new Promise((r) => {
    http.get({ host: '127.0.0.1', port: p.port, path: '/health' }, (res) =>
      r(res.statusCode)
    );
  });
  assert.equal(direct, 400);
});

test('connection count is bounded', async () => {
  const echo = await echoServer();
  const p = await proxy({
    allow: [],
    allowPrivate: [`allowed.test:${echo.port}`],
    maxConnections: 1,
  });
  const first = await connect(p.port, `allowed.test:${echo.port}`);
  assert.match(first.status, /200/);
  assert.match(
    (await connect(p.port, `allowed.test:${echo.port}`)).status,
    /503/
  );
});

test('private address classification', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of [
    '8.8.8.8',
    '104.18.0.1',
    '172.32.0.1',
    '2606:4700::1',
    '::ffff:8.8.8.8',
  ])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('malformed rules are rejected up front', () => {
  assert.throws(
    () => createEgressProxy({ allow: ['bad host!'] }),
    /Invalid egress rule/
  );
});
