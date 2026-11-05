import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLoginEvents } from '../src/chat/providers.ts';

test('folds a device-code login into link, code and prompt state', () => {
  const view = foldLoginEvents([
    { type: 'prompt', promptId: 'p1', kind: 'select', message: 'Method', options: [] },
    { type: 'prompt_closed', promptId: 'p1' },
    { type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://x.example/device' },
    { type: 'progress', message: 'waiting' },
  ]);
  assert.equal(view.status, 'running');
  assert.equal(view.prompt, undefined);
  assert.deepEqual(view.device, { userCode: 'ABCD-1234', verificationUri: 'https://x.example/device' });
  assert.deepEqual(view.notes, ['waiting']);
});

test('a closed prompt only clears itself, and terminal events set the status', () => {
  const open = { type: 'prompt', promptId: 'p2', kind: 'text', message: 'Code' };
  assert.equal(foldLoginEvents([open, { type: 'prompt_closed', promptId: 'other' }]).prompt?.promptId, 'p2');
  assert.equal(foldLoginEvents([{ type: 'done' }]).status, 'done');
  const failed = foldLoginEvents([{ type: 'failed', message: 'nope' }]);
  assert.deepEqual([failed.status, failed.error], ['failed', 'nope']);
});

test('keeps only the five most recent notes', () => {
  const events = Array.from({ length: 8 }, (_, i) => ({ type: 'progress', message: `n${i}` }));
  assert.deepEqual(foldLoginEvents(events).notes, ['n3', 'n4', 'n5', 'n6', 'n7']);
});
