import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/chat/reducer.ts';
import {
  mergeSubagents,
  parseSubagent,
  subagentsFromHistory,
} from '../server/gateway/subagents.ts';

const ev = (subagent) => ({
  v: 1,
  conversationId: 'c',
  type: 'subagent',
  subagent,
});
const sub = (id, state, extra = {}) => ({
  id,
  task: `task ${id}`,
  state,
  ...extra,
});

test('parallel subagents are tracked independently, in start order', () => {
  let s = initialState;
  for (const e of [
    sub('b', 'running'),
    sub('a', 'running'),
    sub('a', 'tool_call'),
    sub('b', 'running', { text: 'hi' }),
  ])
    s = reduce(s, ev(e));
  assert.deepEqual(
    s.subagents.map((x) => [x.id, x.state, x.text]),
    [
      ['b', 'running', 'hi'],
      ['a', 'tool_call', undefined],
    ]
  );
});

test('a finished subagent is never reopened by a late or out-of-order update', () => {
  let s = reduce(initialState, ev(sub('a', 'running')));
  s = reduce(s, ev(sub('a', 'finished', { result: 'done' })));
  const after = reduce(s, ev(sub('a', 'running', { text: 'late' })));
  assert.equal(after, s);
  assert.equal(after.subagents[0].result, 'done');
  // A cancelled one stays cancelled even if a finish arrives afterwards.
  let c = reduce(initialState, ev(sub('x', 'cancelled')));
  c = reduce(c, ev(sub('x', 'finished', { result: 'r' })));
  assert.equal(c.subagents[0].state, 'cancelled');
});

test('an update for an unseen subagent creates it (events may arrive out of order)', () => {
  const s = reduce(initialState, ev(sub('z', 'tool_call')));
  assert.equal(s.subagents.length, 1);
});

test("a snapshot replaces the list with the server's authoritative one", () => {
  let s = reduce(initialState, ev(sub('a', 'running')));
  s = reduce(s, {
    v: 1,
    conversationId: 'c',
    type: 'snapshot',
    running: false,
    messages: [],
    dialogs: [],
    leafId: null,
    subagents: [sub('h', 'finished', { result: 'r' })],
  });
  assert.deepEqual(
    s.subagents.map((x) => x.id),
    ['h']
  );
  s = reduce(s, {
    v: 1,
    conversationId: 'c',
    type: 'snapshot',
    running: false,
    messages: [],
    dialogs: [],
    leafId: null,
  });
  assert.deepEqual(s.subagents, []);
});

test('payloads are validated; the id comes from the tool call, not the payload', () => {
  assert.equal(parseSubagent({ subagent: { state: 'bogus' } }, 'i'), null);
  assert.equal(parseSubagent(null, 'i'), null);
  const p = parseSubagent(
    {
      subagent: {
        id: 'spoofed',
        state: 'finished',
        result: 'r'.repeat(60_000),
      },
    },
    'real'
  );
  assert.equal(p.id, 'real');
  assert.equal(p.result.length, 50_000);
});

test('history yields subagents only from the subagent tool, with failures shown as errors', () => {
  const messages = [
    {
      role: 'toolResult',
      toolName: 'run_subagent',
      toolCallId: 't1',
      details: { subagent: { state: 'finished', task: 'a', result: 'r' } },
    },
    {
      role: 'toolResult',
      toolName: 'run_subagent',
      toolCallId: 't2',
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    },
    {
      role: 'toolResult',
      toolName: 'bash',
      toolCallId: 't3',
      details: { subagent: { state: 'finished' } },
    },
  ];
  assert.deepEqual(
    subagentsFromHistory(messages).map((x) => [x.id, x.state, x.error]),
    [
      ['t1', 'finished', undefined],
      ['t2', 'error', 'boom'],
    ]
  );
});

test('merging history with live state keeps finished results and adds running ones', () => {
  const merged = mergeSubagents(
    [sub('a', 'finished', { result: 'r' })],
    [sub('a', 'running'), sub('b', 'running')]
  );
  assert.deepEqual(
    merged.map((x) => [x.id, x.state]),
    [
      ['a', 'finished'],
      ['b', 'running'],
    ]
  );
});
