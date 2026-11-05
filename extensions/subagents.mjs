// Pi extension: run_subagent delegates a task to a child Pi process.
//
// The child is a separate, ephemeral `pi --mode json` process with the same
// working directory and environment as this worker (so it has the same user,
// filesystem and credential limits). It never gets this extension, so subagents
// cannot spawn subagents. Progress is reported as structured tool updates; the
// gateway turns those into subagent events for the conversation that ran the tool.
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

const MAX_CONCURRENT = 4;
const TIMEOUT_MS = 10 * 60_000;
const MAX_TEXT = 50_000;
const MAX_TASK = 20_000;
const UPDATE_INTERVAL_MS = 150;
const KILL_GRACE_MS = 3000;
let active = 0;

const textOf = (message) =>
  (Array.isArray(message?.content) ? message.content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

export default function (pi) {
  pi.registerTool({
    name: 'run_subagent',
    label: 'Run subagent',
    description:
      'Delegate a self-contained task to an autonomous subagent and get its final answer. ' +
      'Several calls in one turn run in parallel. The subagent has no memory of this conversation: ' +
      'put everything it needs in the task.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The detailed task.' },
        systemPrompt: {
          type: 'string',
          description: 'Optional persona and constraints.',
        },
      },
      required: ['task'],
    },
    async execute(toolCallId, params, signal, onUpdate) {
      const task = typeof params.task === 'string' ? params.task : '';
      if (!task || task.length > MAX_TASK)
        throw new Error(`task must be 1-${MAX_TASK} characters`);
      const systemPrompt =
        typeof params.systemPrompt === 'string' && params.systemPrompt
          ? params.systemPrompt.slice(0, MAX_TASK)
          : 'You are a precise assistant solving one delegated task. Think step by step and finish with a clear final answer.';
      const cli = process.argv[1];
      if (!cli || basename(cli) !== 'cli.js')
        throw new Error('Cannot locate the Pi CLI to start a subagent');
      if (active >= MAX_CONCURRENT)
        throw new Error(
          `At most ${MAX_CONCURRENT} subagents can run at once; try again when one finishes`
        );

      const view = {
        id: toolCallId,
        task: task.slice(0, 500),
        state: 'running',
      };
      const report = (extra) => {
        Object.assign(view, extra);
        onUpdate?.({
          content: [{ type: 'text', text: view.state }],
          details: { subagent: { ...view } },
        });
      };
      const done = (state, extra = {}) => ({
        content: [
          {
            type: 'text',
            text:
              state === 'finished'
                ? extra.result || '(the subagent produced no text)'
                : `Subagent ${state}${extra.error ? `: ${extra.error}` : ''}`,
          },
        ],
        details: { subagent: { ...view, state, ...extra } },
      });

      active++;
      report({});
      const child = spawn(
        process.execPath,
        [
          cli,
          '--mode',
          'json',
          '-p',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-context-files',
          '--extension',
          'builtin:mcp',
          '--extension',
          'builtin:codemode',
          '--tools',
          '+codemode',
          '--system-prompt',
          systemPrompt,
          '--',
          task,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stderr = '';
      let lastText = '';
      let streamed = '';
      let timedOut = false;
      let lastReport = 0;
      let pending = null;
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-2000);
      });

      const handle = (event) => {
        if (event.type === 'message_update') {
          const m = event.assistantMessageEvent;
          if (m?.type === 'text_delta') {
            streamed = (streamed + String(m.delta)).slice(-MAX_TEXT);
            const now = Date.now();
            if (now - lastReport >= UPDATE_INTERVAL_MS) {
              lastReport = now;
              report({ state: 'running', text: streamed });
            }
          }
        } else if (event.type === 'tool_execution_start') {
          lastReport = Date.now();
          report({ state: 'tool_call', text: streamed });
        } else if (event.type === 'tool_execution_end') {
          report({ state: 'running', text: streamed });
        } else if (
          event.type === 'message_end' &&
          event.message?.role === 'assistant'
        ) {
          const t = textOf(event.message);
          if (t) lastText = t.slice(0, MAX_TEXT);
          if (
            event.message.stopReason === 'error' &&
            event.message.errorMessage
          )
            pending = String(event.message.errorMessage).slice(0, 500);
          streamed = '';
        }
      };

      let buffer = '';
      child.stdout.on('data', (d) => {
        buffer += d;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          try {
            handle(JSON.parse(line));
          } catch {
            // Non-JSON noise on stdout is ignored.
          }
        }
        if (buffer.length > 1_000_000) buffer = '';
      });

      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, TIMEOUT_MS);
      const onAbort = () => kill();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const code = await new Promise((resolve) => {
          child.once('error', (e) => {
            stderr = String(e.message);
            resolve(-1);
          });
          child.once('close', (c) => resolve(c));
        });
        if (signal?.aborted) return done('cancelled');
        if (timedOut) return done('error', { error: 'Timed out' });
        if (code !== 0)
          return done('error', {
            error: (pending || stderr.trim() || `exit code ${code}`).slice(
              0,
              500
            ),
          });
        if (pending && !lastText) return done('error', { error: pending });
        return done('finished', { result: lastText });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        active--;
      }
    },
  });
}
