import type {
  AuthType,
  LoginEvent,
  LoginState,
  ProviderInfo,
} from '../../server/gateway/login';

export type { AuthType, LoginEvent, LoginState, ProviderInfo };

async function request<T>(
  path: string,
  init?: { method: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`/api/pi${path}`, {
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
  return response.status === 204 ? (undefined as T) : response.json();
}

export const providersApi = {
  list: () => request<ProviderInfo[]>('/providers'),
  current: () => request<LoginState | null>('/login'),
  start: (providerId: string, authType: AuthType) =>
    request<LoginState>('/login', {
      method: 'POST',
      body: { providerId, authType },
    }),
  respond: (
    loginId: string,
    promptId: string,
    answer: { value: string } | { cancelled: true }
  ) =>
    request<void>(`/login/${loginId}/respond`, {
      method: 'POST',
      body: { promptId, ...answer },
    }),
  cancel: (loginId: string) =>
    request<void>(`/login/${loginId}/cancel`, { method: 'POST' }),
  logout: (providerId: string) =>
    request<void>(`/providers/${providerId}/logout`, { method: 'POST' }),
  /** Replays the login so far, then streams; the server closes the stream when it ends. */
  watch(
    loginId: string,
    onEvent: (event: LoginEvent) => void
  ): () => void {
    const source = new EventSource(`/api/pi/login/${loginId}/events`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as LoginEvent;
      onEvent(event);
      if (
        event.type === 'done' ||
        event.type === 'failed' ||
        event.type === 'cancelled'
      )
        source.close();
    };
    // EventSource would otherwise reconnect forever after the server ends the stream.
    source.onerror = () => source.close();
    return () => source.close();
  },
};

/** Folds events into what the panel shows. Pure, so it is easy to test. */
export interface LoginView {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  link?: { url: string; instructions?: string };
  device?: { userCode: string; verificationUri: string };
  notes: string[];
  prompt?: Extract<LoginEvent, { type: 'prompt' }>;
  error?: string;
}

export function foldLoginEvents(events: LoginEvent[]): LoginView {
  const view: LoginView = { status: 'running', notes: [] };
  for (const e of events) {
    if (e.type === 'auth_url')
      view.link = { url: e.url, instructions: e.instructions };
    else if (e.type === 'device_code')
      view.device = { userCode: e.userCode, verificationUri: e.verificationUri };
    else if (e.type === 'info' || e.type === 'progress')
      view.notes = [...view.notes, e.message].slice(-5);
    else if (e.type === 'prompt') view.prompt = e;
    else if (e.type === 'prompt_closed') {
      if (view.prompt?.promptId === e.promptId) view.prompt = undefined;
    } else if (e.type === 'done') view.status = 'done';
    else if (e.type === 'cancelled') view.status = 'cancelled';
    else if (e.type === 'failed') {
      view.status = 'failed';
      view.error = e.message;
    }
  }
  return view;
}
