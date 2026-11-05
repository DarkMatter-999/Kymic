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
import { Scheduler } from './scheduler/scheduler';
import { createScheduleRouter } from './scheduler/http';
import { mkdirSync } from 'node:fs';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(cors());
app.use(express.json({ limit: '16mb' }));

const mcpManager = new McpManager();

const setupMcp = async () => {
  console.log('Initializing MCP Servers...');
  const servers = getMcpServersConfig();
  await Promise.all(servers.map((s) => mcpManager.registerServer(s)));
  console.log('MCP Servers Ready.');
};

setupMcp().catch(console.error);

app.post('/api/chat', async (req, res) => {
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

    const mappedTools = await mcpManager.getAllMappedTools({ conversationId });

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
});

// WebSocket Setup
// Legacy canvas/subagent socket stays on '/'; the Pi gateway owns '/gateway'.
// ws's own `path` option would 400 every other path, so route upgrades by hand.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
  if (pathname === '/') {
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

// Pi gateway (spike). Disabled unless PI_GATEWAY=1. There is no real authentication
// until the auth milestone, so connections are denied unless PI_GATEWAY_INSECURE_DEV=1.
if (process.env.PI_GATEWAY === '1') {
  const dataRoot = process.env.PI_DATA_DIR ?? './.pi-data';
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
    uid: process.env.PI_AGENT_UID
      ? Number(process.env.PI_AGENT_UID)
      : undefined,
    gid: process.env.PI_AGENT_GID
      ? Number(process.env.PI_AGENT_GID)
      : undefined,
  });
  const insecureDev = process.env.PI_GATEWAY_INSECURE_DEV === '1';
  if (!insecureDev) {
    console.warn(
      'Pi gateway enabled but no authentication exists yet: all connections will be denied. Set PI_GATEWAY_INSECURE_DEV=1 for local development only.'
    );
  }
  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
  ).split(',');
  attachGateway(server, {
    manager: gatewayManager,
    allowedOrigins,
    authenticate: () => insecureDev,
    passthrough: true,
  });

  // Scheduled runs live in the gateway, not the browser. Runs left in flight by
  // a previous process are marked interrupted on startup and never re-run.
  mkdirSync(dataRoot, { recursive: true });
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
      authenticate: () => insecureDev,
    })
  );
  const shutdown = () => {
    scheduler.close();
    void gatewayManager.stopAll().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
