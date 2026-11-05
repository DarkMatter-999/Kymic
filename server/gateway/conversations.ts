import { WorkerLauncher, type LauncherConfig } from '../workers/launcher.js';
import { DialogBroker } from './dialogs.js';
import { latestCanvas, type CanvasPayload } from './canvas.js';
import { activeBranchMessages } from './history.js';
import {
  isTerminal,
  mergeSubagent,
  mergeSubagents,
  subagentsFromHistory,
  type SubagentView,
} from './subagents.js';
import {
  PROTOCOL_VERSION,
  projectPiEvent,
  type DialogAnswer,
  type DialogRequest,
  type ServerEvent,
} from './protocol.js';

export type Listener = (event: ServerEvent) => void;

/**
 * Owns conversation state that is NOT in Pi: which turns are active and who is listening.
 * Message history lives only in Pi; this never replays browser history into a worker.
 * Workers keep running when every listener disconnects.
 */
export class ConversationManager {
  readonly launcher: WorkerLauncher;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly running = new Set<string>();
  private readonly brokers = new Map<string, DialogBroker>();
  /** Subagents seen live this turn, by conversation then tool call ID. */
  private readonly liveSubagents = new Map<string, Map<string, SubagentView>>();
  private readonly dialogTimeoutMs: number;
  private readonly disconnectGraceMs: number;

  constructor(
    config: Omit<LauncherConfig, 'onEvent' | 'onExit'> & {
      /** Deadline for dialogs without a Pi-side timeout; expiry cancels (denies). */
      dialogTimeoutMs?: number;
      /** Cancel pending dialogs after this long with no client connected. */
      disconnectGraceMs?: number;
    }
  ) {
    const { dialogTimeoutMs, disconnectGraceMs, ...launcherConfig } = config;
    this.dialogTimeoutMs = dialogTimeoutMs ?? 5 * 60_000;
    this.disconnectGraceMs = disconnectGraceMs ?? 30_000;
    this.launcher = new WorkerLauncher({
      ...launcherConfig,
      onEvent: (id, event) => this.handlePiEvent(id, event),
      onExit: (id, info) => this.handleExit(id, info),
    });
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) this.listeners.set(conversationId, (set = new Set()));
    set.add(listener);
    this.brokers.get(conversationId)?.listenersChanged();
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(conversationId);
      this.brokers.get(conversationId)?.listenersChanged();
    };
  }

  listenerCount(conversationId: string): number {
    return this.listeners.get(conversationId)?.size ?? 0;
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  async prompt(
    conversationId: string,
    text: string,
    profile?: string
  ): Promise<void> {
    if (this.running.has(conversationId))
      throw new Error('Conversation is busy');
    const worker = await this.launcher.start(conversationId, profile); // validates the ID and profile
    // Re-check: another prompt may have won the race while the worker was starting.
    if (this.running.has(conversationId))
      throw new Error('Conversation is busy');
    this.setRunning(conversationId, true);
    this.liveSubagents.delete(conversationId);
    try {
      await this.launcher.commitProfile(conversationId);
    } catch (error) {
      this.setRunning(conversationId, false);
      throw error;
    }
    await this.startTurn(conversationId, worker, text);
  }

  /**
   * Edit a past user message, or regenerate its reply (omit `text`): fork Pi's
   * session from that entry, then prompt on the new branch. Pi writes the fork
   * to a new session file, so the original branch is never overwritten, and
   * nothing from the browser is replayed into the worker.
   */
  async forkAndPrompt(
    conversationId: string,
    entryId: string,
    text?: string
  ): Promise<void> {
    if (this.running.has(conversationId))
      throw new Error('Conversation is busy');
    const worker = await this.launcher.start(conversationId);
    if (this.running.has(conversationId))
      throw new Error('Conversation is busy');
    this.setRunning(conversationId, true); // blocks other prompts during the fork
    this.liveSubagents.delete(conversationId);
    let promptText: string;
    try {
      const forked = (await worker.rpc.command('fork', { entryId })) as
        | { text?: string; cancelled?: boolean }
        | undefined;
      if (forked?.cancelled)
        throw new Error('The fork was cancelled by an extension');
      // Remember the new branch before anything else can go wrong.
      await this.launcher.recordCurrentSession(conversationId);
      promptText = text ?? forked?.text ?? '';
      if (!promptText)
        throw new Error('There is no text to send for this message');
      await this.emitSnapshot(conversationId);
    } catch (error) {
      this.setRunning(conversationId, false);
      throw this.withWorkerDetail(error, worker);
    }
    await this.startTurn(conversationId, worker, promptText);
  }

  private async startTurn(
    conversationId: string,
    worker: {
      rpc: {
        command(
          type: string,
          params?: Record<string, unknown>
        ): Promise<unknown>;
      };
      stderrTail(): string;
    },
    text: string
  ): Promise<void> {
    try {
      const result = (await worker.rpc.command('prompt', { message: text })) as
        | { disposition?: string }
        | undefined;
      // A "handled" prompt (e.g. an extension command) starts no run, so no agent_settled will follow.
      if (result?.disposition === 'handled')
        this.setRunning(conversationId, false);
    } catch (error) {
      this.setRunning(conversationId, false);
      throw this.withWorkerDetail(error, worker);
    }
  }

  // A generic "transport closed" hides why the worker died; include its stderr.
  private withWorkerDetail(
    error: unknown,
    worker: { stderrTail(): string }
  ): unknown {
    const detail = worker.stderrTail().trim().slice(-400);
    return detail && error instanceof Error
      ? new Error(`${error.message}: ${detail}`, { cause: error })
      : error;
  }

  /** Answer a pending extension dialog. Throws if it is unknown, stale or invalid. */
  respondDialog(
    conversationId: string,
    dialogId: string,
    answer: DialogAnswer
  ): void {
    const broker = this.brokers.get(conversationId);
    if (!broker) throw new Error('Unknown or already answered dialog');
    broker.respond(dialogId, answer);
  }

  async abort(conversationId: string): Promise<void> {
    if (!this.running.has(conversationId)) return;
    const worker = await this.launcher.start(conversationId);
    await worker.rpc.command('abort');
  }

  /** Authoritative state from Pi itself; starts an idle worker if none is running. */
  async snapshot(conversationId: string): Promise<{
    running: boolean;
    messages: unknown[];
    dialogs: DialogRequest[];
    leafId: string | null;
    canvas: CanvasPayload | null;
    subagents: SubagentView[];
    profile: string | null;
  }> {
    const worker = await this.launcher.start(conversationId);
    return {
      running: this.running.has(conversationId),
      ...(await this.readState(conversationId, worker)),
    };
  }

  /** The active branch with Pi's entry IDs, from the session entries themselves. */
  private async readState(
    conversationId: string,
    worker: { rpc: { command(type: string): Promise<unknown> } }
  ): Promise<{
    messages: unknown[];
    dialogs: DialogRequest[];
    leafId: string | null;
    canvas: CanvasPayload | null;
    subagents: SubagentView[];
    profile: string | null;
  }> {
    const data = (await worker.rpc.command('get_entries')) as {
      entries: Parameters<typeof activeBranchMessages>[0];
      leafId: string | null;
    };
    const messages = activeBranchMessages(data.entries, data.leafId);
    return {
      messages,
      dialogs: this.brokers.get(conversationId)?.list() ?? [],
      leafId: data.leafId ?? null,
      canvas: latestCanvas(messages),
      subagents: mergeSubagents(subagentsFromHistory(messages), [
        ...(this.liveSubagents.get(conversationId)?.values() ?? []),
      ]),
      profile: await this.launcher.profileOf(conversationId),
    };
  }

  private async emitSnapshot(
    conversationId: string,
    running = this.running.has(conversationId)
  ): Promise<void> {
    const worker = this.launcher.peek(conversationId);
    if (!worker) return;
    this.emit(conversationId, {
      v: PROTOCOL_VERSION,
      conversationId,
      type: 'snapshot',
      running,
      ...(await this.readState(conversationId, worker)),
    });
  }

  stop(conversationId: string): Promise<void> {
    return this.launcher.stop(conversationId);
  }

  async stopAll(): Promise<void> {
    await this.launcher.stopAll();
    for (const broker of this.brokers.values()) broker.dispose();
    this.brokers.clear();
  }

  private broker(conversationId: string): DialogBroker {
    let broker = this.brokers.get(conversationId);
    if (!broker) {
      broker = new DialogBroker({
        conversationId,
        emit: (event) => this.emit(conversationId, event),
        sendToWorker: (record) => {
          const worker = this.launcher.peek(conversationId);
          if (!worker) throw new Error('Agent process is not running');
          worker.rpc.send(record);
        },
        hasListeners: () => this.listenerCount(conversationId) > 0,
        timeoutMs: this.dialogTimeoutMs,
        graceMs: this.disconnectGraceMs,
      });
      this.brokers.set(conversationId, broker);
    }
    return broker;
  }

  private emit(conversationId: string, event: ServerEvent): void {
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try {
        listener(event);
      } catch {
        // A faulty listener must not affect the worker or other listeners.
      }
    }
  }

  private setRunning(conversationId: string, running: boolean): void {
    if (this.running.has(conversationId) === running) return;
    if (running) this.running.add(conversationId);
    else this.running.delete(conversationId);
    this.emit(conversationId, {
      v: PROTOCOL_VERSION,
      conversationId,
      type: 'status',
      running,
    });
  }

  private handlePiEvent(conversationId: string, event: unknown): void {
    if (
      event &&
      typeof event === 'object' &&
      this.broker(conversationId).handleRequest(
        event as Record<string, unknown>
      )
    ) {
      return;
    }
    for (const projected of projectPiEvent(conversationId, event)) {
      if (projected.type === 'settled') {
        void this.completeTurn(conversationId, projected);
      } else if (projected.type === 'subagent') {
        this.applySubagent(conversationId, projected.subagent);
      } else {
        this.emit(conversationId, projected);
      }
    }
  }

  /** Track a subagent and emit it only if it changed; late events cannot reopen a finished one. */
  private applySubagent(conversationId: string, next: SubagentView): void {
    let live = this.liveSubagents.get(conversationId);
    if (!live) this.liveSubagents.set(conversationId, (live = new Map()));
    const merged = mergeSubagent(live.get(next.id), next);
    if (!merged) return;
    live.set(next.id, merged);
    this.emit(conversationId, {
      v: PROTOCOL_VERSION,
      conversationId,
      type: 'subagent',
      subagent: merged,
    });
  }

  /** Whatever is still running when the turn ends or the worker dies is over. */
  private closeSubagents(
    conversationId: string,
    state: 'cancelled' | 'error',
    error: string
  ): void {
    for (const sub of [
      ...(this.liveSubagents.get(conversationId)?.values() ?? []),
    ])
      if (!isTerminal(sub.state))
        this.applySubagent(conversationId, {
          ...sub,
          state,
          ...(state === 'error' ? { error } : {}),
        });
  }

  /**
   * Pi has settled: publish its authoritative history (this is what gives live
   * messages their entry IDs and replaces any partial state), then report the
   * turn as finished.
   */
  private async completeTurn(
    conversationId: string,
    settled: ServerEvent
  ): Promise<void> {
    this.closeSubagents(
      conversationId,
      (settled as { aborted?: boolean }).aborted ? 'cancelled' : 'error',
      'The turn ended before this subagent returned'
    );
    try {
      await this.emitSnapshot(conversationId, false);
    } catch {
      // The worker may have died; the settled event below still ends the turn.
    }
    this.emit(conversationId, settled);
    this.setRunning(conversationId, false);
  }

  private handleExit(
    conversationId: string,
    info: { code: number | null; signal: string | null }
  ): void {
    // Questions asked by a dead process can never be answered.
    this.brokers.get(conversationId)?.workerExited();
    this.closeSubagents(
      conversationId,
      'error',
      'The agent process exited while this subagent was running'
    );
    if (!this.running.has(conversationId)) return;
    this.emit(conversationId, {
      v: PROTOCOL_VERSION,
      conversationId,
      type: 'error',
      message: `Agent process exited unexpectedly (${info.code ?? info.signal})`,
    });
    this.setRunning(conversationId, false);
  }
}
