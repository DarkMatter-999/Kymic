import express from 'express';
import cors from 'cors';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, convertToModelMessages } from 'ai';
import type { ToolSet, UIMessage } from 'ai';
import dotenv from 'dotenv';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { systemPrompt } from './prompt';
import { localNodeExecutor } from './executor';
import { McpManager, type ServerConfig } from './mcp-manager';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

const provider = createOpenAICompatible({
  name: 'OpenAI-Compatible Provider',
  apiKey: process.env.API_KEY ?? '',
  baseURL: process.env.API_URL ?? '',
  includeUsage: true,
});

const MODEL_NAME = process.env.MODEL_NAME ?? 'default-model';

const mcpManager = new McpManager();
const servers: ServerConfig[] = [
  {
    name: 'CodeMode-CLI',
    path: './mcp-servers/cm-cli-server.ts',
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
  const { messages } = req.body as { messages: UIMessage[] };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

  try {
    const modelMessages = await convertToModelMessages(messages);

    const mappedTools = await mcpManager.getAllMappedTools();

    const codemodeTool = createCodeTool({
      tools: mappedTools,
      executor: localNodeExecutor,
    });

    const tools: ToolSet = {
      codemode: codemodeTool,
    };

    const result = streamText({
      model: provider.chatModel(MODEL_NAME),
      system: systemPrompt,
      messages: modelMessages,
      tools,
      maxSteps: 10,
      maxRetries: 3,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      experimental_retry: async ({ error, attempt, delayBase }) => {
        // Only retry on 429 or network errors
        const isRateLimit =
          error instanceof Error && error.message.includes('429');

        if (isRateLimit || attempt <= 3) {
          const delay = 15000 * Math.pow(2, attempt - 1);
          console.log(
            `Rate limited. Attempt ${attempt}. Retrying in ${delay / 1000}s...`
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
          return true;
        }
        return false;
      },
    });

    result.pipeUIMessageStreamToResponse(res);
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Failed to stream response' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
