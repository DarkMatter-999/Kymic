import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

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

const CURRENT_FILE = 'current.json';

function insideDirectory(directory: string, file: string): boolean {
  const base = resolve(directory) + sep;
  return resolve(file).startsWith(base);
}

/**
 * The Pi session file a conversation currently resumes. Forks create new
 * files and leave the original alone, so this is recorded explicitly instead
 * of relying on which file is newest. Returns undefined if absent or invalid.
 */
export async function readCurrentSession(
  sessionDir: string
): Promise<string | undefined> {
  try {
    const record = JSON.parse(
      await readFile(join(sessionDir, CURRENT_FILE), 'utf8')
    ) as { sessionFile?: unknown };
    const file = record.sessionFile;
    if (typeof file !== 'string' || !insideDirectory(sessionDir, file)) {
      return undefined;
    }
    await lstat(file);
    return file;
  } catch {
    return undefined;
  }
}

export async function writeCurrentSession(
  sessionDir: string,
  sessionFile: string
): Promise<void> {
  if (!insideDirectory(sessionDir, sessionFile)) {
    throw new Error('Session file is outside the conversation directory');
  }
  const target = join(sessionDir, CURRENT_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ sessionFile }), { mode: 0o600 });
  await rename(temp, target);
}
