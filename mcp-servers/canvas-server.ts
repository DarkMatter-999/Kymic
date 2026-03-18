import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const server = new McpServer({
  name: 'Canvas-Server',
  version: '1.0.0',
});

const redisPublisher = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publishEvent = (conversationId: string, event: any) => {
  redisPublisher.publish(
    `conversation:${conversationId}`,
    JSON.stringify(event)
  );
};

server.registerTool(
  'update_canvas',
  {
    description:
      'Create or update an HTML/CSS/JS playground to show interactive elements to the user inside an iframe.',
    inputSchema: {
      html: z
        .string()
        .describe(
          'The HTML markup for the canvas/playground. Do not include <html> or <body> tags, just the content.'
        ),
      css: z
        .string()
        .optional()
        .describe('The CSS styling for the canvas/playground.'),
      js: z
        .string()
        .optional()
        .describe('The JavaScript code for the canvas/playground.'),
      conversationId: z
        .string()
        .optional()
        .describe('Injected conversation ID context.'),
    },
  },
  async ({ html, css, js, conversationId }) => {
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

    // Publish the canvas update event to the frontend
    publishEvent(conversationId, {
      type: 'canvas_update',
      content: {
        html,
        css: css || '',
        js: js || '',
      },
    });

    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: 'Successfully pushed code to the interactive canvas.',
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in Canvas-Server:', error);
  process.exit(1);
});
