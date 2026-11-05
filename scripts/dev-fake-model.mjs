// Local-only helper: a fake OpenAI-compatible model plus a Pi agent home that uses it.
// Lets you try the GUI without any provider login. Replies echo your last message.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startFakeModel } from '../tests/fixtures/fake-model.mjs';

const home = resolve(process.env.PI_AGENT_HOME ?? '.pi-data/agent-home');
const port = Number(process.env.FAKE_MODEL_PORT ?? 4010);
const lastUser = (req) => {
  const m = [...req.messages].reverse().find((x) => x.role === 'user');
  const c = m?.content;
  return typeof c === 'string'
    ? c
    : (c ?? []).map((b) => b.text ?? '').join('');
};
const model = await startFakeModel([], {
  port,
  fallback: (req) => ({ text: `You said: ${lastUser(req)}`, chunkDelayMs: 60 }),
});
await mkdir(home, { recursive: true });
await writeFile(resolve(home, 'models.json'), model.modelsJson());
await writeFile(
  resolve(home, 'settings.json'),
  JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' })
);
await writeFile(
  resolve(home, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      spike: {
        command: process.execPath,
        args: [resolve('tests/fixtures/mcp/spike-server.mjs')],
      },
    },
  })
);
console.log(`fake model on ${model.url}; agent home ${home}`);
