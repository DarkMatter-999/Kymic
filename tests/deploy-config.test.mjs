// Static checks on the deployment files: the properties the security review relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');
const compose = await read('docker-compose.prod.yml');
const dev = await read('docker-compose.dev.yml');
const prodImage = await read('Dockerfile.prod');
const devImage = await read('Dockerfile.dev');
const nginx = await read('docker/nginx.conf');
const nginxTls = await read('docker/nginx.tls.conf');
const snippet = await read('docker/snippets/app-proxy.conf');
const entrypoint = await read('docker/entrypoint.sh');

/** The text of one top-level service block. */
function service(text, name) {
  const m = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, 'm').exec(text);
  assert.ok(m, `service ${name}`);
  return m[1];
}

test('images use Node 24 (node:sqlite and the pinned Pi need >= 22.19)', () => {
  for (const file of [prodImage, devImage]) {
    const versions = [...file.matchAll(/FROM node:(\d+)/g)].map((m) =>
      Number(m[1])
    );
    assert.ok(versions.length > 0);
    for (const v of versions)
      assert.ok(v >= 22 && v !== 22 ? v >= 24 || v > 22 : false, `node ${v}`);
  }
});

test('the production image runs compiled code, not a dev runner', () => {
  assert.match(prodImage, /npm run build:server/);
  assert.match(prodImage, /CMD \["node", "dist-server\/index\.js"\]/);
  assert.doesNotMatch(prodImage, /tsx|nodemon/);
  assert.match(prodImage, /npm ci --omit=dev --ignore-scripts/);
  // Worker inputs are copied in and owned by root.
  assert.match(prodImage, /COPY --chown=root:root extensions/);
  assert.match(prodImage, /COPY --chown=root:root skills/);
  assert.match(prodImage, /useradd --uid 10001/);
  assert.match(prodImage, /HEALTHCHECK/);
});

test('only the edge proxy publishes ports; Redis and the docker socket are absent', () => {
  for (const name of ['app', 'egress']) {
    const block = service(compose, name);
    assert.doesNotMatch(
      block,
      /^    ports:/m,
      `${name} must not publish ports`
    );
  }
  assert.match(service(compose, 'proxy'), /^    ports:/m);
  assert.doesNotMatch(compose, /redis/i);
  assert.doesNotMatch(compose + dev, /docker\.sock/);
  // Published ports bind loopback unless the operator widens them.
  assert.match(service(compose, 'proxy'), /\$\{BIND_ADDRESS:-127\.0\.0\.1\}/);
  assert.match(dev, /127\.0\.0\.1:3000:3000/);
  assert.match(dev, /127\.0\.0\.1:5173:5173/);
});

test('app and egress are locked down', () => {
  for (const name of ['app', 'egress']) {
    const block = service(compose, name);
    assert.match(block, /<<: \*hardening/, name);
  }
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
  const app = service(compose, 'app');
  assert.match(app, /pids_limit:/);
  assert.match(app, /mem_limit:/);
  assert.match(
    app,
    /cap_add: \[CHOWN, FOWNER, SETUID, SETGID, DAC_READ_SEARCH\]/
  );
  assert.doesNotMatch(app, /^\s+privileged:|SYS_ADMIN|NET_ADMIN|NET_RAW/m);
});

test('workers have no direct route out; only the egress proxy can reach the internet', () => {
  assert.match(compose, /^  internal:\n    internal: true/m);
  assert.match(service(compose, 'app'), /networks: \[internal\]/);
  assert.match(service(compose, 'egress'), /networks: \[internal, edge\]/);
  assert.match(
    service(compose, 'app'),
    /PI_WORKER_PROXY: http:\/\/egress:3128/
  );
});

test('secrets are required, not defaulted', () => {
  assert.match(compose, /GATEWAY_PASSWORD: \$\{GATEWAY_PASSWORD:\?/);
  assert.match(compose, /ALLOWED_ORIGINS: \$\{PUBLIC_ORIGIN:\?/);
  assert.doesNotMatch(compose, /GATEWAY_PASSWORD: [^$\s]/);
});

test('the edge forwards WebSocket upgrades and does not buffer streams', () => {
  for (const conf of [nginx, nginxTls]) {
    assert.match(conf, /map \$http_upgrade \$connection_upgrade/);
    assert.match(conf, /include \/etc\/nginx\/snippets\/app-proxy\.conf/);
    assert.match(conf, /client_max_body_size 1m/);
    assert.match(conf, /server_tokens off/);
  }
  const gateway = /location \/gateway \{[^}]*\}/s.exec(snippet)[0];
  assert.match(gateway, /proxy_http_version 1\.1/);
  assert.match(gateway, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(gateway, /proxy_set_header Connection \$connection_upgrade/);
  assert.match(gateway, /proxy_read_timeout 1h/);
  assert.match(gateway, /proxy_buffering off/);
  const events = /location ~ \^\/api\/pi\/login[^{]*\{[^}]*\}/s.exec(
    snippet
  )[0];
  assert.match(events, /proxy_buffering off/);
});

test('the TLS edge redirects, sets HSTS, and still answers health checks over HTTP', () => {
  assert.match(nginxTls, /listen 443 ssl/);
  assert.match(nginxTls, /ssl_protocols\s+TLSv1\.2 TLSv1\.3/);
  assert.match(nginxTls, /Strict-Transport-Security/);
  assert.match(nginxTls, /return 301 https:\/\//);
  assert.match(nginxTls, /location = \/health/);
});

test('the entrypoint keeps gateway state private and the worker out of the parents', () => {
  assert.match(entrypoint, /chmod 700 \/data\/gateway/);
  assert.match(
    entrypoint,
    /chmod 711 \/data\/agent \/data\/agent\/workspaces \/data\/agent\/sessions/
  );
  assert.match(
    entrypoint,
    /chown -R -h "\$PI_AGENT_UID:\$PI_AGENT_GID" \/data\/agent\/home/
  );
  assert.doesNotMatch(entrypoint, /chmod 7[0-7]7|chmod -R 777|chmod 666/);
});

test('local files that must not enter an image are ignored', async () => {
  const ignore = (await read('.dockerignore')).split('\n');
  for (const entry of ['.env', 'node_modules', 'docs', '.pi-data'])
    assert.ok(ignore.includes(entry), entry);
});
