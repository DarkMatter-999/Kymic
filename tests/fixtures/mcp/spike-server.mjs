import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'spike', version: '1.0.0' });
server.registerTool(
  'spike_marker',
  {
    description: 'Return a fixed marker for the Pi gateway integration spike.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'text', text: 'PI_SPIKE_MCP_MARKER' }] })
);

await server.connect(new StdioServerTransport());
