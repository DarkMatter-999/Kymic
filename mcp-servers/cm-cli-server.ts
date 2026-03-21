import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import process from 'node:process';
import os from 'node:os';

const MAX_LENGTH = 10000;
const execAsync = promisify(exec);

const server = new McpServer({
  name: 'CodeMode-Local-Server',
  version: '1.0.0',
});

function resolvePath(targetPath: string, cwd?: string): string {
  const base = cwd || os.tmpdir();
  return path.resolve(base, targetPath);
}

server.registerTool(
  'read_file',
  {
    description:
      'Read the contents of a local file. Relative paths resolve to the OS temp directory by default.',
    inputSchema: {
      path: z.string().describe('The absolute or relative path to the file'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Optional working directory to resolve relative paths. Defaults to OS temp dir.'
        ),
    },
  },
  async ({ path: inputPath, cwd }) => {
    try {
      const finalPath = resolvePath(inputPath, cwd);
      const text = fs.readFileSync(finalPath, 'utf-8');
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
    description:
      'Write or overwrite a local file. Relative paths resolve to the OS temp directory by default.',
    inputSchema: {
      path: z.string().describe('Path where the file should be saved'),
      content: z.string().describe('The text content to write'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Optional working directory to resolve relative paths. Defaults to OS temp dir.'
        ),
    },
  },
  async ({ path: inputPath, content, cwd }) => {
    try {
      const finalPath = resolvePath(inputPath, cwd);
      fs.writeFileSync(finalPath, content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Successfully wrote to ${finalPath}` }],
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
    description:
      'Modify an existing file using string replacement. Relative paths resolve to the OS temp directory by default.',
    inputSchema: {
      path: z.string().describe('Path to the file'),
      oldText: z.string().describe('Exact text to find'),
      newText: z.string().describe('Text to replace it with'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Optional working directory to resolve relative paths. Defaults to OS temp dir.'
        ),
    },
  },
  async ({ path: inputPath, oldText, newText, cwd }) => {
    try {
      const finalPath = resolvePath(inputPath, cwd);
      const content = fs.readFileSync(finalPath, 'utf-8');
      if (!content.includes(oldText)) {
        return {
          isError: true,
          content: [
            { type: 'text', text: 'Error: oldText not found in file.' },
          ],
        };
      }
      fs.writeFileSync(finalPath, content.replace(oldText, newText), 'utf-8');
      return {
        content: [{ type: 'text', text: `Successfully updated ${finalPath}` }],
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
    description:
      'Run a shell command. The working directory defaults to the OS temp directory if not provided.',
    inputSchema: {
      command: z.string().describe('The base command to run'),
      args: z.array(z.string()).optional().describe('Optional arguments'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory. Defaults to OS temp dir.'),
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
        cwd: cwd || os.tmpdir(),
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
      'List files matching a glob pattern. The working directory defaults to the OS temp directory if not provided. Returns a JSON string with "files" and "count".',
    inputSchema: {
      pattern: z.string().describe('Glob pattern (e.g. src/**/*.ts)'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory. Defaults to OS temp dir.'),
    },
  },
  async ({ pattern, cwd }) => {
    try {
      const files = await glob(pattern, {
        nodir: true,
        cwd: cwd || os.tmpdir(),
      });
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
