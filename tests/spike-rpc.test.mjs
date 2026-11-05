import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';

test('Pi RPC discovers the explicitly supplied spike skill', { timeout: 15000 }, async () => {
  const home = await mkdtemp('/tmp/opencode/pi-rpc-test-');
  const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const skill = resolve('skills/spike/SKILL.md');
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--skill', skill, '--no-context-files', '--offline'], {
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, PI_TELEMETRY: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const response = new Promise((resolveResponse, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Pi exited before response (${code}): ${stderr}`)));
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const record = JSON.parse(line);
          if (record.id === 'commands') resolveResponse(record);
        } catch (error) { reject(error); }
      }
    });
  });
  try {
    child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
    const result = await response;
    assert.equal(result.success, true);
    assert.ok(result.data.commands.some((command) => command.name === 'skill:spike' && command.source === 'skill'));
  } finally {
    child.stdin.end();
    child.kill();
  }
});
