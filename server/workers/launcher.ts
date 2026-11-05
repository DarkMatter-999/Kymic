import { spawn, type ChildProcess } from 'node:child_process';
import { chown, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RpcClient } from '../gateway/rpc.js';
import {
  readCurrentSession,
  readProfile,
  workspaceForConversation,
  writeCurrentSession,
  writeProfileOnce,
} from './storage.js';

export interface LauncherConfig {
  /** Fixed path to the pinned Pi CLI entry point. */
  piCli: string;
  workspaceRoot: string;
  sessionRoot: string;
  /**
   * Gateway-private records (current session, profile). Required when `uid` is set:
   * it must not be writable by the worker, because the gateway writes there as a
   * more privileged user and must never follow links the worker planted.
   */
  metaRoot?: string;
  /** Pi's HOME / PI_CODING_AGENT_DIR (credentials, settings). */
  agentHome: string;
  /** Allowlisted skill files or directories. */
  skills: string[];
  /** Dedicated unprivileged identity; requires the gateway to start as root (or CAP_SETUID/SETGID). */
  uid?: number;
  gid?: number;
  /**
   * Extra environment for workers, set by the operator (for example proxy settings).
   * The fixed variables below always win, so this cannot change PATH, HOME or Pi's directory.
   */
  env?: Record<string, string>;
  /** Allowlisted Pi extensions (builtin:<name> or a trusted path). */
  extensions?: string[];
  /** Pi --tools selection; defaults to adding codemode. Ignored when `profiles` is set. */
  tools?: string;
  /**
   * Named tool profiles, defined by the operator only. A conversation picks one
   * when it first runs; it is recorded and can never change. Without this, one
   * "default" profile is built from `extensions` and `tools`.
   */
  profiles?: Record<string, ProfileDef>;
  defaultProfile?: string;
  onEvent?: (conversationId: string, event: unknown) => void;
  /** Called when a worker process exits for any reason, including a deliberate stop. */
  onExit?: (
    conversationId: string,
    info: { code: number | null; signal: string | null; stderr: string }
  ) => void;
}

/**
 * What a worker may do. Extensions and tools are separate controls: leaving
 * codemode out removes the `codemode` tool, and leaving builtin:mcp out removes
 * MCP servers even from codemode. Hiding a declaration is not enough.
 */
export interface ProfileDef {
  label: string;
  description: string;
  /** Extensions to load (builtin:<name> or a trusted path). */
  extensions: string[];
  /** A --tools value, `null` for --no-tools, or undefined for Pi's default tools. */
  tools?: string | null;
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
  private readonly profiles: Record<string, ProfileDef>;
  readonly defaultProfile: string;
  /** Profile of each running worker. */
  private readonly running = new Map<string, string>();

  constructor(config: LauncherConfig) {
    // Workers run with their workspace as cwd, so every path must be absolute.
    this.config = {
      ...config,
      piCli: resolve(config.piCli),
      workspaceRoot: resolve(config.workspaceRoot),
      sessionRoot: resolve(config.sessionRoot),
      metaRoot: config.metaRoot ? resolve(config.metaRoot) : undefined,
      agentHome: resolve(config.agentHome),
      skills: config.skills.map((skill) => resolve(skill)),
      extensions: config.extensions?.map((e) =>
        e.startsWith('builtin:') ? e : resolve(e)
      ),
    };
    const resolveExt = (e: string) =>
      e.startsWith('builtin:') ? e : resolve(e);
    this.profiles = Object.fromEntries(
      Object.entries(
        config.profiles ?? {
          default: {
            label: 'Default',
            description: '',
            extensions: config.extensions ?? DEFAULT_EXTENSIONS,
            tools: config.tools ?? '+codemode',
          },
        }
      ).map(([name, def]) => [
        name,
        { ...def, extensions: def.extensions.map(resolveExt) },
      ])
    );
    this.defaultProfile =
      config.defaultProfile ?? Object.keys(this.profiles)[0];
    if (!this.profiles[this.defaultProfile])
      throw new Error('Unknown default profile');
    if (
      (config.uid !== undefined || config.gid !== undefined) &&
      !(config.metaRoot && config.uid !== undefined && config.gid !== undefined)
    )
      throw new Error(
        'Dropping privileges needs uid, gid and a gateway-private metaRoot'
      );
  }

  private metaDir(conversationId: string): string {
    return join(
      this.config.metaRoot ?? this.config.sessionRoot,
      conversationId
    );
  }

  /** What the browser may choose from. Never includes paths or arguments. */
  listProfiles(): { name: string; label: string; description: string }[] {
    return Object.entries(this.profiles).map(([name, p]) => ({
      name,
      label: p.label,
      description: p.description,
    }));
  }

  /** The profile a conversation uses: its recorded one, else the one a worker is running. */
  async profileOf(conversationId: string): Promise<string | null> {
    return (await readProfile(this.metaDir(conversationId))) ?? null;
  }

  /**
   * Start (or reuse) the worker. The profile is the recorded one if there is
   * one; otherwise the requested one, else the default. A conversation that has
   * not run yet may still change its choice, which restarts its idle worker.
   */
  async start(conversationId: string, requested?: string): Promise<Worker> {
    if (requested !== undefined && !this.profiles[requested])
      throw new Error('Unknown profile');
    const recorded = await readProfile(this.metaDir(conversationId)).catch(
      () => undefined
    );
    if (recorded && !this.profiles[recorded])
      throw new Error(`Profile "${recorded}" is no longer configured`);
    if (recorded && requested && requested !== recorded)
      throw new Error(
        `This conversation already uses the "${recorded}" profile`
      );
    const name = recorded ?? requested ?? this.defaultProfile;

    let existing = this.workers.get(conversationId);
    if (existing && this.running.get(conversationId) !== name) {
      await this.stop(conversationId);
      existing = undefined;
    }
    if (!existing) {
      existing = this.spawnWorker(conversationId, name);
      this.workers.set(conversationId, existing);
      this.running.set(conversationId, name);
      existing.catch(() => {
        this.workers.delete(conversationId);
        this.running.delete(conversationId);
      });
    }
    return existing;
  }

  /** Fix the running worker's profile for good. Call once the conversation really starts. */
  async commitProfile(conversationId: string): Promise<void> {
    const name = this.running.get(conversationId);
    if (!name) throw new Error('Agent process is not running');
    const dir = this.metaDir(conversationId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeProfileOnce(dir, name);
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
      state.sessionFile,
      this.metaDir(conversationId)
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
    this.running.delete(conversationId);
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

  private async spawnWorker(
    conversationId: string,
    profileName: string
  ): Promise<Worker> {
    const { config } = this;
    const profile = this.profiles[profileName];
    // With a worker identity the parents must be traversable but not writable by it, so
    // the worker can never swap a directory under the gateway (which runs as root).
    const rootMode = config.uid === undefined ? 0o700 : 0o711;
    await mkdir(config.workspaceRoot, { recursive: true, mode: rootMode });
    await mkdir(config.sessionRoot, { recursive: true, mode: rootMode });
    const workspace = await workspaceForConversation(
      config.workspaceRoot,
      conversationId
    );
    const sessionDir = join(config.sessionRoot, conversationId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await mkdir(config.agentHome, { recursive: true, mode: 0o700 });
    await mkdir(this.metaDir(conversationId), { recursive: true, mode: 0o700 });
    if (config.uid !== undefined && config.gid !== undefined) {
      for (const dir of [workspace, sessionDir, config.agentHome])
        await chown(dir, config.uid, config.gid);
    }

    // An explicit mapping wins over "newest file": forks create extra session files.
    const current = await readCurrentSession(
      sessionDir,
      this.metaDir(conversationId)
    );
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
      ...profile.extensions.flatMap((e) => ['--extension', e]),
      ...(profile.tools === null
        ? ['--no-tools']
        : profile.tools
          ? ['--tools', profile.tools]
          : []),
      ...config.skills.flatMap((s) => ['--skill', s]),
    ];
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: {
        ...config.env,
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
        if (w.child === child) {
          this.workers.delete(conversationId);
          this.running.delete(conversationId);
        }
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
