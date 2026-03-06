import express from 'express';
import cors from 'cors';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, convertToModelMessages, tool } from 'ai';
import type { ToolSet, UIMessage } from 'ai';
import dotenv from 'dotenv';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { systemPrompt } from './prompt';
import { localNodeExecutor } from './executor';
import z from 'zod';
import { createMcpClient } from './mcp-client';

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

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body as { messages: UIMessage[] };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

  try {
    const modelMessages = await convertToModelMessages(messages);

    const mcpClient = await createMcpClient();
    const serverToolsList = await mcpClient.listTools();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mappedTools: Record<string, any> = {};
    for (const t of serverToolsList.tools) {
      mappedTools[t.name] = tool({
        description: t.description || `Execute the ${t.name} capability.`,
        inputSchema: z.any(),
        execute: async (args) => {
          return await mcpClient.callTool({ name: t.name, arguments: args });
        },
      });
    }

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
      maxSteps: 7,
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
