import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, messagesFromPi } from '../src/chat/reducer.ts';

const ev = (type, extra = {}) => ({
  v: 1,
  conversationId: 'c1',
  type,
  ...extra,
});
const run = (events, state = initialState) => events.reduce(reduce, state);

test('streams deltas into one draft assistant message', () => {
  const s = run([
    ev('status', { running: true }),
    ev('text_delta', { contentIndex: 0, delta: 'Hel' }),
    ev('text_delta', { contentIndex: 0, delta: 'lo' }),
  ]);
  assert.equal(s.running, true);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'assistant');
  assert.deepEqual(
    s.messages[0].parts.map((p) => [p.type, p.text]),
    [['text', 'Hello']]
  );
});

test('final message replaces the draft without duplicating text', () => {
  const s = run([
    ev('text_delta', { contentIndex: 0, delta: 'Hel' }),
    ev('message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        stopReason: 'stop',
      },
    }),
    ev('settled', { aborted: false }),
    ev('status', { running: false }),
  ]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].parts.length, 1);
  assert.equal(s.messages[0].parts[0].text, 'Hello world');
  assert.equal(s.running, false);
});

test('user message, thinking, and ordering', () => {
  const s = run([
    ev('message', { message: { role: 'user', content: 'hi there' } }),
    ev('thinking_delta', { contentIndex: 0, delta: 'hmm' }),
    ev('text_delta', { contentIndex: 1, delta: 'ok' }),
  ]);
  assert.equal(s.messages[0].role, 'user');
  assert.equal(s.messages[0].parts[0].text, 'hi there');
  assert.deepEqual(
    s.messages[1].parts.map((p) => [p.type, p.text]),
    [
      ['reasoning', 'hmm'],
      ['text', 'ok'],
    ]
  );
});

test('tool call lifecycle maps to a tool part with input.code and output.result', () => {
  const call = {
    type: 'toolCall',
    id: 't1',
    name: 'codemode',
    arguments: { code: 'return 1' },
  };
  const s = run([
    ev('message', {
      message: { role: 'assistant', content: [call], stopReason: 'toolUse' },
    }),
    ev('tool_start', {
      toolCallId: 't1',
      toolName: 'codemode',
      args: { code: 'return 1' },
    }),
    ev('tool_end', {
      toolCallId: 't1',
      toolName: 'codemode',
      result: { content: [{ type: 'text', text: 'MARKER' }] },
      isError: false,
    }),
    ev('message', {
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'MARKER' }],
        isError: false,
      },
    }),
    ev('message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      },
    }),
  ]);
  const tools = s.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type.startsWith('tool-'));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'tool-codemode');
  assert.equal(tools[0].toolCallId, 't1');
  assert.equal(tools[0].input.code, 'return 1');
  assert.equal(tools[0].output.result, 'MARKER');
  assert.equal(tools[0].errorText, undefined);
  assert.equal(s.messages.length, 2); // tool result is not its own bubble
});

test('bash args fall back to command for input.code; tool errors set errorText', () => {
  const s = run([
    ev('tool_start', {
      toolCallId: 't2',
      toolName: 'bash',
      args: { command: 'false' },
    }),
    ev('tool_end', {
      toolCallId: 't2',
      toolName: 'bash',
      result: 'exit 1',
      isError: true,
    }),
  ]);
  const tool = s.messages[0].parts[0];
  assert.equal(tool.input.code, 'false');
  assert.equal(tool.errorText, 'exit 1');
});

test('a failed assistant message surfaces its error and clears on the next run', () => {
  let s = run([
    ev('message', {
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'provider down',
      },
    }),
  ]);
  assert.equal(s.error, 'provider down');
  assert.equal(s.messages.length, 0);
  s = reduce(s, ev('status', { running: true }));
  assert.equal(s.error, null);
});

test('error events set error; snapshot replaces everything', () => {
  let s = run([
    ev('text_delta', { contentIndex: 0, delta: 'partial' }),
    ev('error', { message: 'worker died' }),
  ]);
  assert.equal(s.error, 'worker died');
  s = reduce(
    s,
    ev('snapshot', {
      running: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            {
              type: 'toolCall',
              id: 't',
              name: 'bash',
              arguments: { command: 'ls' },
            },
          ],
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 't',
          toolName: 'bash',
          content: [{ type: 'text', text: 'files' }],
          isError: false,
        },
      ],
    })
  );
  assert.equal(s.error, null);
  assert.equal(s.running, true);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].parts[1].output.result, 'files');
});

test('replaying the same snapshot is idempotent (reconnect never duplicates)', () => {
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }],
      stopReason: 'stop',
    },
  ];
  const once = reduce(
    initialState,
    ev('snapshot', { running: false, messages })
  );
  const twice = reduce(once, ev('snapshot', { running: false, messages }));
  assert.deepEqual(
    twice.messages.map((m) => m.parts),
    once.messages.map((m) => m.parts)
  );
});

test('messagesFromPi ignores system and unknown roles', () => {
  const out = messagesFromPi([
    { role: 'system', content: 'x' },
    { role: 'bashExecution', command: 'ls' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(out.length, 1);
});

test('user content given as text blocks renders as plain text', () => {
  const s = run([
    ev('message', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    }),
  ]);
  assert.equal(s.messages[0].parts[0].text, 'ab');
});

const dlg = (id, extra = {}) =>
  ev('dialog_request', {
    dialogId: id,
    method: 'confirm',
    title: 'Proceed?',
    ...extra,
  });

test('dialogs are queued in arrival order and removed when the server closes them', () => {
  let s = run([dlg('a'), dlg('b', { method: 'input' })]);
  assert.deepEqual(
    s.dialogs.map((d) => d.dialogId),
    ['a', 'b']
  );
  s = reduce(s, ev('dialog_closed', { dialogId: 'a', reason: 'answered' }));
  assert.deepEqual(
    s.dialogs.map((d) => d.dialogId),
    ['b']
  );
  s = reduce(s, ev('dialog_closed', { dialogId: 'ghost', reason: 'timeout' }));
  assert.equal(s.dialogs.length, 1);
});

test('a repeated dialog_request does not duplicate; snapshot replaces the dialog list', () => {
  let s = run([dlg('a'), dlg('a')]);
  assert.equal(s.dialogs.length, 1);
  s = reduce(
    s,
    ev('snapshot', {
      running: true,
      messages: [],
      dialogs: [dlg('z')].map(({ dialogId, method, title }) => ({
        dialogId,
        method,
        title,
      })),
    })
  );
  assert.deepEqual(
    s.dialogs.map((d) => d.dialogId),
    ['z']
  );
  s = reduce(s, ev('snapshot', { running: false, messages: [], dialogs: [] }));
  assert.deepEqual(s.dialogs, []);
});

test('notices and unsupported UI methods are surfaced and dismissible', () => {
  let s = run([
    ev('notice', { level: 'warning', message: 'careful' }),
    ev('ui_unsupported', { method: 'setStatus' }),
    ev('ui_unsupported', { method: 'setStatus' }),
    ev('ui_unsupported', { method: 'setWidget' }),
  ]);
  assert.deepEqual(
    { level: s.notice.level, message: s.notice.message },
    { level: 'warning', message: 'careful' }
  );
  assert.deepEqual(s.unsupported, ['setStatus', 'setWidget']);
  s = reduce(s, { type: 'dismiss_notice' });
  assert.equal(s.notice, null);
  s = reduce(s, { type: 'dismiss_unsupported' });
  assert.deepEqual(s.unsupported, []);
});

test('entry IDs from the authoritative snapshot reach user and assistant messages', () => {
  const s = reduce(
    initialState,
    ev('snapshot', {
      running: false,
      dialogs: [],
      leafId: 'a1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }], entryId: 'u1' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          entryId: 'a1',
          stopReason: 'stop',
        },
      ],
    })
  );
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.entryId]),
    [
      ['user', 'u1'],
      ['assistant', 'a1'],
    ]
  );
});

test('live messages have no entry ID until the post-turn snapshot supplies them', () => {
  let s = run([
    ev('message', { message: { role: 'user', content: 'q' } }),
    ev('message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        stopReason: 'stop',
      },
    }),
  ]);
  assert.deepEqual(
    s.messages.map((m) => m.entryId),
    [undefined, undefined]
  );
  s = reduce(
    s,
    ev('snapshot', {
      running: false,
      dialogs: [],
      leafId: 'a1',
      messages: [
        { role: 'user', content: 'q', entryId: 'u1' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          entryId: 'a1',
          stopReason: 'stop',
        },
      ],
    })
  );
  assert.equal(s.messages.length, 2);
  assert.deepEqual(
    s.messages.map((m) => m.entryId),
    ['u1', 'a1']
  );
});

test('a snapshot from another branch replaces the displayed history entirely', () => {
  const first = reduce(
    initialState,
    ev('snapshot', {
      running: false,
      dialogs: [],
      leafId: 'a2',
      messages: [
        { role: 'user', content: 'q1', entryId: 'u1' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a1' }],
          entryId: 'a1',
          stopReason: 'stop',
        },
        { role: 'user', content: 'q2', entryId: 'u2' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a2' }],
          entryId: 'a2',
          stopReason: 'stop',
        },
      ],
    })
  );
  const forked = reduce(
    first,
    ev('snapshot', {
      running: true,
      dialogs: [],
      leafId: 'a1',
      messages: [
        { role: 'user', content: 'q1', entryId: 'u1' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a1' }],
          entryId: 'a1',
          stopReason: 'stop',
        },
      ],
    })
  );
  assert.deepEqual(
    forked.messages.map((m) => m.entryId),
    ['u1', 'a1']
  );
  assert.equal(forked.running, true);
});
