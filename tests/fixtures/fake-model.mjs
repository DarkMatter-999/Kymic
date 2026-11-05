// Scriptable OpenAI-compatible chat-completions server for deterministic Pi tests.
// Each queued turn is { text } or { toolCalls: [{ name, arguments }] }. Requests are recorded.
import { createServer } from 'node:http';

export async function startFakeModel(
  script = [],
  { fallback, port: listenPort = 0, host = '127.0.0.1' } = {}
) {
  const queue = [...script];
  const requests = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const turn = queue.shift() ??
        fallback?.(parsed) ?? { text: 'fake-model: script exhausted' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            created: 0,
            model: parsed.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        );
      send({ role: 'assistant' });
      if (turn.toolCalls) {
        turn.toolCalls.forEach((call, index) =>
          send({
            tool_calls: [
              {
                index,
                id: `call_${requests.length}_${index}`,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments ?? {}),
                },
              },
            ],
          })
        );
        send({}, 'tool_calls');
      } else {
        for (const piece of turn.text.match(/.{1,8}/gs) ?? ['']) {
          if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
          if (res.destroyed) return;
          send({ content: piece });
        }
        send({}, 'stop');
      }
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    queue,
    modelsJson: () =>
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            apiKey: 'fake-key',
            models: [
              {
                id: 'fake-1',
                name: 'Fake 1',
                contextWindow: 32000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
