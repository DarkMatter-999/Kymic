/** Subagent lifecycle as the browser sees it. Produced only by the run_subagent extension. */
export const SUBAGENT_TOOL = 'run_subagent';

export type SubagentState =
  | 'running'
  | 'tool_call'
  | 'finished'
  | 'error'
  | 'cancelled';

export interface SubagentView {
  /** The tool call ID of the run_subagent call: unique, and stable across reloads. */
  id: string;
  task: string;
  state: SubagentState;
  text?: string;
  result?: string;
  error?: string;
}

const STATES = new Set<string>([
  'running',
  'tool_call',
  'finished',
  'error',
  'cancelled',
]);
const MAX_TEXT = 50_000;
const MAX_TASK = 500;

export const isTerminal = (state: SubagentState): boolean =>
  state === 'finished' || state === 'error' || state === 'cancelled';

const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

/**
 * Validate the extension's structured details. The ID always comes from the
 * tool call, never from the payload, so a child cannot speak for another one.
 */
export function parseSubagent(
  details: unknown,
  id: string
): SubagentView | null {
  const s = (details as { subagent?: unknown } | null | undefined)?.subagent;
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (typeof o.state !== 'string' || !STATES.has(o.state)) return null;
  return {
    id,
    task: clip(o.task, MAX_TASK) ?? '',
    state: o.state as SubagentState,
    text: clip(o.text, MAX_TEXT),
    result: clip(o.result, MAX_TEXT),
    error: clip(o.error, 500),
  };
}

/**
 * Fold an update into the known state. A finished, failed or cancelled
 * subagent never goes back to running, so out-of-order or late events are
 * ignored. Returns null when the update changes nothing.
 */
export function mergeSubagent(
  known: SubagentView | undefined,
  next: SubagentView
): SubagentView | null {
  if (known && isTerminal(known.state)) return null;
  const merged = { ...known, ...next, task: next.task || known?.task || '' };
  if (
    known &&
    known.state === merged.state &&
    known.text === merged.text &&
    known.result === merged.result &&
    known.error === merged.error
  )
    return null;
  return merged;
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .map((b: { type?: string; text?: string }) =>
      b?.type === 'text' ? (b.text ?? '') : ''
    )
    .join('');

/** Completed subagents on the active branch, from the extension's own tool results. */
export function subagentsFromHistory(
  messages: readonly unknown[]
): SubagentView[] {
  const out: SubagentView[] = [];
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      details?: unknown;
      content?: unknown;
    };
    if (m.role !== 'toolResult' || m.toolName !== SUBAGENT_TOOL) continue;
    if (typeof m.toolCallId !== 'string') continue;
    const parsed = parseSubagent(m.details, m.toolCallId);
    if (parsed) out.push(parsed);
    else
      out.push({
        id: m.toolCallId,
        task: '',
        state: 'error',
        error: textOf(m.content).slice(0, 500) || 'Subagent failed',
      });
  }
  return out;
}

/** History first, then live-only entries; a live update never reopens a finished subagent. */
export function mergeSubagents(
  history: readonly SubagentView[],
  live: readonly SubagentView[]
): SubagentView[] {
  const byId = new Map(history.map((s) => [s.id, s]));
  for (const l of live) {
    const known = byId.get(l.id);
    if (!known) byId.set(l.id, l);
    else if (!isTerminal(known.state) || isTerminal(l.state))
      byId.set(l.id, isTerminal(known.state) && !l.result ? known : l);
  }
  return [...byId.values()];
}
