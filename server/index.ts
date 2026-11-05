import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConversationManager } from './gateway/conversations';
import { attachGateway } from './gateway/ws';
import { Auth } from './gateway/auth';
import { LoginManager, createLoginRouter } from './gateway/login';
import { Scheduler } from './scheduler/scheduler';
import { createScheduleRouter } from './scheduler/http';
import { readinessFailures } from './health';
import { DEFAULT_PROFILES } from './workers/profiles';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const dataRoot = process.env.PI_DATA_DIR ?? './.pi-data';
const piCli =
  process.env.PI_CLI ??
  './node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const skills = (process.env.PI_SKILLS ?? './skills/spike/SKILL.md')
  .split(',')
  .filter(Boolean);
const agentHome = process.env.PI_AGENT_HOME ?? `${dataRoot}/agent-home`;
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
).split(',');

// --- Authentication -------------------------------------------------------
// GATEWAY_PASSWORD enables login. PI_GATEWAY_INSECURE_DEV=1 disables auth for
// local development only. With neither, every protected route denies access.
const insecureDev = process.env.PI_GATEWAY_INSECURE_DEV === '1';
mkdirSync(dataRoot, { recursive: true });
let auth: Auth | undefined;
if (process.env.GATEWAY_PASSWORD) {
  auth = new Auth({
    dbPath: `${dataRoot}/auth.db`,
    password: process.env.GATEWAY_PASSWORD,
    allowedOrigins,
    secureCookies: process.env.COOKIE_SECURE === '1',
    sessionTtlMs: process.env.SESSION_TTL_HOURS
      ? Number(process.env.SESSION_TTL_HOURS) * 3_600_000
      : undefined,
  });
} else if (insecureDev) {
  console.warn(
    'PI_GATEWAY_INSECURE_DEV=1: authentication is DISABLED. Local development only.'
  );
} else {
  console.warn(
    'No GATEWAY_PASSWORD set: all protected routes will deny access.'
  );
}
const authenticate = (req: { headers: { cookie?: string } }): boolean =>
  auth ? auth.authenticate(req) : insecureDev;

// Explicit allowlist: no permissive CORS default.
app.use(cors({ origin: allowedOrigins, credentials: true }));
// Requests are small JSON; chat traffic goes over the WebSocket.
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Liveness: the process is up. Readiness: it could actually start a worker.
// Unauthenticated, so neither says why; failures go to the log.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
app.get('/health/ready', async (_req, res) => {
  const failures = await readinessFailures({
    piCli,
    dataRoot,
    files: skills,
  });
  if (failures.length > 0) {
    console.error('Not ready:', failures.join('; '));
    res.status(503).json({ status: 'unavailable' });
    return;
  }
  res.json({ status: 'ready' });
});

if (auth) {
  app.use('/api/auth', auth.router);
} else {
  const unconfigured = express.Router();
  unconfigured.get('/session', (_req, res) => {
    if (insecureDev) res.json({ authenticated: true, insecure: true });
    else res.status(401).json({ authenticated: false });
  });
  unconfigured.post('/login', (_req, res) => {
    res.status(503).json({ error: 'Authentication is not configured' });
  });
  unconfigured.post('/logout', (_req, res) => res.status(204).end());
  app.use('/api/auth', unconfigured);
}

// --- Pi gateway -----------------------------------------------------------
const gatewayManager = new ConversationManager({
  piCli,
  workspaceRoot: process.env.PI_WORKSPACE_DIR ?? `${dataRoot}/workspaces`,
  sessionRoot: process.env.PI_SESSION_DIR ?? `${dataRoot}/sessions`,
  metaRoot: process.env.PI_META_DIR,
  // Workers reach the internet only through this proxy (see server/egress-proxy.ts).
  env: process.env.PI_WORKER_PROXY
    ? {
        HTTP_PROXY: process.env.PI_WORKER_PROXY,
        HTTPS_PROXY: process.env.PI_WORKER_PROXY,
        http_proxy: process.env.PI_WORKER_PROXY,
        https_proxy: process.env.PI_WORKER_PROXY,
        NODE_USE_ENV_PROXY: '1',
      }
    : undefined,
  agentHome,
  skills,
  // Operator-defined only; a request can name a profile but never supply paths or
  // arguments. PI_EXTENSIONS replaces the profiles with one explicit list.
  ...(process.env.PI_EXTENSIONS
    ? { extensions: process.env.PI_EXTENSIONS.split(',').filter(Boolean) }
    : { profiles: DEFAULT_PROFILES, defaultProfile: 'full' }),
  uid: process.env.PI_AGENT_UID ? Number(process.env.PI_AGENT_UID) : undefined,
  gid: process.env.PI_AGENT_GID ? Number(process.env.PI_AGENT_GID) : undefined,
});
app.get('/api/pi/profiles', (req, res) => {
  if (!authenticate(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json(gatewayManager.launcher.listProfiles());
});
attachGateway(server, {
  manager: gatewayManager,
  allowedOrigins,
  authenticate,
});

// Scheduled runs live in the gateway, not the browser. Runs left in flight by
// a previous process are marked interrupted on startup and never re-run.
const scheduler = new Scheduler({
  dbPath: `${dataRoot}/scheduler.db`,
  executor: gatewayManager,
});
scheduler.start();
app.use(
  '/api/schedules',
  createScheduleRouter({ scheduler, allowedOrigins, authenticate })
);

// Provider sign-in through Pi's own SDK; credentials land in the agent home's auth.json.
mkdirSync(agentHome, { recursive: true, mode: 0o700 });
const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
const loginManager = new LoginManager(
  await ModelRuntime.create({
    authPath: `${resolve(agentHome)}/auth.json`,
    modelsPath: null,
    refreshOnCreate: false,
  })
);
app.use(
  '/api/pi',
  createLoginRouter({ login: loginManager, allowedOrigins, authenticate })
);

const shutdown = () => {
  loginManager.close();
  scheduler.close();
  auth?.close();
  void gatewayManager.stopAll().finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

// Static frontend for the single-container deployment. The SPA fallback never
// answers API or socket paths. No app-wide CSP: the canvas iframe is a srcdoc
// document, which inherits its parent's policy, and sets its own strict one.
const staticDir = process.env.STATIC_DIR;
if (staticDir && existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|gateway|health).*/, (_req, res) => {
    res.sendFile('index.html', { root: staticDir, maxAge: 0 });
  });
}

// Loopback by default; the container sets HOST=0.0.0.0 behind its proxy.
const HOST = process.env.HOST ?? '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
