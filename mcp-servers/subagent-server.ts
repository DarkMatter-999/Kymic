import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { streamText, stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import dotenv from 'dotenv';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { localNodeExecutor } from '../server/executor';
import { McpManager } from '../server/mcp-manager';

dotenv.config();

const provider = createOpenAICompatible({
  name: 'OpenAI-Compatible Provider',
  apiKey: process.env.API_KEY ?? '',
  baseURL: process.env.API_URL ?? '',
});
const MODEL_NAME = process.env.MODEL_NAME ?? 'default-model';

const redisPublisher = new Redis(
  process.env.REDIS_URL ?? 'redis://localhost:6379'
);

const server = new McpServer({
  name: 'Subagent-Server',
  version: '1.0.0',
});

const subagentMcpManager = new McpManager();
await subagentMcpManager.registerServer({
  name: 'CodeMode-CLI',
  path: './mcp-servers/cm-cli-server.ts',
  version: '1.0.0',
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publishEvent = (conversationId: string, event: any) => {
  redisPublisher.publish(
    `conversation:${conversationId}`,
    JSON.stringify(event)
  );
};

server.registerTool(
  'run_subagent',
  {
    description:
      'Runs a subagent loop to solve a specific task. Use this to delegate complex work to an autonomous subagent.',
    inputSchema: {
      systemPrompt: z
        .string()
        .default(
          'You are a helpful and precise assistant for solving the following task. Use tools as needed, and think step by step.'
        )
        .describe(
          'The system prompt defining the persona and constraints for the subagent.'
        ),
      task: z
        .string()
        .describe(
          'The specific, detailed task the subagent should accomplish.'
        ),
      conversationId: z.string().optional(),
    },
  },
  async ({ systemPrompt, task, conversationId }) => {
    if (!conversationId) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: missing injected conversationId context.',
          },
        ],
      };
    }

    const subagentId = uuidv4();

    publishEvent(conversationId, {
      type: 'subagent_started',
      subagentId,
      task,
    });

    const mappedTools = await subagentMcpManager.getAllMappedTools();

    const codemodeTool = createCodeTool({
      tools: mappedTools,
      executor: localNodeExecutor,
    });

    try {
      const result = streamText({
        model: provider.chatModel(MODEL_NAME),
        system: systemPrompt,
        prompt: task,
        tools: {
          codemode: codemodeTool,
        },
        maxRetries: 4,
        stopWhen: stepCountIs(10),
      });

      let fullText = '';
      let isToolCalling = false;

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          fullText += chunk.text;
          publishEvent(conversationId, {
            type: 'subagent_update',
            subagentId,
            text: fullText,
          });
        } else if (chunk.type === 'tool-call') {
          if (!isToolCalling) {
            isToolCalling = true;
            publishEvent(conversationId, {
              type: 'subagent_tool_start',
              subagentId,
            });
          }
        } else if (chunk.type === 'tool-result') {
          isToolCalling = false;
        }
      }

      const finalResponse = await result.text;

      publishEvent(conversationId, {
        type: 'subagent_finished',
        subagentId,
        result: finalResponse,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Subagent ${subagentId} finished successfully. Result:\n${finalResponse}`,
          },
        ],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      publishEvent(conversationId, {
        type: 'subagent_error',
        subagentId,
        error: error.message || 'Unknown error occurred in subagent',
      });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Subagent ${subagentId} failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
