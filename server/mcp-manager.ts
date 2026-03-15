import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tool } from 'ai';
import z from 'zod';

export interface ServerConfig {
  name: string;
  version: string;
  path: string;
  env?: Record<string, string>;
}

export class McpManager {
  private clients: Map<string, { client: Client; name: string }> = new Map();

  async registerServer(config: ServerConfig) {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', config.path],
      env: { ...process.env, ...config.env } as Record<string, string>,
    });

    const client = new Client(
      { name: config.name, version: config.version },
      { capabilities: {} }
    );

    await client.connect(transport);
    this.clients.set(config.name, { client, name: config.name });

    return { client, name: config.name };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAllMappedTools(context?: Record<string, any>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allTools: Record<string, any> = {};

    for (const [serverName, { client }] of this.clients) {
      const result = await client.listTools();

      for (const t of result.tools) {
        const sanitizedServerName = serverName.toLowerCase().replace(/-/g, '_');
        const toolKey = `${sanitizedServerName}.${t.name}`;

        allTools[toolKey] = tool({
          description: t.description,
          inputSchema: z.any(),
          execute: async (args) => {
            const mergedArgs = { ...args, ...context };
            const result = await client.callTool({
              name: t.name,
              arguments: mergedArgs,
            });
            return result;
          },
        });
      }
    }
    return allTools;
  }
}
