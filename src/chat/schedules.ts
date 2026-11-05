export interface ScheduleView {
  id: string;
  conversationId: string;
  prompt: string;
  timezone: string;
  everyMs: number;
  enabled: boolean;
  nextOccurrence: number;
}

export interface RunView {
  occurrenceId: string;
  dueAt: number;
  status: string;
  error: string | null;
  result: string | null;
}

async function request<T>(
  path: string,
  init?: { method: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`/api/schedules${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const detail = await response
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const schedulesApi = {
  list: () => request<ScheduleView[]>(''),
  create: (input: {
    conversationId: string;
    prompt: string;
    everyMs: number;
    timezone: string;
  }) => request<ScheduleView>('', { method: 'POST', body: input }),
  setEnabled: (id: string, enabled: boolean) =>
    request<void>(`/${id}/enabled`, { method: 'POST', body: { enabled } }),
  remove: (id: string) => request<void>(`/${id}`, { method: 'DELETE' }),
  runs: (id: string) => request<RunView[]>(`/${id}/runs`),
};
