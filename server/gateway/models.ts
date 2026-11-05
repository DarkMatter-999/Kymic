import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  parseModelRef,
  readModelFile,
  writeModelFile,
  type ModelRef,
} from '../workers/storage.js';

/** The slice of Pi's `ModelRuntime` model discovery needs (narrow so it can be faked). */
export interface ModelRuntimeLike {
  getAvailable(): Promise<
    readonly {
      id: string;
      name?: string;
      provider: string;
      reasoning?: boolean;
      input?: readonly string[];
      contextWindow?: number;
    }[]
  >;
  getProvider(providerId: string): { name: string } | undefined;
  refresh(options?: {
    allowNetwork?: boolean;
    force?: boolean;
  }): Promise<{ errors: ReadonlyMap<string, Error> }>;
}

export interface ModelInfo {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
  images: boolean;
  contextWindow: number | null;
}

/**
 * Models the signed-in providers offer, and the default for new conversations.
 * The default lives in gateway-private storage, never in the worker's own
 * configuration, so a worker cannot change which model future workers use.
 */
export class ModelCatalog {
  private readonly runtime: ModelRuntimeLike;
  private readonly dir: string;
  private defaultRef: ModelRef | undefined;

  constructor(runtime: ModelRuntimeLike, privateDir: string) {
    this.runtime = runtime;
    this.dir = privateDir;
  }

  async load(): Promise<void> {
    this.defaultRef = await readModelFile(this.dir);
  }

  /** Synchronous so the launcher can read it at each worker start. */
  getDefault(): ModelRef | undefined {
    return this.defaultRef;
  }

  async list(): Promise<ModelInfo[]> {
    const models = await this.runtime.getAvailable();
    return models
      .map((m) => ({
        provider: m.provider,
        providerName: this.runtime.getProvider(m.provider)?.name ?? m.provider,
        id: m.id,
        name: m.name || m.id,
        reasoning: m.reasoning === true,
        images: m.input?.includes('image') === true,
        contextWindow: m.contextWindow ?? null,
      }))
      .sort(
        (a, b) =>
          a.providerName.localeCompare(b.providerName) ||
          a.name.localeCompare(b.name)
      );
  }

  /** Only a model the signed-in providers actually offer is accepted. */
  async validate(ref: unknown): Promise<ModelRef> {
    const parsed = parseModelRef(ref);
    if (!parsed) throw new Error('Invalid model');
    const available = await this.runtime.getAvailable();
    if (
      !available.some(
        (m) => m.provider === parsed.provider && m.id === parsed.id
      )
    )
      throw new Error(
        'That model is not available. Sign in to its provider first.'
      );
    return parsed;
  }

  async setDefault(ref: unknown): Promise<ModelRef> {
    const validated = await this.validate(ref);
    await writeModelFile(this.dir, validated);
    this.defaultRef = validated;
    return validated;
  }

  /** Ask dynamic providers (local servers, aggregators) for their current models. */
  async refresh(): Promise<{ failed: string[] }> {
    const result = await this.runtime.refresh({
      allowNetwork: true,
      force: true,
    });
    return { failed: [...result.errors.keys()] };
  }
}

export interface ModelRouterOptions {
  catalog: ModelCatalog;
  allowedOrigins: string[];
  authenticate: (req: Request) => boolean | Promise<boolean>;
}

/** Authenticated model discovery and default selection. State changes check Origin (CSRF). */
export function createModelRouter(options: ModelRouterOptions): express.Router {
  const { catalog } = options;
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

  router.get('/', async (_req, res) => {
    try {
      res.json({
        models: await catalog.list(),
        default: catalog.getDefault() ?? null,
      });
    } catch (e) {
      fail(res, e, 500);
    }
  });

  router.post('/default', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { provider?: unknown; id?: unknown };
      res.json(
        await catalog.setDefault({ provider: body.provider, id: body.id })
      );
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/refresh', async (_req, res) => {
    try {
      res.json(await catalog.refresh());
    } catch (e) {
      fail(res, e, 502);
    }
  });

  return router;
}
