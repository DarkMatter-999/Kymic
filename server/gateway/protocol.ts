/** Versioned browser protocol. Only {conversationId, text} ever reaches Pi for a prompt. */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_PROMPT_LENGTH = 100_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type ClientCommand =
  | { v: 1; type: 'prompt'; conversationId: string; text: string }
  | { v: 1; type: 'abort'; conversationId: string }
  | { v: 1; type: 'subscribe'; conversationId: string };

export type ServerEvent = { v: 1; conversationId: string } & (
  | { type: 'status'; running: boolean }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'message'; message: unknown }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_update';
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: 'settled'; aborted: boolean }
  | { type: 'snapshot'; running: boolean; messages: unknown[] }
  | { type: 'error'; message: string }
);

function invalid(reason: string): never {
  throw new Error(`Invalid command: ${reason}`);
}

export function parseClientCommand(raw: unknown): ClientCommand {
  if (!raw || typeof raw !== 'object') invalid('not an object');
  const r = raw as Record<string, unknown>;
  if (r.v !== PROTOCOL_VERSION) invalid('unsupported version');
  if (
    typeof r.conversationId !== 'string' ||
    !ID_PATTERN.test(r.conversationId)
  )
    invalid('conversationId');
  const conversationId = r.conversationId;
  switch (r.type) {
    case 'prompt':
      if (
        typeof r.text !== 'string' ||
        r.text.length === 0 ||
        r.text.length > MAX_PROMPT_LENGTH
      )
        invalid('text');
      return { v: 1, type: 'prompt', conversationId, text: r.text };
    case 'abort':
      return { v: 1, type: 'abort', conversationId };
    case 'subscribe':
      return { v: 1, type: 'subscribe', conversationId };
    default:
      return invalid('unknown type');
  }
}

type Obj = Record<string, unknown>;

/** Map one Pi event to zero or more client events. `agent_end` is deliberately not final idle. */
export function projectPiEvent(
  conversationId: string,
  event: unknown
): ServerEvent[] {
  if (!event || typeof event !== 'object') return [];
  const e = event as Obj;
  const base = { v: PROTOCOL_VERSION, conversationId } as const;
  switch (e.type) {
    case 'message_update': {
      const m = e.assistantMessageEvent as Obj | undefined;
      if (m?.type === 'text_delta')
        return [
          {
            ...base,
            type: 'text_delta',
            contentIndex: Number(m.contentIndex),
            delta: String(m.delta),
          },
        ];
      if (m?.type === 'thinking_delta')
        return [
          {
            ...base,
            type: 'thinking_delta',
            contentIndex: Number(m.contentIndex),
            delta: String(m.delta),
          },
        ];
      return [];
    }
    case 'message_end':
      return [{ ...base, type: 'message', message: e.message }];
    case 'tool_execution_start':
      return [
        {
          ...base,
          type: 'tool_start',
          toolCallId: String(e.toolCallId),
          toolName: String(e.toolName),
          args: e.args,
        },
      ];
    case 'tool_execution_update':
      return [
        {
          ...base,
          type: 'tool_update',
          toolCallId: String(e.toolCallId),
          toolName: String(e.toolName),
          partialResult: e.partialResult,
        },
      ];
    case 'tool_execution_end':
      return [
        {
          ...base,
          type: 'tool_end',
          toolCallId: String(e.toolCallId),
          toolName: String(e.toolName),
          result: e.result,
          isError: e.isError === true,
        },
      ];
    case 'agent_settled':
      return [{ ...base, type: 'settled', aborted: e.aborted === true }];
    case 'extension_error':
      return [
        {
          ...base,
          type: 'error',
          message: String(e.error ?? 'Extension error'),
        },
      ];
    default:
      return [];
  }
}
