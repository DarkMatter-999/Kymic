/** The canvas the agent last showed. Shared by the live event and the history snapshot. */
export interface CanvasPayload {
  html: string;
  css: string;
  js: string;
}

export const CANVAS_TOOL = 'update_canvas';
/** Per field; also bounded by the 1 MB WebSocket frame limit. */
export const MAX_CANVAS_FIELD = 200_000;

/** Accept only the exact shape the canvas extension produces; anything else is not a canvas. */
export function parseCanvas(details: unknown): CanvasPayload | null {
  const canvas = (details as { canvas?: unknown } | null | undefined)?.canvas;
  if (!canvas || typeof canvas !== 'object') return null;
  const c = canvas as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ['html', 'css', 'js']) {
    const value = c[key];
    if (typeof value !== 'string' || value.length > MAX_CANVAS_FIELD)
      return null;
    out[key] = value;
  }
  return out as unknown as CanvasPayload;
}

/** The canvas on the active branch: the newest successful canvas tool result. */
export function latestCanvas(
  messages: readonly unknown[]
): CanvasPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role?: string;
      toolName?: string;
      isError?: boolean;
      details?: unknown;
    };
    if (m.role === 'toolResult' && m.toolName === CANVAS_TOOL && !m.isError) {
      const canvas = parseCanvas(m.details);
      if (canvas) return canvas;
    }
  }
  return null;
}
