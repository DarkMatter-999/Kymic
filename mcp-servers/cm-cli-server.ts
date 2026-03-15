import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { glob } from 'glob';

const MAX_LENGTH = 10000;
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
      const text = fs.readFileSync(path, 'utf-8');
      if (text.length > MAX_LENGTH) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: File too large. Truncated:\n\n${text.slice(0, MAX_LENGTH)}`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text }], isError: false };
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
        isError: false,
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
  'edit_file',
  {
    description: 'Modify an existing file using string replacement.',
    inputSchema: {
      path: z.string().describe('Path to the file'),
      oldText: z.string().describe('Exact text to find'),
      newText: z.string().describe('Text to replace it with'),
    },
  },
  async ({ path, oldText, newText }) => {
    try {
      const content = fs.readFileSync(path, 'utf-8');
      if (!content.includes(oldText)) {
        return {
          isError: true,
          content: [
            { type: 'text', text: 'Error: oldText not found in file.' },
          ],
        };
      }
      fs.writeFileSync(path, content.replace(oldText, newText), 'utf-8');
      return {
        content: [{ type: 'text', text: `Successfully updated ${path}` }],
        isError: false,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Error editing file: ${error.message}` },
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
      args: z.array(z.string()).optional().describe('Optional arguments'),
      cwd: z.string().optional().describe('Working directory'),
    },
  },
  async ({ command, args, cwd }) => {
    try {
      let commandStr = command;
      if (args?.length) {
        commandStr +=
          ' ' +
          args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
      }
      const { stdout, stderr } = await execAsync(commandStr, {
        cwd: cwd || process.cwd(),
      });
      const output = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
      return {
        content: [{ type: 'text', text: output.slice(0, MAX_LENGTH) }],
        isError: false,
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

server.registerTool(
  'list_files',
  {
    description:
      'List files matching a glob pattern. Returns a JSON string with "files" and "count".',
    inputSchema: {
      pattern: z.string().describe('Glob pattern (e.g. src/**/*.ts)'),
    },
  },
  async ({ pattern }) => {
    try {
      const files = await glob(pattern, { nodir: true });
      if (JSON.stringify(files).length > MAX_LENGTH) {
        return {
          isError: true,
          content: [
            { type: 'text', text: 'Error: File list exceeds maximum length.' },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ files, count: files.length }),
          },
        ],
        isError: false,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: error.message, files: [], count: 0 }),
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

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
