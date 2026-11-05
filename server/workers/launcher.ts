import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RpcClient } from '../gateway/rpc.js';
import {
  readCurrentSession,
  workspaceForConversation,
  writeCurrentSession,
} from './storage.js';

export interface LauncherConfig {
  /** Fixed path to the pinned Pi CLI entry point. */
  piCli: string;
  workspaceRoot: string;
  sessionRoot: string;
  /** Pi's HOME / PI_CODING_AGENT_DIR (credentials, settings). */
  agentHome: string;
  /** Allowlisted skill files or directories. */
  skills: string[];
  /** Dedicated unprivileged identity; requires the gateway to start as root (or CAP_SETUID/SETGID). */
  uid?: number;
  gid?: number;
  /** Allowlisted Pi extensions (builtin:<name> or a trusted path). */
  extensions?: string[];
  /** Pi --tools selection; defaults to adding codemode. */
  tools?: string;
  onEvent?: (conversationId: string, event: unknown) => void;
  /** Called when a worker process exits for any reason, including a deliberate stop. */
  onExit?: (
    conversationId: string,
    info: { code: number | null; signal: string | null; stderr: string }
  ) => void;
}

export interface Worker {
  conversationId: string;
  workspace: string;
  child: ChildProcess;
  rpc: RpcClient;
  stderrTail(): string;
}

const DEFAULT_EXTENSIONS = ['builtin:mcp', 'builtin:codemode'];
const STDERR_LIMIT = 16 * 1024;

/**
 * Trusted launcher: the only inputs from callers are a validated conversation ID.
 * Executable, arguments and environment are fixed; nothing is inherited from the gateway.
 */
export class WorkerLauncher {
  private readonly workers = new Map<string, Promise<Worker>>();
  /** Workers whose process is up, for callers that must not start one. */
  private readonly live = new Map<string, Worker>();

  private readonly config: LauncherConfig;

  constructor(config: LauncherConfig) {
    // Workers run with their workspace as cwd, so every path must be absolute.
    this.config = {
      ...config,
      piCli: resolve(config.piCli),
      workspaceRoot: resolve(config.workspaceRoot),
      sessionRoot: resolve(config.sessionRoot),
      agentHome: resolve(config.agentHome),
      skills: config.skills.map((skill) => resolve(skill)),
      extensions: config.extensions?.map((e) =>
        e.startsWith('builtin:') ? e : resolve(e)
      ),
    };
  }

  start(conversationId: string): Promise<Worker> {
    let existing = this.workers.get(conversationId);
    if (!existing) {
      existing = this.spawnWorker(conversationId);
      this.workers.set(conversationId, existing);
      existing.catch(() => this.workers.delete(conversationId));
    }
    return existing;
  }

  /** Remember which session file this conversation resumes (after a fork). */
  async recordCurrentSession(conversationId: string): Promise<void> {
    const worker = this.live.get(conversationId);
    if (!worker) throw new Error('Agent process is not running');
    const state = (await worker.rpc.command('get_state')) as {
      sessionFile?: string;
    };
    if (!state.sessionFile) throw new Error('Pi did not report a session file');
    await writeCurrentSession(
      join(this.config.sessionRoot, conversationId),
      state.sessionFile
    );
  }

  /** The running worker, if any; never starts one. */
  peek(conversationId: string): Worker | undefined {
    return this.live.get(conversationId);
  }

  async stop(conversationId: string): Promise<void> {
    const pending = this.workers.get(conversationId);
    if (!pending) return;
    this.workers.delete(conversationId);
    const worker = await pending.catch(() => undefined);
    if (!worker) return;
    const exited = new Promise<void>((resolve) => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null)
        resolve();
      else worker.child.once('exit', () => resolve());
    });
    worker.child.stdin?.end();
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 3000);
    worker.child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
    worker.rpc.close();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((id) => this.stop(id)));
  }

  private async spawnWorker(conversationId: string): Promise<Worker> {
    const { config } = this;
    await mkdir(config.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspace = await workspaceForConversation(
      config.workspaceRoot,
      conversationId
    );
    const sessionDir = join(config.sessionRoot, conversationId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await mkdir(config.agentHome, { recursive: true, mode: 0o700 });

    // An explicit mapping wins over "newest file": forks create extra session files.
    const current = await readCurrentSession(sessionDir);
    const args = [
      config.piCli,
      '--mode',
      'rpc',
      '--session-dir',
      sessionDir,
      ...(current ? ['--session', current] : ['--continue']),
      '--no-extensions',
      '--no-skills',
      '--no-context-files',
      // --no-extensions also drops Pi's built-ins, so the allowlisted ones are loaded explicitly.
      ...(config.extensions ?? DEFAULT_EXTENSIONS).flatMap((e) => [
        '--extension',
        e,
      ]),
      ...(config.tools ? ['--tools', config.tools] : ['--tools', '+codemode']),
      ...config.skills.flatMap((s) => ['--skill', s]),
    ];
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: config.agentHome,
        PI_CODING_AGENT_DIR: config.agentHome,
        PI_TELEMETRY: '0',
        PI_OFFLINE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'], // only fds 0-2; nothing else is passed down
      uid: config.uid,
      gid: config.gid,
    });

    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    const rpc = new RpcClient(child.stdin!, child.stdout!, (event) =>
      config.onEvent?.(conversationId, event)
    );
    child.on('exit', (code, signal) => {
      rpc.close(
        new Error(
          `Pi exited (${code ?? signal})${stderr ? `: ${stderr.slice(-500)}` : ''}`
        )
      );
      if (this.live.get(conversationId)?.child === child) {
        this.live.delete(conversationId);
      }
      config.onExit?.(conversationId, { code, signal, stderr });
      this.workers.get(conversationId)?.then((w) => {
        if (w.child === child) this.workers.delete(conversationId);
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    const worker: Worker = {
      conversationId,
      workspace,
      child,
      rpc,
      stderrTail: () => stderr,
    };
    this.live.set(conversationId, worker);
    return worker;
  }
}
