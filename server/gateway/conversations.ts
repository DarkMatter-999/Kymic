import { WorkerLauncher, type LauncherConfig } from '../workers/launcher.js';
import { DialogBroker } from './dialogs.js';
import {
  PROTOCOL_VERSION,
  projectPiEvent,
  visibleMessages,
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

  async prompt(conversationId: string, text: string): Promise<void> {
    if (this.running.has(conversationId))
      throw new Error('Conversation is busy');
    const worker = await this.launcher.start(conversationId); // validates the ID
    // Re-check: another prompt may have won the race while the worker was starting.
    if (this.running.has(conversationId))
      throw new Error('Conversation is busy');
    this.setRunning(conversationId, true);
    try {
      const result = (await worker.rpc.command('prompt', { message: text })) as
        | { disposition?: string }
        | undefined;
      // A "handled" prompt (e.g. an extension command) starts no run, so no agent_settled will follow.
      if (result?.disposition === 'handled')
        this.setRunning(conversationId, false);
    } catch (error) {
      this.setRunning(conversationId, false);
      // A generic "transport closed" hides why the worker died; include its stderr.
      const detail = worker.stderrTail().trim().slice(-400);
      if (detail && error instanceof Error) {
        throw new Error(`${error.message}: ${detail}`, { cause: error });
      }
      throw error;
    }
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
  }> {
    const worker = await this.launcher.start(conversationId);
    const data = (await worker.rpc.command('get_messages')) as {
      messages: unknown[];
    };
    return {
      running: this.running.has(conversationId),
      messages: visibleMessages(data.messages),
      dialogs: this.brokers.get(conversationId)?.list() ?? [],
    };
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
      this.emit(conversationId, projected);
      if (projected.type === 'settled') this.setRunning(conversationId, false);
    }
  }

  private handleExit(
    conversationId: string,
    info: { code: number | null; signal: string | null }
  ): void {
    // Questions asked by a dead process can never be answered.
    this.brokers.get(conversationId)?.workerExited();
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
