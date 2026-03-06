import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class McpClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(serverPath: string) {
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverPath],
      env: process.env as Record<string, string>,
    });

    this.client = new Client(
      { name: 'CodeMode-CLI-Agent', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
  }

  async connect() {
    try {
      await this.client.connect(this.transport);

      const tools = await this.client.listTools();
      console.error(
        'Connected to server with tools:',
        tools.tools.map((t) => t.name)
      );

      return this.client;
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      throw error;
    }
  }

  async close() {
    await this.client.close();
  }
}

/**
 * Compatibility function to match your original createMcpClient signature
 */
export async function createMcpClient() {
  const wrapper = new McpClient('./server/mcp-server.ts');
  return await wrapper.connect();
}
