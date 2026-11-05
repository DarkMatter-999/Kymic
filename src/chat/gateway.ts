import type { ServerEvent } from '../../server/gateway/protocol';

/** The subset of the WebSocket API the client uses (browser WebSocket and `ws` both fit). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface GatewayClientOptions {
  url: string;
  conversationId: string;
  onEvent: (event: ServerEvent) => void;
  onConnection?: (connected: boolean) => void;
  createSocket?: (url: string) => SocketLike;
  /** Reconnect delay bounds in ms. */
  minDelay?: number;
  maxDelay?: number;
}

const OPEN = 1;

/**
 * Connects to the Pi gateway, re-subscribes on every (re)connect so the server's
 * authoritative snapshot replaces local state, and never replays browser history.
 */
export class GatewayClient {
  private socket: SocketLike | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly options: GatewayClientOptions;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
      this.options.onConnection?.(false);
    }
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  prompt(text: string): boolean {
    return this.send({ type: 'prompt', text });
  }

  abort(): boolean {
    return this.send({ type: 'abort' });
  }

  /** Answer an extension dialog; exactly one of value / confirmed / cancelled. */
  respondDialog(
    dialogId: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): boolean {
    return this.send({ type: 'dialog_response', dialogId, ...answer });
  }

  private send(command: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(
      JSON.stringify({
        v: 1,
        conversationId: this.options.conversationId,
        ...command,
      })
    );
    return true;
  }

  private open(): void {
    const { url, createSocket } = this.options;
    const socket = createSocket
      ? createSocket(url)
      : (new WebSocket(url) as unknown as SocketLike);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.options.onConnection?.(true);
      this.send({ type: 'subscribe' });
    };
    socket.onmessage = (message) => {
      try {
        this.options.onEvent(JSON.parse(String(message.data)) as ServerEvent);
      } catch {
        // Ignore malformed frames; the next snapshot reconciles state.
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.options.onConnection?.(false);
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const min = this.options.minDelay ?? 500;
    const max = this.options.maxDelay ?? 10_000;
    const delay = Math.min(max, min * 2 ** this.attempts++);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, delay);
  }
}
