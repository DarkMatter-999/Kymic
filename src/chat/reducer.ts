import type { CanvasPayload } from '../../server/gateway/canvas';
import type { DialogRequest, ServerEvent } from '../../server/gateway/protocol';
import {
  mergeSubagent,
  type SubagentView,
} from '../../server/gateway/subagents';

/** Actions that originate in the browser, never on the wire. */
export type LocalAction =
  | { type: 'dismiss_notice' }
  | { type: 'dismiss_unsupported' };

export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/** Presentation parts understood by AgentMessage / UserMessage / ToolCallBlock. */
export interface ChatPart {
  type: string;
  text?: string;
  toolCallId?: string;
  input?: { code?: string };
  output?: { result?: string };
  errorText?: string;
  contentIndex?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
  draft?: boolean;
  /** Pi's stable session entry ID; absent until the post-turn snapshot arrives. */
  entryId?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  error: string | null;
  /** Extension questions waiting for the user, oldest first. */
  dialogs: DialogRequest[];
  notice: Notice | null;
  /** Extension UI methods this app cannot render, each listed once. */
  unsupported: string[];
  /** The canvas on the active branch, or null. */
  canvas: CanvasPayload | null;
  /** Bumps only when the agent shows a canvas live, so the pane opens then and not on reload. */
  canvasRevision: number;
  /** Subagents in the order they started; the server owns their lifecycle. */
  subagents: SubagentView[];
  /** The conversation's recorded tool profile; null until its first prompt. */
  profile: string | null;
  /** The model the conversation's Pi process is using, or null if unknown. */
  model: { provider: string; id: string } | null;
  seq: number;
}

export const initialState: ChatState = {
  messages: [],
  running: false,
  error: null,
  dialogs: [],
  notice: null,
  unsupported: [],
  canvas: null,
  canvasRevision: 0,
  subagents: [],
  profile: null,
  model: null,
  seq: 0,
};

type Block = { type?: string; [key: string]: unknown };
type PiMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  entryId?: string;
  toolCallId?: string;
  isError?: boolean;
};

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((b: Block) => (b.type === 'text' ? String(b.text ?? '') : ''))
      .join('');
  }
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((b: Block) => (b.type === 'text' ? String(b.text ?? '') : ''))
        .join('');
    }
  }
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

function codeFor(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.code === 'string') return a.code;
  if (typeof a.command === 'string') return a.command;
  return JSON.stringify(args ?? {}, null, 2);
}

function toolPart(
  toolCallId: string,
  toolName: string,
  args: unknown
): ChatPart {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    input: { code: codeFor(args) },
    output: {},
  };
}

function assistantParts(content: unknown): ChatPart[] {
  if (!Array.isArray(content)) return [];
  const parts: ChatPart[] = [];
  for (const block of content as Block[]) {
    if (block.type === 'text' && block.text) {
      parts.push({ type: 'text', text: String(block.text) });
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push({ type: 'reasoning', text: String(block.thinking) });
    } else if (block.type === 'toolCall') {
      parts.push(
        toolPart(String(block.id), String(block.name), block.arguments)
      );
    }
  }
  return parts;
}

function findTool(
  messages: ChatMessage[],
  toolCallId: string
): ChatPart | undefined {
  for (const m of messages) {
    const part = m.parts.find((p) => p.toolCallId === toolCallId);
    if (part) return part;
  }
  return undefined;
}

function applyToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  result: unknown,
  isError: boolean
): void {
  const part = findTool(messages, toolCallId);
  if (!part) return;
  const text = textOf(result);
  part.output = { result: text };
  if (isError) part.errorText = text || 'Tool failed';
  else delete part.errorText;
}

/** Convert Pi's authoritative message list into presentation messages. */
export function messagesFromPi(piMessages: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  piMessages.forEach((raw, index) => {
    const m = raw as PiMessage;
    if (m.role === 'user') {
      out.push({
        id: `pi-${index}`,
        role: 'user',
        parts: [{ type: 'text', text: textOf(m.content) }],
        ...(m.entryId && { entryId: m.entryId }),
      });
    } else if (m.role === 'assistant') {
      const parts = assistantParts(m.content);
      if (parts.length)
        out.push({
          id: `pi-${index}`,
          role: 'assistant',
          parts,
          ...(m.entryId && { entryId: m.entryId }),
        });
    } else if (m.role === 'toolResult' && m.toolCallId) {
      applyToolResult(out, m.toolCallId, m, m.isError === true);
    }
  });
  return out;
}

function ensureDraft(state: ChatState, draft: ChatMessage[]): ChatMessage {
  const last = draft[draft.length - 1];
  if (last?.role === 'assistant' && last.draft) return last;
  const created: ChatMessage = {
    id: `draft-${state.seq}`,
    role: 'assistant',
    parts: [],
    draft: true,
  };
  draft.push(created);
  return created;
}

function clone(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => ({
      ...p,
      input: p.input && { ...p.input },
      output: p.output && { ...p.output },
    })),
  }));
}

export function reduce(
  state: ChatState,
  event: ServerEvent | LocalAction
): ChatState {
  const messages = clone(state.messages);
  const next: ChatState = { ...state, messages, seq: state.seq + 1 };

  switch (event.type) {
    case 'status':
      next.running = event.running;
      if (event.running) next.error = null;
      return next;
    case 'settled':
      next.running = false;
      return next;
    case 'error':
      next.error = event.message;
      return next;
    case 'snapshot':
      return {
        ...next,
        messages: messagesFromPi(event.messages),
        running: event.running,
        error: null,
        dialogs: event.dialogs ?? [],
        canvas: event.canvas ?? null,
        subagents: event.subagents ?? [],
        profile: event.profile ?? null,
        model: event.model ?? null,
      };
    case 'subagent': {
      const index = state.subagents.findIndex(
        (a) => a.id === event.subagent.id
      );
      const merged = mergeSubagent(state.subagents[index], event.subagent);
      if (!merged) return state;
      const subagents = [...state.subagents];
      if (index >= 0) subagents[index] = merged;
      else subagents.push(merged);
      return { ...next, subagents };
    }
    case 'canvas':
      return {
        ...next,
        canvas: event.canvas,
        canvasRevision: state.canvasRevision + 1,
      };
    case 'dialog_request': {
      const { v: _v, conversationId: _c, type: _t, ...dialog } = event;
      void _v;
      void _c;
      void _t;
      if (state.dialogs.some((d) => d.dialogId === dialog.dialogId))
        return state;
      return { ...next, dialogs: [...state.dialogs, dialog] };
    }
    case 'dialog_closed':
      return {
        ...next,
        dialogs: state.dialogs.filter((d) => d.dialogId !== event.dialogId),
      };
    case 'notice':
      return {
        ...next,
        notice: { level: event.level, message: event.message },
      };
    case 'ui_unsupported':
      return state.unsupported.includes(event.method)
        ? state
        : { ...next, unsupported: [...state.unsupported, event.method] };
    case 'dismiss_notice':
      return { ...next, notice: null };
    case 'dismiss_unsupported':
      return { ...next, unsupported: [] };
    case 'text_delta':
    case 'thinking_delta': {
      const type = event.type === 'text_delta' ? 'text' : 'reasoning';
      const draft = ensureDraft(next, messages);
      const part = draft.parts.find(
        (p) => p.type === type && p.contentIndex === event.contentIndex
      );
      if (part) part.text = (part.text ?? '') + event.delta;
      else
        draft.parts.push({
          type,
          text: event.delta,
          contentIndex: event.contentIndex,
        });
      return next;
    }
    case 'message': {
      const m = event.message as PiMessage;
      if (m.role === 'user') {
        messages.push({
          id: `user-${next.seq}`,
          role: 'user',
          parts: [{ type: 'text', text: textOf(m.content) }],
        });
      } else if (m.role === 'assistant') {
        const parts = assistantParts(m.content);
        const last = messages[messages.length - 1];
        const hasDraft = last?.role === 'assistant' && last.draft;
        if (hasDraft) messages.pop();
        if (parts.length)
          messages.push({
            id: `assistant-${next.seq}`,
            role: 'assistant',
            parts,
          });
        if (m.stopReason === 'error') {
          next.error = m.errorMessage ?? 'The model request failed';
        }
      } else if (m.role === 'toolResult' && m.toolCallId) {
        applyToolResult(messages, m.toolCallId, m, m.isError === true);
      }
      return next;
    }
    case 'tool_start': {
      if (!findTool(messages, event.toolCallId)) {
        const last = messages[messages.length - 1];
        const host =
          last?.role === 'assistant'
            ? last
            : messages[
                messages.push({
                  id: `assistant-${next.seq}`,
                  role: 'assistant',
                  parts: [],
                }) - 1
              ];
        host.parts.push(toolPart(event.toolCallId, event.toolName, event.args));
      }
      return next;
    }
    case 'tool_update': {
      const part = findTool(messages, event.toolCallId);
      if (part) part.output = { result: textOf(event.partialResult) };
      return next;
    }
    case 'tool_end':
      applyToolResult(messages, event.toolCallId, event.result, event.isError);
      return next;
    default:
      return state;
  }
}
