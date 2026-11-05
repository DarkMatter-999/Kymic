import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReadinessChecks {
  /** The pinned Pi entry point every worker runs. */
  piCli: string;
  /** Gateway-private state (auth and scheduler databases). */
  dataRoot: string;
  /** Extension files and skills workers load by path. */
  files: string[];
}

/**
 * Whether the gateway could actually start a worker and keep its state. Returns
 * the names of failed checks (empty means ready). These are logged on the
 * server; the unauthenticated endpoint reports only ready or not.
 */
export async function readinessFailures(
  checks: ReadinessChecks
): Promise<string[]> {
  const failures: string[] = [];
  const readable = async (label: string, path: string) => {
    try {
      await access(path, constants.R_OK);
    } catch {
      failures.push(`${label} is not readable: ${path}`);
    }
  };
  await readable('Pi CLI', checks.piCli);
  for (const file of checks.files) await readable('Worker file', file);
  try {
    await mkdir(checks.dataRoot, { recursive: true });
    const probe = join(checks.dataRoot, `.ready-${process.pid}`);
    await writeFile(probe, '');
    await rm(probe);
  } catch {
    failures.push(`Data directory is not writable: ${checks.dataRoot}`);
  }
  return failures;
}
