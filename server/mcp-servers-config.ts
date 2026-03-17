import type { ServerConfig } from './mcp-manager';

/**
 * MCP Servers configuration
 * Define all MCP servers that should be registered in the application
 */
export const mcpServersConfig: ServerConfig[] = [
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

/**
 * Get MCP servers configuration excluding specified servers
 * @param excludeServers - Array of server names to exclude from the configuration
 * @returns Filtered array of server configurations
 */
export const getMcpServersConfig = (
  excludeServers: string[] = []
): ServerConfig[] => {
  return mcpServersConfig.filter(
    (server) => !excludeServers.includes(server.name)
  );
};
