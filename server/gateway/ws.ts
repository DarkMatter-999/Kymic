import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ConversationManager } from './conversations.js';
import {
  PROTOCOL_VERSION,
  parseClientCommand,
  type DialogAnswer,
  type ServerEvent,
} from './protocol.js';

export interface GatewayOptions {
  manager: ConversationManager;
  /** Exact Origin values allowed to connect. A missing Origin is rejected. */
  allowedOrigins: string[];
  /** Single-user authentication hook; must not read credentials from the URL. */
  authenticate?: (req: IncomingMessage) => boolean | Promise<boolean>;
  path?: string;
  /** Leave upgrades for other paths to other handlers instead of destroying them. */
  passthrough?: boolean;
  maxPayload?: number;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

export function attachGateway(
  server: Server,
  options: GatewayOptions
): WebSocketServer {
  const path = options.path ?? '/gateway';
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayload ?? 1024 * 1024,
  });

  server.on('upgrade', async (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      // fall through: not our path
    }
    if (pathname !== path) {
      if (!options.passthrough) reject(socket, 404, 'Not Found');
      return;
    }
    const origin = req.headers.origin;
    if (!origin || !options.allowedOrigins.includes(origin)) {
      reject(socket, 403, 'Forbidden');
      return;
    }
    try {
      if (options.authenticate && !(await options.authenticate(req))) {
        reject(socket, 401, 'Unauthorized');
        return;
      }
    } catch {
      reject(socket, 500, 'Internal Server Error');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, options));
  });

  return wss;
}

function handleConnection(ws: WebSocket, { manager }: GatewayOptions): void {
  const subscriptions = new Map<string, () => void>();

  const send = (event: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const fail = (conversationId: string, message: string) =>
    send({ v: PROTOCOL_VERSION, conversationId, type: 'error', message });

  const ensureSubscribed = (conversationId: string) => {
    if (!subscriptions.has(conversationId)) {
      subscriptions.set(
        conversationId,
        manager.subscribe(conversationId, send)
      );
    }
  };

  ws.on('message', async (data) => {
    let conversationId = '';
    try {
      const raw: unknown = JSON.parse(data.toString());
      const id = (raw as { conversationId?: unknown } | null)?.conversationId;
      if (typeof id === 'string') conversationId = id;
      const command = parseClientCommand(raw);
      ensureSubscribed(command.conversationId);
      if (command.type === 'subscribe') {
        const snapshot = await manager.snapshot(command.conversationId);
        send({
          v: PROTOCOL_VERSION,
          conversationId: command.conversationId,
          type: 'snapshot',
          ...snapshot,
        });
      } else if (command.type === 'dialog_response') {
        const answer: DialogAnswer =
          'value' in command
            ? { value: command.value }
            : 'confirmed' in command
              ? { confirmed: command.confirmed }
              : { cancelled: true };
        manager.respondDialog(command.conversationId, command.dialogId, answer);
      } else if (command.type === 'prompt') {
        await manager.prompt(command.conversationId, command.text);
      } else {
        await manager.abort(command.conversationId);
      }
    } catch (error) {
      fail(
        conversationId,
        error instanceof Error ? error.message : 'Request failed'
      );
    }
  });

  ws.on('close', () => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });
  ws.on('error', () => ws.terminate());
}
