import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientCommand,
  projectPiEvent,
  visibleMessages,
} from '../server/gateway/protocol.ts';

test('parses valid client commands', () => {
  assert.deepEqual(
    parseClientCommand({
      v: 1,
      type: 'prompt',
      conversationId: 'c-1',
      text: 'hi',
    }),
    { v: 1, type: 'prompt', conversationId: 'c-1', text: 'hi' }
  );
  assert.equal(
    parseClientCommand({ v: 1, type: 'abort', conversationId: 'c-1' }).type,
    'abort'
  );
  assert.equal(
    parseClientCommand({ v: 1, type: 'subscribe', conversationId: 'c-1' }).type,
    'subscribe'
  );
});

test('drops unknown fields so only {conversationId, text} reach Pi', () => {
  const cmd = parseClientCommand({
    v: 1,
    type: 'prompt',
    conversationId: 'c-1',
    text: 'hi',
    cwd: '/',
    env: { A: 1 },
    args: ['--x'],
  });
  assert.deepEqual(Object.keys(cmd).sort(), [
    'conversationId',
    'text',
    'type',
    'v',
  ]);
});

test('rejects invalid commands', () => {
  for (const bad of [
    null,
    'x',
    {},
    { v: 2, type: 'abort', conversationId: 'c' },
    { v: 1, type: 'bash', conversationId: 'c' },
    { v: 1, type: 'prompt', conversationId: '../x', text: 'hi' },
    { v: 1, type: 'prompt', conversationId: 'c', text: '' },
    { v: 1, type: 'prompt', conversationId: 'c', text: 5 },
    { v: 1, type: 'prompt', conversationId: 'c', text: 'x'.repeat(100_001) },
  ]) {
    assert.throws(
      () => parseClientCommand(bad),
      /Invalid/,
      JSON.stringify(bad)?.slice(0, 60)
    );
  }
});

test('projects Pi events to the versioned schema', () => {
  const p = (e) => projectPiEvent('c-1', e);
  assert.deepEqual(
    p({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hi',
      },
    }),
    [
      {
        v: 1,
        type: 'text_delta',
        conversationId: 'c-1',
        contentIndex: 0,
        delta: 'Hi',
      },
    ]
  );
  assert.deepEqual(
    p({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 1,
        delta: 'hm',
      },
    }),
    [
      {
        v: 1,
        type: 'thinking_delta',
        conversationId: 'c-1',
        contentIndex: 1,
        delta: 'hm',
      },
    ]
  );
  assert.equal(
    p({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{',
      },
    }).length,
    0
  );
  assert.deepEqual(
    p({ type: 'message_end', message: { role: 'assistant', content: [] } }),
    [
      {
        v: 1,
        type: 'message',
        conversationId: 'c-1',
        message: { role: 'assistant', content: [] },
      },
    ]
  );
  assert.deepEqual(
    p({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'ls' },
    }),
    [
      {
        v: 1,
        type: 'tool_start',
        conversationId: 'c-1',
        toolCallId: 't1',
        toolName: 'bash',
        args: { command: 'ls' },
      },
    ]
  );
  assert.equal(
    p({
      type: 'tool_execution_update',
      toolCallId: 't1',
      toolName: 'bash',
      partialResult: { a: 1 },
    })[0].type,
    'tool_update'
  );
  assert.deepEqual(
    p({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: 'r',
      isError: true,
    }),
    [
      {
        v: 1,
        type: 'tool_end',
        conversationId: 'c-1',
        toolCallId: 't1',
        toolName: 'bash',
        result: 'r',
        isError: true,
      },
    ]
  );
  assert.deepEqual(p({ type: 'agent_settled', aborted: true }), [
    { v: 1, type: 'settled', conversationId: 'c-1', aborted: true },
  ]);
  assert.equal(p({ type: 'extension_error', error: 'boom' })[0].type, 'error');
  assert.deepEqual(p({ type: 'agent_end', messages: [] }), []); // agent_end is not final idle
  assert.deepEqual(p({ type: 'something_new' }), []);
});

test('system and unknown-role messages never reach the browser', () => {
  assert.deepEqual(
    projectPiEvent('c-1', {
      type: 'message_end',
      message: { role: 'system', content: 'secret prompt' },
    }),
    []
  );
  assert.deepEqual(
    projectPiEvent('c-1', {
      type: 'message_end',
      message: { role: 'bashExecution', command: 'ls' },
    }),
    []
  );
  assert.equal(
    projectPiEvent('c-1', {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 't' },
    }).length,
    1
  );
  assert.deepEqual(
    visibleMessages([
      { role: 'system', content: 'x' },
      { role: 'user', content: 'hi' },
      { role: 'custom' },
    ]),
    [{ role: 'user', content: 'hi' }]
  );
});
