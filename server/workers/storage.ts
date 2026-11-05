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
  sessionDir: string,
  metaDir: string = sessionDir
): Promise<string | undefined> {
  try {
    const record = JSON.parse(
      await readFile(join(metaDir, CURRENT_FILE), 'utf8')
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
  sessionFile: string,
  metaDir: string = sessionDir
): Promise<void> {
  if (!insideDirectory(sessionDir, sessionFile)) {
    throw new Error('Session file is outside the conversation directory');
  }
  await mkdir(metaDir, { recursive: true, mode: 0o700 });
  const target = join(metaDir, CURRENT_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ sessionFile }), { mode: 0o600 });
  await rename(temp, target);
}

const PROFILE_FILE = 'profile.json';
const PROFILE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const isProfileName = (name: unknown): name is string =>
  typeof name === 'string' && PROFILE_PATTERN.test(name);

/** The tool profile a conversation was started with, or undefined if none was recorded. */
export async function readProfile(
  sessionDir: string
): Promise<string | undefined> {
  try {
    const record = JSON.parse(
      await readFile(join(sessionDir, PROFILE_FILE), 'utf8')
    ) as { profile?: unknown };
    return isProfileName(record.profile) ? record.profile : undefined;
  } catch {
    return undefined;
  }
}

/** Record the profile once. The first writer wins; a conversation's profile never changes. */
export async function writeProfileOnce(
  sessionDir: string,
  profile: string
): Promise<void> {
  if (!isProfileName(profile)) throw new Error('Invalid profile name');
  try {
    await writeFile(
      join(sessionDir, PROFILE_FILE),
      JSON.stringify({ profile }),
      { mode: 0o600, flag: 'wx' }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

const MODEL_FILE = 'model.json';
const MODEL_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MODEL_ID = /^[\w][\w.:/@+-]{0,199}$/;

/** A model chosen by provider and model ID, as Pi names them. */
export interface ModelRef {
  provider: string;
  id: string;
}

export function parseModelRef(value: unknown): ModelRef | undefined {
  const v = value as { provider?: unknown; id?: unknown } | null | undefined;
  if (
    typeof v?.provider === 'string' &&
    typeof v.id === 'string' &&
    MODEL_PROVIDER.test(v.provider) &&
    MODEL_ID.test(v.id)
  )
    return { provider: v.provider, id: v.id };
  return undefined;
}

export async function readModelFile(
  dir: string
): Promise<ModelRef | undefined> {
  try {
    return parseModelRef(
      JSON.parse(await readFile(join(dir, MODEL_FILE), 'utf8'))
    );
  } catch {
    return undefined;
  }
}

/** Replace the stored model atomically. Only the gateway ever writes this directory. */
export async function writeModelFile(
  dir: string,
  model: ModelRef
): Promise<void> {
  const ref = parseModelRef(model);
  if (!ref) throw new Error('Invalid model');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, MODEL_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(ref), { mode: 0o600 });
  await rename(temp, target);
}
