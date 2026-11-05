import { randomUUID } from 'node:crypto';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

/** The slice of Pi's `ModelRuntime` the login flow needs (kept narrow so it can be faked). */
export interface LoginRuntime {
  getProviders(): readonly {
    id: string;
    name: string;
    auth: {
      apiKey?: { name: string; login?: unknown };
      oauth?: { name: string; loginLabel?: string; isSubscription?: boolean };
    };
  }[];
  listCredentials(): Promise<readonly { providerId: string; type: string }[]>;
  login(
    providerId: string,
    type: 'api_key' | 'oauth',
    interaction: {
      signal?: AbortSignal;
      prompt(prompt: PiPrompt): Promise<string>;
      notify(event: PiEvent): void;
    }
  ): Promise<unknown>;
  logout(providerId: string): Promise<void>;
}

type PiPrompt = {
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
  signal?: AbortSignal;
};
type PiEvent = { type: string } & Record<string, unknown>;

export type AuthType = 'api_key' | 'oauth';

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  methods: { type: AuthType; label: string; interactive: boolean }[];
}

/** What the browser sees for a login. Secrets are never included. */
export type LoginEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'progress'; message: string }
  | {
      type: 'prompt';
      promptId: string;
      kind: 'text' | 'secret' | 'select' | 'manual_code';
      message: string;
      placeholder?: string;
      options?: { id: string; label: string; description?: string }[];
    }
  | { type: 'prompt_closed'; promptId: string }
  | { type: 'done' }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' };

export interface LoginState {
  loginId: string;
  providerId: string;
  authType: AuthType;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  events: LoginEvent[];
}

interface Session extends LoginState {
  abort: AbortController;
  prompt?: {
    id: string;
    kind: string;
    options?: string[];
    resolve(v: string): void;
    reject(e: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  listeners: Set<(e: LoginEvent) => void>;
}

const MAX_EVENTS = 50;
const MAX_VALUE = 20_000;

/** Only web links ever reach the browser; anything else (javascript:, data:) is dropped. */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:'
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

const text = (v: unknown, max = 1000): string =>
  typeof v === 'string' ? v.slice(0, max) : '';

/**
 * Drives Pi's SDK login for one provider at a time (single-user app). The flow
 * runs in the gateway; credentials are written by Pi's own credential store.
 */
export class LoginManager {
  private session: Session | undefined;
  private readonly runtime: LoginRuntime;
  private readonly promptTimeoutMs: number;

  constructor(
    runtime: LoginRuntime,
    options: { promptTimeoutMs?: number } = {}
  ) {
    this.runtime = runtime;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 10 * 60_000;
  }

  async providers(): Promise<ProviderInfo[]> {
    const configured = new Set(
      (await this.runtime.listCredentials()).map((c) => c.providerId)
    );
    return this.runtime
      .getProviders()
      .map((p) => {
        const methods: ProviderInfo['methods'] = [];
        if (p.auth.oauth)
          methods.push({
            type: 'oauth',
            label: p.auth.oauth.loginLabel ?? p.auth.oauth.name,
            interactive: true,
          });
        if (p.auth.apiKey?.login)
          methods.push({
            type: 'api_key',
            label: p.auth.apiKey.name,
            interactive: true,
          });
        return {
          id: p.id,
          name: p.name,
          configured: configured.has(p.id),
          methods,
        };
      })
      .filter((p) => p.methods.length > 0);
  }

  current(): LoginState | undefined {
    return this.session ? this.publicState(this.session) : undefined;
  }

  async start(providerId: string, authType: AuthType): Promise<LoginState> {
    if (this.session?.status === 'running')
      throw new Error('A login is already in progress');
    const provider = (await this.providers()).find((p) => p.id === providerId);
    if (!provider) throw new Error('Unknown provider');
    if (!provider.methods.some((m) => m.type === authType))
      throw new Error('That sign-in method is not available for this provider');

    const session: Session = {
      loginId: randomUUID(),
      providerId,
      authType,
      status: 'running',
      events: [],
      abort: new AbortController(),
      listeners: new Set(),
    };
    this.session = session;

    const interaction = {
      signal: session.abort.signal,
      notify: (event: PiEvent) => this.onNotify(session, event),
      prompt: (prompt: PiPrompt) => this.onPrompt(session, prompt),
    };
    this.runtime
      .login(providerId, authType, interaction)
      .then(() => this.finish(session, 'done', { type: 'done' }))
      .catch((error: unknown) => {
        if (session.status !== 'running') return;
        if (session.abort.signal.aborted)
          this.finish(session, 'cancelled', { type: 'cancelled' });
        else
          this.finish(session, 'failed', {
            type: 'failed',
            message: text(
              error instanceof Error ? error.message : 'Login failed',
              300
            ),
          });
      });
    return this.publicState(session);
  }

  /** Answer the pending prompt, or cancel it with `cancelled`. */
  respond(
    loginId: string,
    promptId: string,
    answer: { value: string } | { cancelled: true }
  ): void {
    const s = this.session;
    if (!s || s.loginId !== loginId || s.status !== 'running')
      throw new Error('No such login');
    const p = s.prompt;
    if (!p || p.id !== promptId) throw new Error('Stale or unknown prompt');
    if ('cancelled' in answer) {
      this.closePrompt(s);
      p.reject(new Error('Cancelled'));
      return;
    }
    if (
      typeof answer.value !== 'string' ||
      answer.value.length > MAX_VALUE ||
      (p.kind !== 'secret' && answer.value.length === 0)
    )
      throw new Error('Invalid value');
    if (p.kind === 'select' && !p.options?.includes(answer.value))
      throw new Error('Not one of the offered options');
    this.closePrompt(s);
    p.resolve(answer.value);
  }

  cancel(loginId: string): void {
    const s = this.session;
    if (!s || s.loginId !== loginId || s.status !== 'running') return;
    s.abort.abort();
    s.prompt?.reject(new Error('Cancelled'));
    this.closePrompt(s);
    this.finish(s, 'cancelled', { type: 'cancelled' });
  }

  async logout(providerId: string): Promise<void> {
    if (this.session?.status === 'running')
      throw new Error('A login is in progress');
    if (!(await this.providers()).some((p) => p.id === providerId))
      throw new Error('Unknown provider');
    await this.runtime.logout(providerId);
  }

  /** Replays everything so far, then streams. Returns an unsubscribe function. */
  subscribe(loginId: string, listener: (e: LoginEvent) => void): () => void {
    const s = this.session;
    if (!s || s.loginId !== loginId) throw new Error('No such login');
    for (const e of s.events) listener(e);
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  close(): void {
    if (this.session?.status === 'running') this.cancel(this.session.loginId);
  }

  // --- internals -----------------------------------------------------------

  private publicState(s: Session): LoginState {
    return {
      loginId: s.loginId,
      providerId: s.providerId,
      authType: s.authType,
      status: s.status,
      events: [...s.events],
    };
  }

  private push(s: Session, event: LoginEvent): void {
    // Keep the head (the sign-in link) and drop the oldest progress noise.
    s.events.push(event);
    if (s.events.length > MAX_EVENTS) s.events.splice(1, 1);
    for (const l of s.listeners) {
      try {
        l(event);
      } catch {
        // one broken listener must not affect the flow
      }
    }
  }

  private finish(
    s: Session,
    status: Session['status'],
    event: LoginEvent
  ): void {
    if (s.status !== 'running') return;
    s.status = status;
    this.closePrompt(s);
    this.push(s, event);
  }

  private onNotify(s: Session, e: PiEvent): void {
    if (s.status !== 'running') return;
    if (e.type === 'auth_url') {
      const url = safeUrl(e.url);
      if (url)
        this.push(s, {
          type: 'auth_url',
          url,
          instructions: text(e.instructions) || undefined,
        });
    } else if (e.type === 'device_code') {
      const verificationUri = safeUrl(e.verificationUri);
      if (verificationUri)
        this.push(s, {
          type: 'device_code',
          userCode: text(e.userCode, 100),
          verificationUri,
          expiresInSeconds:
            typeof e.expiresInSeconds === 'number'
              ? e.expiresInSeconds
              : undefined,
        });
    } else if (e.type === 'info') {
      const links = (Array.isArray(e.links) ? e.links : [])
        .map((l: { url?: unknown; label?: unknown }) => ({
          url: safeUrl(l?.url),
          label: text(l?.label, 100) || undefined,
        }))
        .filter((l): l is { url: string; label: string | undefined } =>
          Boolean(l.url)
        );
      this.push(s, { type: 'info', message: text(e.message), links });
    } else if (e.type === 'progress') {
      this.push(s, { type: 'progress', message: text(e.message) });
    }
  }

  private onPrompt(s: Session, prompt: PiPrompt): Promise<string> {
    if (s.status !== 'running') return Promise.reject(new Error('Cancelled'));
    if (s.prompt) {
      // Pi races a manual-code prompt against a callback server; a newer prompt supersedes.
      s.prompt.reject(new Error('Superseded'));
      this.closePrompt(s);
    }
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (s.prompt?.id === id) {
          this.closePrompt(s);
          reject(new Error('Timed out waiting for input'));
        }
      }, this.promptTimeoutMs);
      const settle = () => clearTimeout(timer);
      s.prompt = {
        id,
        kind: prompt.type,
        options: prompt.options?.map((o) => o.id),
        resolve: (v) => {
          settle();
          resolve(v);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
        timer,
      };
      // Pi cancels a prompt when an out-of-band event wins (e.g. the callback arrived).
      prompt.signal?.addEventListener(
        'abort',
        () => {
          if (s.prompt?.id === id) {
            this.closePrompt(s);
            reject(new Error('Prompt cancelled'));
          }
        },
        { once: true }
      );
      this.push(s, {
        type: 'prompt',
        promptId: id,
        kind: prompt.type,
        message: text(prompt.message),
        placeholder: text(prompt.placeholder, 200) || undefined,
        options: prompt.options?.map((o) => ({
          id: text(o.id, 200),
          label: text(o.label, 200),
          description: text(o.description, 400) || undefined,
        })),
      });
    });
  }

  private closePrompt(s: Session): void {
    const p = s.prompt;
    if (!p) return;
    s.prompt = undefined;
    clearTimeout(p.timer);
    this.push(s, { type: 'prompt_closed', promptId: p.id });
  }
}

export interface LoginRouterOptions {
  login: LoginManager;
  allowedOrigins: string[];
  authenticate: (req: Request) => boolean | Promise<boolean>;
}

/** Authenticated provider sign-in controls. State-changing calls check Origin (CSRF). */
export function createLoginRouter(options: LoginRouterOptions): express.Router {
  const { login } = options;
  const router = express.Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await options.authenticate(req))) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    } catch {
      res.status(500).json({ error: 'Authentication failed' });
      return;
    }
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (!origin || !options.allowedOrigins.includes(origin)) {
        res.status(403).json({ error: 'Forbidden origin' });
        return;
      }
      if (!req.is('application/json')) {
        res
          .status(415)
          .json({ error: 'Content-Type must be application/json' });
        return;
      }
    }
    next();
  });

  const fail = (res: Response, error: unknown, status = 400) =>
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Request failed',
    });

  router.get('/providers', async (_req, res) => {
    try {
      res.json(await login.providers());
    } catch (e) {
      fail(res, e, 500);
    }
  });

  router.post('/providers/:id/logout', async (req, res) => {
    try {
      await login.logout(String(req.params.id));
      res.status(204).end();
    } catch (e) {
      fail(res, e);
    }
  });

  router.get('/login', (_req, res) => {
    res.json(login.current() ?? null);
  });

  router.post('/login', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.providerId !== 'string' ||
      (body.authType !== 'oauth' && body.authType !== 'api_key')
    ) {
      fail(res, new Error('providerId and authType are required'));
      return;
    }
    try {
      res.status(201).json(await login.start(body.providerId, body.authType));
    } catch (e) {
      fail(res, e, 409);
    }
  });

  router.post('/login/:id/respond', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (typeof body.promptId !== 'string') throw new Error('promptId');
      login.respond(
        String(req.params.id),
        body.promptId,
        body.cancelled === true
          ? { cancelled: true }
          : { value: body.value as string }
      );
      res.status(204).end();
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/login/:id/cancel', (req, res) => {
    login.cancel(String(req.params.id));
    res.status(204).end();
  });

  // Server-sent events: replay, then live. Same-origin cookie auth applies.
  router.get('/login/:id/events', (req, res) => {
    let unsubscribe: (() => void) | undefined;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (e: LoginEvent) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'done' || e.type === 'failed' || e.type === 'cancelled') {
        unsubscribe?.();
        res.end();
      }
    };
    try {
      unsubscribe = login.subscribe(String(req.params.id), write);
    } catch (e) {
      res.write(
        `data: ${JSON.stringify({ type: 'failed', message: e instanceof Error ? e.message : 'No such login' })}\n\n`
      );
      res.end();
      return;
    }
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe?.();
    });
  });

  return router;
}
