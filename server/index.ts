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
import { McpManager, type ServerConfig } from './mcp-manager';
import { getModel } from './provider';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(cors());
app.use(express.json());

const mcpManager = new McpManager();
const servers: ServerConfig[] = [
  {
    name: 'CodeMode-CLI',
    path: './mcp-servers/cm-cli-server.ts',
    version: '1.0.0',
  },
  {
    name: 'Subagent-Server',
    path: './mcp-servers/subagent-server.ts',
    version: '1.0.0',
  },
];

const setupMcp = async () => {
  console.log('Initializing MCP Servers...');
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
const wss = new WebSocketServer({ server });
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
  process.env.REDIS_URL ?? 'redis://localhost:6379'
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
