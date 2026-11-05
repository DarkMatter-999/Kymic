import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import type { Scheduler } from './scheduler.js';

export interface ScheduleRouterOptions {
  scheduler: Scheduler;
  allowedOrigins: string[];
  authenticate: (req: Request) => boolean | Promise<boolean>;
}

/** Authenticated controls for schedules. State-changing calls also check Origin (CSRF). */
export function createScheduleRouter(
  options: ScheduleRouterOptions
): express.Router {
  const { scheduler } = options;
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
      if (!req.is('application/json') && req.method !== 'DELETE') {
        res
          .status(415)
          .json({ error: 'Content-Type must be application/json' });
        return;
      }
    }
    next();
  });

  const exists = (req: Request, res: Response): string | null => {
    const id = String(req.params.id);
    if (!scheduler.get(id)) {
      res.status(404).json({ error: 'Schedule not found' });
      return null;
    }
    return id;
  };

  router.get('/', (_req, res) => {
    res.json(scheduler.list());
  });

  router.post('/', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const schedule = scheduler.create({
        conversationId: body.conversationId as string,
        prompt: body.prompt as string,
        everyMs: body.everyMs as number,
        timezone: body.timezone as string,
      });
      res.status(201).json(schedule);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Invalid request',
      });
    }
  });

  router.post('/:id/enabled', (req, res) => {
    const id = exists(req, res);
    if (!id) return;
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    scheduler.setEnabled(id, enabled);
    res.status(204).end();
  });

  router.get('/:id/runs', (req, res) => {
    const id = exists(req, res);
    if (id) res.json(scheduler.runs(id));
  });

  router.delete('/:id', (req, res) => {
    const id = exists(req, res);
    if (!id) return;
    scheduler.delete(id);
    res.status(204).end();
  });

  return router;
}
