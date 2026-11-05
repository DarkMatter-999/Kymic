import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { ConversationManager } from '../server/gateway/conversations.ts';
import { attachGateway } from '../server/gateway/ws.ts';
import { GatewayClient } from '../src/chat/gateway.ts';
import { initialState, reduce } from '../src/chat/reducer.ts';
import { startFakeModel } from './fixtures/fake-model.mjs';

// The model's decisions are scripted; codemode, the MCP server and Pi's skill
// handling are real. This does NOT show that a real model chooses to use them.
const ORIGIN = 'https://agents.example.test';
let root, model, manager, server, client;

afterEach(async () => {
  client?.close();
  await manager?.stopAll();
  await model?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  if (root) await rm(root, { recursive: true, force: true });
  client = manager = model = server = root = undefined;
});

const until = async (check, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

test(
  'GUI path: codemode calls the MCP fixture and /skill:spike loads the skill',
  { timeout: 90000 },
  async () => {
    root = await mkdtemp(join(tmpdir(), 'demo-'));
    model = await startFakeModel([
      {
        toolCalls: [
          {
            name: 'codemode',
            arguments: {
              code: 'const r = await tools.mcp__spike__spike_marker({});\nreturn r.content[0].text;',
            },
          },
        ],
      },
      { text: 'The MCP marker was retrieved.' },
    ]);
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'models.json'), model.modelsJson());
    await writeFile(
      join(root, 'home', 'settings.json'),
      JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
    );
    await writeFile(
      join(root, 'home', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          spike: {
            command: process.execPath,
            args: [resolve('tests/fixtures/mcp/spike-server.mjs')],
          },
        },
      })
    );
    manager = new ConversationManager({
      piCli: resolve(
        'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
      ),
      workspaceRoot: join(root, 'ws'),
      sessionRoot: join(root, 'sessions'),
      agentHome: join(root, 'home'),
      skills: [resolve('skills/spike/SKILL.md')],
    });
    server = createServer();
    attachGateway(server, { manager, allowedOrigins: [ORIGIN] });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));

    let state = initialState;
    client = new GatewayClient({
      url: `ws://127.0.0.1:${server.address().port}/gateway`,
      conversationId: 'demo',
      createSocket: (u) => new WebSocket(u, { headers: { origin: ORIGIN } }),
      onEvent: (e) => {
        state = reduce(state, e);
      },
    });
    client.connect();
    await until(() => client.connected);
    client.prompt('/skill:spike fetch the marker');
    await until(
      () =>
        !state.running &&
        state.messages.some((m) =>
          m.parts.some((p) => p.text === 'The MCP marker was retrieved.')
        )
    );

    // Real codemode -> real MCP server, rendered as the existing tool-call part.
    const tool = state.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-codemode');
    assert.ok(tool, 'codemode tool part rendered');
    assert.match(tool.input.code, /mcp__spike__spike_marker/);
    assert.match(tool.output.result, /Script completed/);
    assert.match(tool.output.result, /PI_SPIKE_MCP_MARKER/);
    assert.equal(tool.errorText, undefined);

    // The tool result reached the model on its next request.
    assert.ok(
      JSON.stringify(model.requests[1].messages).includes('PI_SPIKE_MCP_MARKER')
    );

    // Pi's skill handling: listed in the system prompt and expanded for /skill:spike.
    const [first] = model.requests;
    assert.ok(JSON.stringify(first.messages[0]).includes('available_skills'));
    assert.ok(JSON.stringify(first.messages[0]).includes('spike'));
    const userText = JSON.stringify(first.messages.at(-1));
    assert.match(userText, /<skill name=\\"spike\\"/);
    assert.match(userText, /PI_SPIKE_SKILL_MARKER/);

    // The chat shows the user's literal text; history came from events, not replay.
    assert.equal(state.messages[0].role, 'user');
  }
);
