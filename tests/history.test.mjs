import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBranchMessages } from '../server/gateway/history.ts';
import {
  readCurrentSession,
  writeCurrentSession,
} from '../server/workers/storage.ts';

const msg = (id, parentId, role, text = '') => ({
  type: 'message',
  id,
  parentId,
  message: { role, content: [{ type: 'text', text: text || id }] },
});
const other = (id, parentId, type = 'model_change') => ({ type, id, parentId });

test('walks the active branch from the leaf and attaches stable entry IDs', () => {
  const entries = [
    other('m', null),
    msg('s', 'm', 'system'),
    msg('u1', 's', 'user'),
    msg('a1', 'u1', 'assistant'),
    msg('u2', 'a1', 'user'),
    msg('a2', 'u2', 'assistant'),
  ];
  const out = activeBranchMessages(entries, 'a2');
  assert.deepEqual(
    out.map((m) => [m.role, m.entryId]),
    [
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2'],
    ]
  );
  assert.equal(out[0].content[0].text, 'u1');
});

test('abandoned branches in the same file are excluded; the leaf decides the branch', () => {
  const entries = [
    msg('u1', null, 'user'),
    msg('a1', 'u1', 'assistant'),
    msg('u2', 'a1', 'user'),
    msg('a2', 'u2', 'assistant'),
    msg('u2b', 'a1', 'user', 'edited'),
    msg('a2b', 'u2b', 'assistant'),
  ];
  assert.deepEqual(
    activeBranchMessages(entries, 'a2b').map((m) => m.entryId),
    ['u1', 'a1', 'u2b', 'a2b']
  );
  assert.deepEqual(
    activeBranchMessages(entries, 'a2').map((m) => m.entryId),
    ['u1', 'a1', 'u2', 'a2']
  );
});

test('compaction does not hide earlier history, and non-message entries are skipped', () => {
  const entries = [
    msg('u1', null, 'user'),
    msg('a1', 'u1', 'assistant'),
    other('c', 'a1', 'compaction'),
    msg('u2', 'c', 'user'),
    other('t', 'u2', 'thinking_level_change'),
    msg('a2', 't', 'assistant'),
  ];
  assert.deepEqual(
    activeBranchMessages(entries, 'a2').map((m) => m.entryId),
    ['u1', 'a1', 'u2', 'a2']
  );
});

test('tool results and unknown roles: only user, assistant and toolResult are visible', () => {
  const entries = [
    msg('u1', null, 'user'),
    msg('a1', 'u1', 'assistant'),
    msg('r1', 'a1', 'toolResult'),
    msg('b1', 'r1', 'bashExecution'),
    msg('x', 'b1', 'custom'),
  ];
  assert.deepEqual(
    activeBranchMessages(entries, 'x').map((m) => m.role),
    ['user', 'assistant', 'toolResult']
  );
});

test('empty sessions, unknown leaves, orphans and cycles are handled safely', () => {
  assert.deepEqual(activeBranchMessages([], null), []);
  assert.deepEqual(activeBranchMessages([msg('u', null, 'user')], 'nope'), []);
  assert.deepEqual(
    activeBranchMessages([msg('u', 'missing', 'user')], 'u').map(
      (m) => m.entryId
    ),
    ['u']
  );
  const cycle = [msg('a', 'b', 'user'), msg('b', 'a', 'assistant')];
  assert.equal(activeBranchMessages(cycle, 'a').length, 2);
});

test('does not mutate entries', () => {
  const entries = [msg('u1', null, 'user')];
  const copy = JSON.stringify(entries);
  activeBranchMessages(entries, 'u1');
  assert.equal(JSON.stringify(entries), copy);
});

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cur-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('current-session mapping round-trips atomically', async () => {
  const file = join(dir, '2026_abc.jsonl');
  await writeFile(file, '{}\n');
  assert.equal(await readCurrentSession(dir), undefined);
  await writeCurrentSession(dir, file);
  assert.equal(await readCurrentSession(dir), file);
  assert.deepEqual(
    (await readdir(dir)).filter((f) => f.includes('.tmp')),
    []
  );
});

test('mapping is ignored when the file is gone, outside the directory, or the record is corrupt', async () => {
  await assert.rejects(writeCurrentSession(dir, '/etc/passwd'), /outside/i);
  await assert.rejects(
    writeCurrentSession(dir, join(dir, '..', 'escape.jsonl')),
    /outside/i
  );
  const file = join(dir, 'a.jsonl');
  await writeFile(file, '{}\n');
  await writeCurrentSession(dir, file);
  await rm(file);
  assert.equal(await readCurrentSession(dir), undefined);
  await writeFile(join(dir, 'current.json'), '{not json');
  assert.equal(await readCurrentSession(dir), undefined);
  await writeFile(
    join(dir, 'current.json'),
    JSON.stringify({ sessionFile: '/etc/passwd' })
  );
  assert.equal(await readCurrentSession(dir), undefined);
});
