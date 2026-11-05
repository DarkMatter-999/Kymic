import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Create a stable workspace path; workspaces are not isolated from peers. */
export async function workspaceForConversation(
  root: string,
  conversationId: string
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(conversationId)) {
    throw new Error('Invalid conversation ID');
  }
  const workspace = join(root, conversationId);
  try {
    await mkdir(workspace, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await lstat(workspace)).isDirectory())
    throw new Error('Workspace is not a directory');
  return workspace;
}
