import { CANVAS_TOOL, parseCanvas, type CanvasPayload } from './canvas.js';
import {
  SUBAGENT_TOOL,
  parseSubagent,
  type SubagentView,
} from './subagents.js';

/** Versioned browser protocol. Only {conversationId, text} ever reaches Pi for a prompt. */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_PROMPT_LENGTH = 100_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ENTRY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type DialogMethod = 'select' | 'confirm' | 'input' | 'editor';
export type DialogCloseReason =
  | 'answered'
  | 'cancelled'
  | 'timeout'
  | 'disconnected'
  | 'worker_exited';

/** A pending extension question, as shown to the browser. */
export interface DialogRequest {
  dialogId: string;
  method: DialogMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Epoch ms after which the gateway (or Pi) gives up waiting. */
  expiresAt?: number;
}

/** Exactly one of value / confirmed / cancelled. */
export type DialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export const MAX_DIALOG_VALUE_LENGTH = 100_000;

export type ClientCommand =
  | {
      v: 1;
      type: 'prompt';
      conversationId: string;
      text: string;
      /** Only honored on a conversation's first prompt; later it must match or be omitted. */
      profile?: string;
    }
  | ({
      v: 1;
      type: 'dialog_response';
      conversationId: string;
      dialogId: string;
    } & DialogAnswer)
  | { v: 1; type: 'abort'; conversationId: string }
  | {
      v: 1;
      type: 'edit';
      conversationId: string;
      entryId: string;
      text: string;
    }
  | {
      v: 1;
      type: 'regenerate';
      conversationId: string;
      entryId: string;
    }
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
  | { type: 'canvas'; canvas: CanvasPayload }
  | { type: 'subagent'; subagent: SubagentView }
  | {
      type: 'snapshot';
      running: boolean;
      messages: unknown[];
      dialogs: DialogRequest[];
      /** Pi's current leaf entry; changes when the active branch changes. */
      leafId: string | null;
      /** The canvas on the active branch, derived from history; null if none. */
      canvas?: CanvasPayload | null;
      /** Subagents on the active branch plus any still running. */
      subagents?: SubagentView[];
      /** The conversation's recorded tool profile; null until its first prompt. */
      profile?: string | null;
    }
  | ({ type: 'dialog_request' } & DialogRequest)
  | { type: 'dialog_closed'; dialogId: string; reason: DialogCloseReason }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'ui_unsupported'; method: string }
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
      if (
        r.profile !== undefined &&
        (typeof r.profile !== 'string' ||
          !/^[a-z][a-z0-9_-]{0,31}$/.test(r.profile))
      )
        invalid('profile');
      return {
        v: 1,
        type: 'prompt',
        conversationId,
        text: r.text,
        ...(r.profile !== undefined ? { profile: r.profile } : {}),
      };
    case 'dialog_response': {
      if (
        typeof r.dialogId !== 'string' ||
        r.dialogId.length === 0 ||
        r.dialogId.length > 200
      )
        invalid('dialogId');
      const base = {
        v: 1 as const,
        type: 'dialog_response' as const,
        conversationId,
        dialogId: r.dialogId,
      };
      const given = ['value', 'confirmed', 'cancelled'].filter(
        (key) => key in r
      );
      if (given.length !== 1)
        invalid('exactly one of value/confirmed/cancelled');
      if (given[0] === 'value') {
        if (
          typeof r.value !== 'string' ||
          r.value.length > MAX_DIALOG_VALUE_LENGTH
        )
          invalid('value');
        return { ...base, value: r.value };
      }
      if (given[0] === 'confirmed') {
        if (typeof r.confirmed !== 'boolean') invalid('confirmed');
        return { ...base, confirmed: r.confirmed };
      }
      if (r.cancelled !== true) invalid('cancelled');
      return { ...base, cancelled: true };
    }
    case 'edit':
    case 'regenerate': {
      if (typeof r.entryId !== 'string' || !ENTRY_ID_PATTERN.test(r.entryId))
        invalid('entryId');
      if (r.type === 'regenerate') {
        return {
          v: 1,
          type: 'regenerate',
          conversationId,
          entryId: r.entryId,
        };
      }
      if (
        typeof r.text !== 'string' ||
        r.text.length === 0 ||
        r.text.length > MAX_PROMPT_LENGTH
      )
        invalid('text');
      return {
        v: 1,
        type: 'edit',
        conversationId,
        entryId: r.entryId,
        text: r.text,
      };
    }
    case 'abort':
      return { v: 1, type: 'abort', conversationId };
    case 'subscribe':
      return { v: 1, type: 'subscribe', conversationId };
    default:
      return invalid('unknown type');
  }
}

type Obj = Record<string, unknown>;

const VISIBLE_ROLES = new Set(['user', 'assistant', 'toolResult']);

function isVisibleMessage(message: unknown): boolean {
  return VISIBLE_ROLES.has((message as { role?: string } | null)?.role ?? '');
}

/** Drop system prompts and internal roles before anything leaves the gateway. */
export function visibleMessages(messages: unknown[]): unknown[] {
  return messages.filter(isVisibleMessage);
}

/** Map one Pi event to zero or more client events. `agent_end` is deliberately not final idle. */
export function projectPiEvent(
  conversationId: string,
  event: unknown
): ServerEvent[] {
  return [
    ...projectGeneric(conversationId, event),
    ...projectSubagent(conversationId, event),
  ];
}

/**
 * Subagent lifecycle comes only from the run_subagent tool, which exists only
 * when the subagents extension is loaded. The ID is the tool call ID, never
 * a value from the payload.
 */
function projectSubagent(
  conversationId: string,
  event: unknown
): ServerEvent[] {
  if (!event || typeof event !== 'object') return [];
  const e = event as Obj;
  if (e.toolName !== SUBAGENT_TOOL) return [];
  const base = { v: PROTOCOL_VERSION, conversationId } as const;
  const id = String(e.toolCallId);
  if (e.type === 'tool_execution_start')
    return [
      {
        ...base,
        type: 'subagent',
        subagent: {
          id,
          task: String(
            (e.args as { task?: unknown } | undefined)?.task ?? ''
          ).slice(0, 500),
          state: 'running',
        },
      },
    ];
  if (e.type === 'tool_execution_update') {
    const subagent = parseSubagent(
      (e.partialResult as { details?: unknown } | undefined)?.details,
      id
    );
    return subagent ? [{ ...base, type: 'subagent', subagent }] : [];
  }
  if (e.type === 'tool_execution_end') {
    const subagent = parseSubagent(
      (e.result as { details?: unknown } | undefined)?.details,
      id
    ) ?? {
      id,
      task: '',
      state: 'error' as const,
      error: 'Subagent ended without a result',
    };
    return [{ ...base, type: 'subagent', subagent }];
  }
  return [];
}

function projectGeneric(conversationId: string, event: unknown): ServerEvent[] {
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
      return isVisibleMessage(e.message)
        ? [{ ...base, type: 'message', message: e.message }]
        : [];
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
    case 'tool_execution_end': {
      const canvas =
        e.toolName === CANVAS_TOOL && e.isError !== true
          ? parseCanvas(
              (e.result as { details?: unknown } | undefined)?.details
            )
          : null;
      return [
        {
          ...base,
          type: 'tool_end',
          toolCallId: String(e.toolCallId),
          toolName: String(e.toolName),
          result: e.result,
          isError: e.isError === true,
        },
        ...(canvas ? [{ ...base, type: 'canvas' as const, canvas }] : []),
      ];
    }
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
