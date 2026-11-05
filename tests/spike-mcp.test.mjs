import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('spike MCP server exposes a deterministic read-only marker', async () => {
  const client = new Client({ name: 'spike-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['tests/fixtures/mcp/spike-server.mjs'],
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(
      tools.find((tool) => tool.name === 'spike_marker')?.annotations
        ?.readOnlyHint,
      true
    );
    const result = await client.callTool({
      name: 'spike_marker',
      arguments: {},
    });
    assert.deepEqual(result.content, [
      { type: 'text', text: 'PI_SPIKE_MCP_MARKER' },
    ]);
  } finally {
    await client.close();
  }
});

test('Pi 1.5 discovers the allowlisted MCP fixture in an isolated configuration', async () => {
  const home = await mkdtemp('/tmp/opencode/pi-mcp-test-');
  await writeFile(
    join(home, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        spike: {
          command: process.execPath,
          args: [resolve('tests/fixtures/mcp/spike-server.mjs')],
        },
      },
    })
  );
  const cli = resolve(
    'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [cli, 'mcp', 'list'],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: home,
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
      },
      timeout: 15000,
    }
  );
  assert.match(stdout, /spike/);
  assert.match(stdout, /spike_marker/);
});
