import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import cors from 'cors';
import { streamText, convertToModelMessages } from 'ai';
import type { ToolSet, UIMessage } from 'ai';
import dotenv from 'dotenv';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { systemPrompt } from './prompt';
import { localNodeExecutor } from './executor';
import { McpManager } from './mcp-manager';
import { getModel } from './provider';
import { getMcpServersConfig } from './mcp-servers-config';
import { ConversationManager } from './gateway/conversations';
import { attachGateway } from './gateway/ws';
import { Auth } from './gateway/auth';
import { LoginManager, createLoginRouter } from './gateway/login';
import { Scheduler } from './scheduler/scheduler';
import { createScheduleRouter } from './scheduler/http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const gatewayEnabled = process.env.PI_GATEWAY === '1';
// The old AI-SDK agent path. Off by default; when on it still requires login.
const legacyEnabled = process.env.LEGACY_AGENT === '1';
const dataRoot = process.env.PI_DATA_DIR ?? './.pi-data';
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
).split(',');

// --- Authentication -------------------------------------------------------
// GATEWAY_PASSWORD enables login. PI_GATEWAY_INSECURE_DEV=1 disables auth for
// local development only. With neither, every protected route denies access.
const insecureDev = process.env.PI_GATEWAY_INSECURE_DEV === '1';
let auth: Auth | undefined;
if (gatewayEnabled || legacyEnabled) {
  mkdirSync(dataRoot, { recursive: true });
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
}
const authenticate = (req: { headers: { cookie?: string } }): boolean =>
  auth ? auth.authenticate(req) : insecureDev;

// Explicit allowlist: no permissive CORS default.
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '16mb' }));

if (auth) {
  app.use('/api/auth', auth.router);
} else if (gatewayEnabled || legacyEnabled) {
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

if (legacyEnabled) {
  const mcpManager = new McpManager();

  const setupMcp = async () => {
    console.log('Initializing MCP Servers...');
    const servers = getMcpServersConfig();
    await Promise.all(servers.map((s) => mcpManager.registerServer(s)));
    console.log('MCP Servers Ready.');
  };

  setupMcp().catch(console.error);

  app.post(
    '/api/chat',
    (req, res, next) => {
      if (authenticate(req)) next();
      else res.status(401).json({ error: 'Unauthorized' });
    },
    async (req, res) => {
      const { messages, conversationId } = req.body as {
        messages: UIMessage[];
        conversationId?: string;
      };

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: 'messages array is required' });
        return;
      }

      try {
        const modelMessages = await convertToModelMessages(messages);

        const mappedTools = await mcpManager.getAllMappedTools({
          conversationId,
        });

        const codemodeTool = createCodeTool({
          tools: mappedTools,
          executor: localNodeExecutor,
        });

        const tools: ToolSet = {
          codemode: codemodeTool,
        };

        const result = streamText({
          model: getModel(),
          system: systemPrompt,
          messages: modelMessages,
          tools,
          maxRetries: 3,
        });

        result.pipeUIMessageStreamToResponse(res);
      } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: 'Failed to stream response' });
      }
    }
  );
}

// WebSocket Setup
// Legacy canvas/subagent socket stays on '/'; the Pi gateway owns '/gateway'.
// ws's own `path` option would 400 every other path, so route upgrades by hand.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
  if (pathname === '/') {
    const origin = req.headers.origin;
    if (
      !legacyEnabled ||
      !origin ||
      !allowedOrigins.includes(origin) ||
      !authenticate(req)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit('connection', ws, req)
    );
  } else if (pathname !== '/gateway') {
    socket.destroy();
  }
});
const wsClients = new Map<string, Set<WebSocket>>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const conversationId = url.searchParams.get('conversationId');

  if (!conversationId) {
    ws.close(1008, 'conversationId is required');
    return;
  }

  if (!wsClients.has(conversationId)) {
    wsClients.set(conversationId, new Set());
  }
  const clientSet = wsClients.get(conversationId)!;
  clientSet.add(ws);

  ws.on('close', () => {
    clientSet.delete(ws);
    if (clientSet.size === 0) {
      wsClients.delete(conversationId);
    }
  });
});

if (legacyEnabled) {
  // Redis Subscriber Setup
  const redisSubscriber = new Redis(
    process.env.REDIS_URL ?? 'redis://redis:6379'
  );

  redisSubscriber.psubscribe('conversation:*', (err, count) => {
    if (err) {
      console.error('Redis Subscribe Error:', err);
    } else {
      console.log(
        `Redis Subscribed to ${count} patterns (conversation channels)`
      );
    }
  });

  redisSubscriber.on('pmessage', (_pattern, channel, message) => {
    const match = channel.match(/^conversation:(.+)$/);
    if (match) {
      const conversationId = match[1];
      const clientSet = wsClients.get(conversationId);
      if (clientSet) {
        for (const ws of clientSet) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          }
        }
      }
    }
  });
}

// Pi gateway. Disabled unless PI_GATEWAY=1.
if (gatewayEnabled) {
  const gatewayManager = new ConversationManager({
    piCli:
      process.env.PI_CLI ??
      './node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    workspaceRoot: `${dataRoot}/workspaces`,
    sessionRoot: `${dataRoot}/sessions`,
    agentHome: process.env.PI_AGENT_HOME ?? `${dataRoot}/agent-home`,
    skills: (process.env.PI_SKILLS ?? './skills/spike/SKILL.md')
      .split(',')
      .filter(Boolean),
    // Operator allowlist only; never taken from a request. Unset keeps Pi's built-in
    // MCP and codemode extensions.
    extensions: process.env.PI_EXTENSIONS
      ? process.env.PI_EXTENSIONS.split(',').filter(Boolean)
      : undefined,
    uid: process.env.PI_AGENT_UID
      ? Number(process.env.PI_AGENT_UID)
      : undefined,
    gid: process.env.PI_AGENT_GID
      ? Number(process.env.PI_AGENT_GID)
      : undefined,
  });
  attachGateway(server, {
    manager: gatewayManager,
    allowedOrigins,
    authenticate,
    passthrough: true,
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
    createScheduleRouter({
      scheduler,
      allowedOrigins,
      authenticate,
    })
  );

  // Provider sign-in through Pi's own SDK; credentials land in the agent home's auth.json.
  const agentHome = process.env.PI_AGENT_HOME ?? `${dataRoot}/agent-home`;
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
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
