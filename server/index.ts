import express from 'express';
import cors from 'cors';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import type { ModelMessage, UIMessage } from 'ai';
import dotenv from 'dotenv';
import { systemPrompt } from './prompt';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

const provider = createOpenAICompatible({
  name: 'OpenAI-Compatible Provider',
  apiKey: process.env.API_KEY ?? '',
  baseURL: process.env.API_URL ?? '',
  includeUsage: true,
});

const MODEL_NAME = process.env.MODEL_NAME ?? 'default-model';

function uiMessagesToModelMessages(messages: UIMessage[]): ModelMessage[] {
  return messages.flatMap((msg): ModelMessage[] => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return [];

    const textContent = msg.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');

    if (!textContent) return [];

    return [{ role: msg.role, content: textContent }];
  });
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body as { messages: UIMessage[] };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

  try {
    const modelMessages = uiMessagesToModelMessages(messages);

    const result = streamText({
      model: provider.chatModel(MODEL_NAME),
      system: systemPrompt,
      messages: modelMessages,
    });

    result.pipeUIMessageStreamToResponse(res);
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Failed to stream response' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
