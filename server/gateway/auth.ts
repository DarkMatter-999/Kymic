import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

export interface AuthOptions {
  dbPath: string;
  /** The single user's password (from the environment, never from a request). */
  password: string;
  /** Exact Origin values trusted for login/logout (CSRF defence). */
  allowedOrigins: string[];
  sessionTtlMs?: number;
  /** Set the Secure cookie attribute. Required behind TLS. */
  secureCookies?: boolean;
  cookieName?: string;
  maxFailures?: number;
  failureWindowMs?: number;
  now?: () => number;
}

/** What `authenticate` needs: works for Express requests and raw upgrade requests. */
export interface HasHeaders {
  headers: { cookie?: string };
}

const MIN_PASSWORD_LENGTH = 12;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Single-user password login with server-side sessions. Tokens are random and
 * only their hash is stored. Credentials are never accepted from a URL.
 */
export class Auth {
  readonly router: express.Router;
  private readonly db: DatabaseSync;
  private readonly salt = randomBytes(16);
  private readonly passwordKey: Buffer;
  private readonly allowedOrigins: string[];
  private readonly ttlMs: number;
  private readonly secure: boolean;
  private readonly cookieName: string;
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private closed = false;

  constructor(options: AuthOptions) {
    if (!options.password || options.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `A password of at least ${MIN_PASSWORD_LENGTH} characters is required`
      );
    }
    this.passwordKey = scryptSync(options.password, this.salt, 32);
    this.allowedOrigins = options.allowedOrigins;
    this.ttlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.secure = options.secureCookies ?? false;
    this.cookieName = options.cookieName ?? 'codemode_session';
    this.maxFailures = options.maxFailures ?? 5;
    this.failureWindowMs = options.failureWindowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.router = this.buildRouter();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** True when the request carries a live session cookie. */
  authenticate = (req: HasHeaders): boolean => {
    const token = this.tokenFrom(req.headers.cookie);
    if (!token) return false;
    const row = this.db
      .prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
      .get(sha256(token)) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > this.now();
  };

  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (this.authenticate(req)) next();
    else res.status(401).json({ error: 'Unauthorized' });
  };

  private tokenFrom(header: string | undefined): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === this.cookieName) {
        return part.slice(index + 1).trim() || null;
      }
    }
    return null;
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    return [
      `${this.cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSeconds}`,
      ...(this.secure ? ['Secure'] : []),
    ].join('; ');
  }

  private passwordMatches(candidate: string): boolean {
    const key = scryptSync(candidate, this.salt, 32);
    return timingSafeEqual(key, this.passwordKey);
  }

  /** Seconds until this client may try again, or 0 if allowed. */
  private retryAfter(ip: string): number {
    const entry = this.failures.get(ip);
    if (!entry) return 0;
    const now = this.now();
    if (entry.resetAt <= now) {
      this.failures.delete(ip);
      return 0;
    }
    return entry.count >= this.maxFailures
      ? Math.ceil((entry.resetAt - now) / 1000)
      : 0;
  }

  private recordFailure(ip: string): void {
    const now = this.now();
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(ip, { count: 1, resetAt: now + this.failureWindowMs });
    } else {
      entry.count += 1;
    }
  }

  private buildRouter(): express.Router {
    const router = express.Router();

    // State-changing requests: trusted Origin and JSON only.
    router.use((req, res, next) => {
      if (req.method === 'GET') return next();
      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins.includes(origin)) {
        res.status(403).json({ error: 'Forbidden origin' });
        return;
      }
      if (!req.is('application/json')) {
        res
          .status(415)
          .json({ error: 'Content-Type must be application/json' });
        return;
      }
      next();
    });

    router.post('/login', (req, res) => {
      const password = (req.body as { password?: unknown } | undefined)
        ?.password;
      if (
        typeof password !== 'string' ||
        password.length === 0 ||
        password.length > 1024
      ) {
        res.status(400).json({ error: 'password is required' });
        return;
      }
      const ip = req.socket.remoteAddress ?? 'unknown';
      const wait = this.retryAfter(ip);
      if (wait > 0) {
        res.set('Retry-After', String(wait));
        res.status(429).json({ error: 'Too many failed attempts' });
        return;
      }
      if (!this.passwordMatches(password)) {
        this.recordFailure(ip);
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      const now = this.now();
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      const token = randomBytes(32).toString('base64url');
      this.db
        .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
        .run(sha256(token), now, now + this.ttlMs);
      res.set('Set-Cookie', this.cookie(token, Math.floor(this.ttlMs / 1000)));
      res.status(204).end();
    });

    router.post('/logout', (req, res) => {
      const token = this.tokenFrom(req.headers.cookie);
      if (token) {
        this.db
          .prepare('DELETE FROM sessions WHERE token_hash = ?')
          .run(sha256(token));
      }
      res.set('Set-Cookie', this.cookie('', 0));
      res.status(204).end();
    });

    router.get('/session', (req, res) => {
      if (this.authenticate(req)) res.json({ authenticated: true });
      else res.status(401).json({ authenticated: false });
    });

    return router;
  }
}
