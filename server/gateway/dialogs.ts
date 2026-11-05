import {
  MAX_DIALOG_VALUE_LENGTH,
  PROTOCOL_VERSION,
  type DialogAnswer,
  type DialogCloseReason,
  type DialogMethod,
  type DialogRequest,
  type ServerEvent,
} from './protocol.js';

type Obj = Record<string, unknown>;
type EventBody = ServerEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'v' | 'conversationId'>
    : never
  : never;

const DIALOG_METHODS = new Set<string>([
  'select',
  'confirm',
  'input',
  'editor',
]);
const NOTIFY_LEVELS = new Set(['info', 'warning', 'error']);
/** Latency allowance past a Pi-side timeout before we forget the dialog. */
const DEFAULT_PI_TIMEOUT_GRACE_MS = 250;

export interface DialogBrokerOptions {
  conversationId: string;
  emit: (event: ServerEvent) => void;
  /** Write a record to the worker's stdin. May throw if the worker is gone. */
  sendToWorker: (record: Obj) => void;
  hasListeners: () => boolean;
  /** Deadline for dialogs that carry no Pi-side timeout. Expiry cancels (denies). */
  timeoutMs: number;
  /** Cancel pending dialogs after this long with no client connected. */
  graceMs: number;
  piTimeoutGraceMs?: number;
}

interface Pending {
  request: DialogRequest;
  /** True when Pi auto-resolves on its own timeout, so we must not answer after it. */
  piManaged: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks one conversation's extension dialogs. Every dialog gets exactly one
 * response (answer, cancel or silent expiry); nothing is ever approved on the
 * user's behalf, and duplicates or stale answers never reach Pi.
 */
export class DialogBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly unsupportedSeen = new Set<string>();
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: DialogBrokerOptions;

  constructor(options: DialogBrokerOptions) {
    this.options = options;
  }

  list(): DialogRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** Returns true when the record was an extension UI request (consumed here). */
  handleRequest(record: Obj): boolean {
    if (record.type !== 'extension_ui_request') return false;
    const method = record.method;
    if (typeof method !== 'string') return true;

    if (DIALOG_METHODS.has(method)) {
      this.openDialog(method as DialogMethod, record);
    } else if (method === 'notify') {
      const level = NOTIFY_LEVELS.has(String(record.notifyType))
        ? (record.notifyType as 'info' | 'warning' | 'error')
        : 'info';
      this.emit({
        type: 'notice',
        level,
        message: String(record.message ?? ''),
      });
    } else if (!this.unsupportedSeen.has(method)) {
      // Visible but quiet: once per method, never pretend it worked.
      this.unsupportedSeen.add(method);
      this.emit({ type: 'ui_unsupported', method });
    }
    return true;
  }

  respond(dialogId: string, answer: DialogAnswer): void {
    const entry = this.pending.get(dialogId);
    if (!entry) throw new Error('Unknown or already answered dialog');
    const record = this.validate(entry.request, answer);
    this.options.sendToWorker({
      type: 'extension_ui_response',
      id: dialogId,
      ...record,
    });
    this.close(dialogId, 'cancelled' in answer ? 'cancelled' : 'answered');
  }

  /** Call when a client attaches or detaches. */
  listenersChanged(): void {
    this.updateOrphanTimer();
  }

  /** The worker died: its questions are void, and there is no one to answer. */
  workerExited(): void {
    for (const id of [...this.pending.keys()]) this.close(id, 'worker_exited');
  }

  /** Release timers (does not answer anything). */
  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
  }

  private openDialog(method: DialogMethod, record: Obj): void {
    if (typeof record.id !== 'string' || record.id.length === 0) return;
    if (typeof record.title !== 'string') return;
    if (this.pending.has(record.id)) return;
    let options: string[] | undefined;
    if (method === 'select') {
      if (
        !Array.isArray(record.options) ||
        !record.options.every((o) => typeof o === 'string')
      )
        return;
      options = record.options as string[];
    }
    const id = record.id;
    const piTimeout =
      typeof record.timeout === 'number' && record.timeout > 0
        ? record.timeout
        : undefined;
    const waitMs = piTimeout
      ? piTimeout +
        (this.options.piTimeoutGraceMs ?? DEFAULT_PI_TIMEOUT_GRACE_MS)
      : this.options.timeoutMs;
    const request: DialogRequest = {
      dialogId: id,
      method,
      title: record.title,
      ...(typeof record.message === 'string' && { message: record.message }),
      ...(options && { options }),
      ...(typeof record.placeholder === 'string' && {
        placeholder: record.placeholder,
      }),
      ...(typeof record.prefill === 'string' && { prefill: record.prefill }),
      expiresAt: Date.now() + (piTimeout ?? this.options.timeoutMs),
    };
    const piManaged = piTimeout !== undefined;
    const timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      if (!piManaged) this.sendCancel(id);
      this.close(id, 'timeout');
    }, waitMs);
    timer.unref();
    this.pending.set(id, { request, piManaged, timer });
    this.emit({ type: 'dialog_request', ...request });
    this.updateOrphanTimer();
  }

  private validate(
    request: DialogRequest,
    answer: DialogAnswer
  ): Record<string, unknown> {
    if ('cancelled' in answer) return { cancelled: true };
    const { method } = request;
    if (method === 'confirm') {
      if (!('confirmed' in answer))
        throw new Error('A confirm dialog needs confirmed: true/false');
      return { confirmed: answer.confirmed };
    }
    if (!('value' in answer))
      throw new Error(`A ${method} dialog needs a value`);
    if (answer.value.length > MAX_DIALOG_VALUE_LENGTH)
      throw new Error('Value too large');
    if (method === 'select' && !request.options?.includes(answer.value)) {
      throw new Error('Value is not one of the offered options');
    }
    return { value: answer.value };
  }

  private sendCancel(id: string): void {
    try {
      this.options.sendToWorker({
        type: 'extension_ui_response',
        id,
        cancelled: true,
      });
    } catch {
      // The worker is gone; there is nothing left to answer.
    }
  }

  private close(id: string, reason: DialogCloseReason): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.emit({ type: 'dialog_closed', dialogId: id, reason });
    this.updateOrphanTimer();
  }

  private updateOrphanTimer(): void {
    const needed = this.pending.size > 0 && !this.options.hasListeners();
    if (!needed) {
      if (this.orphanTimer) clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
      return;
    }
    if (this.orphanTimer) return;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      if (this.options.hasListeners()) return;
      for (const id of [...this.pending.keys()]) {
        // Cancelling is safe even for Pi-timed dialogs: a late response is ignored.
        this.sendCancel(id);
        this.close(id, 'disconnected');
      }
    }, this.options.graceMs);
    this.orphanTimer.unref();
  }

  private emit(body: EventBody): void {
    this.options.emit({
      v: PROTOCOL_VERSION,
      conversationId: this.options.conversationId,
      ...body,
    } as ServerEvent);
  }
}
