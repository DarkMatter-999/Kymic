import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceForConversation } from '../server/workers/storage.ts';

test('conversation workspaces have distinct stable paths and retain files', async () => {
  const root = await mkdtemp('/tmp/opencode/workspaces-');
  const first = await workspaceForConversation(root, 'a123');
  const second = await workspaceForConversation(root, 'b456');
  assert.notEqual(first, second);
  await writeFile(join(first, 'note.txt'), 'saved');
  assert.equal(await workspaceForConversation(root, 'a123'), first);
  assert.equal(await readFile(join(first, 'note.txt'), 'utf8'), 'saved');
});

test('workspace identifiers cannot escape the workspace root', async () => {
  const root = await mkdtemp('/tmp/opencode/workspaces-');
  for (const id of ['', '../outside', '/tmp/outside', '.', 'a/b']) {
    await assert.rejects(workspaceForConversation(root, id), /invalid/i);
  }
});

test('existing workspace symlinks are rejected', async () => {
  const root = await mkdtemp('/tmp/opencode/workspaces-');
  const outside = await mkdtemp('/tmp/opencode/workspace-outside-');
  await symlink(outside, join(root, 'a123'));
  await assert.rejects(workspaceForConversation(root, 'a123'), /workspace/i);
});
