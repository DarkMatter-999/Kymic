import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execAsync = promisify(exec);

const server = new McpServer({
  name: 'CodeMode-Local-Server',
  version: '1.0.0',
});

server.registerTool(
  'read_file',
  {
    description: 'Read the contents of a local file.',
    inputSchema: {
      path: z.string().describe('The absolute or relative path to the file'),
    },
  },
  async ({ path }) => {
    try {
      const content = fs.readFileSync(path, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Error reading file: ${error.message}` },
        ],
      };
    }
  }
);

server.registerTool(
  'write_file',
  {
    description: 'Write or overwrite a local file.',
    inputSchema: {
      path: z.string().describe('Path where the file should be saved'),
      content: z.string().describe('The text content to write'),
    },
  },
  async ({ path, content }) => {
    try {
      fs.writeFileSync(path, content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Successfully wrote to ${path}` }],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Error writing file: ${error.message}` },
        ],
      };
    }
  }
);

server.registerTool(
  'run_command',
  {
    description: 'Run a shell command.',
    inputSchema: {
      command: z.string().describe('The base command to run'),
      args: z
        .array(z.string())
        .optional()
        .describe('Optional arguments for the command'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory to run the command in'),
    },
  },
  async ({ command, args, cwd }) => {
    try {
      let commandStr = command;
      if (args && args.length > 0) {
        const escapedArgs = args.map(
          (a) => `"${String(a).replace(/"/g, '\\"')}"`
        );
        commandStr += ' ' + escapedArgs.join(' ');
      }

      const workingDir = cwd || process.cwd();
      const { stdout, stderr } = await execAsync(commandStr, {
        cwd: workingDir,
      });

      return {
        content: [
          { type: 'text', text: `STDOUT:\n${stdout}\nSTDERR:\n${stderr}` },
        ],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Command failed: ${error.message}` }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CodeMode Local Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
