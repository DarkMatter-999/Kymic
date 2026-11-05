import type { ModelInfo } from '../../server/gateway/models';

export type { ModelInfo };
export interface ModelRef {
  provider: string;
  id: string;
}
export interface ModelList {
  models: ModelInfo[];
  default: ModelRef | null;
}

async function request<T>(
  path: string,
  init?: { method: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`/api/pi/models${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.method ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.method ? JSON.stringify(init.body ?? {}) : undefined,
  });
  if (!response.ok) {
    const detail = await response
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return response.json();
}

export const modelsApi = {
  list: () => request<ModelList>(''),
  setDefault: (model: ModelRef) =>
    request<ModelRef>('/default', { method: 'POST', body: model }),
  /** Ask dynamic providers for their current models; returns providers that failed. */
  refresh: () => request<{ failed: string[] }>('/refresh', { method: 'POST' }),
};

/** A stable key for a model in a <select>. */
export const modelKey = (m: ModelRef): string =>
  JSON.stringify([m.provider, m.id]);
export const parseModelKey = (key: string): ModelRef | null => {
  try {
    const [provider, id] = JSON.parse(key) as [string, string];
    return typeof provider === 'string' && typeof id === 'string'
      ? { provider, id }
      : null;
  } catch {
    return null;
  }
};

/** Group models by provider for display, keeping the server's ordering. */
export function groupByProvider(
  models: ModelInfo[]
): { provider: string; providerName: string; models: ModelInfo[] }[] {
  const groups = new Map<
    string,
    { provider: string; providerName: string; models: ModelInfo[] }
  >();
  for (const m of models) {
    const g = groups.get(m.provider) ?? {
      provider: m.provider,
      providerName: m.providerName,
      models: [],
    };
    g.models.push(m);
    groups.set(m.provider, g);
  }
  return [...groups.values()];
}
