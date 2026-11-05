import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ServerEvent } from '../gateway/protocol.js';
import {
  nextOccurrenceAfter,
  parseTimeOfDay,
  type RecurrenceKind,
} from './recurrence.js';

/** The slice of ConversationManager the scheduler needs. */
export interface RunExecutor {
  isRunning(conversationId: string): boolean;
  prompt(conversationId: string, text: string): Promise<void>;
  subscribe(
    conversationId: string,
    listener: (event: ServerEvent) => void
  ): () => void;
}

export type RunStatus =
  | 'launching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'skipped_missed'
  | 'skipped_overlap';

export interface Schedule {
  id: string;
  conversationId: string;
  prompt: string;
  timezone: string;
  kind: RecurrenceKind;
  /** Interval schedules only; 0 for calendar schedules. */
  everyMs: number;
  /** Calendar schedules: local "HH:MM" in `timezone`. */
  timeOfDay: string | null;
  /** Weekly schedules: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  enabled: boolean;
  nextOccurrence: number;
}

export interface Run {
  occurrenceId: string;
  scheduleId: string;
  dueAt: number;
  status: RunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  result: string | null;
}

export interface SchedulerOptions {
  dbPath: string;
  executor: RunExecutor;
  now?: () => number;
  /** A due occurrence older than this when found is skipped, not run late. */
  graceMs?: number;
  minIntervalMs?: number;
  maxSchedules?: number;
  maxPromptLength?: number;
  /** Mark runs left launching/running by a previous process as interrupted. */
  recoverOnStart?: boolean;
}

export interface CreateSchedule {
  conversationId: string;
  prompt: string;
  timezone: string;
  /** Defaults to "interval". */
  kind?: RecurrenceKind;
  everyMs?: number;
  timeOfDay?: string;
  weekdays?: number[];
}

/** Longest catch-up walk when finding the latest due calendar occurrence. */
const MAX_CATCH_UP_STEPS = 10_000;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

type Row = Record<string, unknown>;

function invalid(reason: string): never {
  throw new Error(`Invalid schedule: ${reason}`);
}

/**
 * Durable interval scheduler, independent of any browser. Each occurrence has a
 * unique ID inserted in the same transaction that advances the schedule, so an
 * occurrence has at most one durable launch record. Ambiguous crashes become
 * `interrupted` and are never re-run automatically.
 *
 * Recurrence is either a fixed interval or a calendar rule (daily or weekly at a
 * local time) evaluated in the schedule's time zone with explicit DST rules; see
 * recurrence.ts. Missed occurrences are skipped, never run late in a burst.
 */
export class Scheduler {
  private readonly db: DatabaseSync;
  private readonly executor: RunExecutor;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly minIntervalMs: number;
  private readonly maxSchedules: number;
  private readonly maxPromptLength: number;
  private readonly cleanups = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: SchedulerOptions) {
    this.executor = options.executor;
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? 60_000;
    this.minIntervalMs = options.minIntervalMs ?? 60_000;
    this.maxSchedules = options.maxSchedules ?? 20;
    this.maxPromptLength = options.maxPromptLength ?? 10_000;
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        timezone TEXT NOT NULL,
        every_ms INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        next_occurrence INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'interval',
        time_of_day TEXT,
        weekdays TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS runs (
        occurrence_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_schedule ON runs (schedule_id, due_at);
    `);
    this.migrate();
    if (options.recoverOnStart !== false) this.recover();
  }

  /** Databases from before calendar recurrence lack three columns; add them in place. */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(schedules)').all() as {
          name: string;
        }[]
      ).map((c) => c.name)
    );
    if (!columns.has('kind'))
      this.db.exec(
        "ALTER TABLE schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'interval'"
      );
    if (!columns.has('time_of_day'))
      this.db.exec('ALTER TABLE schedules ADD COLUMN time_of_day TEXT');
    if (!columns.has('weekdays'))
      this.db.exec(
        "ALTER TABLE schedules ADD COLUMN weekdays TEXT NOT NULL DEFAULT ''"
      );
  }

  /** First occurrence strictly after `after`. */
  private stepAfter(schedule: Schedule, after: number): number {
    if (schedule.kind === 'interval') return after + schedule.everyMs;
    return nextOccurrenceAfter(
      {
        kind: schedule.kind,
        timezone: schedule.timezone,
        timeOfDay: schedule.timeOfDay ?? '00:00',
        weekdays: schedule.weekdays,
      },
      after
    );
  }

  create(input: CreateSchedule): Schedule {
    if (!ID_PATTERN.test(input.conversationId)) invalid('conversationId');
    if (
      typeof input.prompt !== 'string' ||
      input.prompt.length === 0 ||
      input.prompt.length > this.maxPromptLength
    ) {
      invalid('prompt');
    }
    const kind = input.kind ?? 'interval';
    if (kind !== 'interval' && kind !== 'daily' && kind !== 'weekly')
      invalid('kind');
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone });
    } catch {
      invalid('timezone');
    }
    let everyMs = 0;
    let timeOfDay: string | null = null;
    let weekdays: number[] = [];
    if (kind === 'interval') {
      if (
        typeof input.everyMs !== 'number' ||
        !Number.isInteger(input.everyMs) ||
        input.everyMs < this.minIntervalMs
      )
        invalid('interval');
      everyMs = input.everyMs;
    } else {
      if (
        typeof input.timeOfDay !== 'string' ||
        !parseTimeOfDay(input.timeOfDay)
      )
        invalid('timeOfDay');
      timeOfDay = input.timeOfDay;
      if (kind === 'weekly') {
        const days = input.weekdays;
        if (
          !Array.isArray(days) ||
          days.length === 0 ||
          !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        )
          invalid('weekdays');
        weekdays = [...new Set(days)].sort();
      }
    }
    const count = (
      this.db.prepare('SELECT COUNT(*) AS c FROM schedules').get() as {
        c: number;
      }
    ).c;
    if (count >= this.maxSchedules) throw new Error('Too many schedules');
    const schedule: Schedule = {
      id: randomUUID(),
      conversationId: input.conversationId,
      prompt: input.prompt,
      timezone: input.timezone,
      kind,
      everyMs,
      timeOfDay,
      weekdays,
      enabled: true,
      nextOccurrence: 0,
    };
    schedule.nextOccurrence = this.stepAfter(schedule, this.now());
    if (kind === 'interval') schedule.nextOccurrence = this.now() + everyMs;
    this.db
      .prepare(
        `INSERT INTO schedules (id, conversation_id, prompt, timezone, every_ms, enabled, next_occurrence, kind, time_of_day, weekdays)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        schedule.id,
        schedule.conversationId,
        schedule.prompt,
        schedule.timezone,
        schedule.everyMs,
        schedule.nextOccurrence,
        kind,
        timeOfDay,
        weekdays.join(',')
      );
    return schedule;
  }

  get(id: string): Schedule | undefined {
    const row = this.db
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(id) as Row | undefined;
    return row && toSchedule(row);
  }

  list(): Schedule[] {
    return (
      this.db.prepare('SELECT * FROM schedules ORDER BY id').all() as Row[]
    ).map(toSchedule);
  }

  runs(scheduleId: string, limit = 50): Run[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM runs WHERE schedule_id = ? ORDER BY due_at DESC, rowid DESC LIMIT ?'
        )
        .all(scheduleId, limit) as Row[]
    ).map(toRun);
  }

  setEnabled(id: string, enabled: boolean): void {
    const schedule = this.get(id);
    if (!schedule) throw new Error('Schedule not found');
    let next = schedule.nextOccurrence;
    const now = this.now();
    if (enabled && next <= now) {
      // Resume at the next future occurrence on the original grid; never catch up.
      next =
        schedule.kind === 'interval'
          ? next +
            (Math.floor((now - next) / schedule.everyMs) + 1) * schedule.everyMs
          : this.stepAfter(schedule, now);
    }
    this.db
      .prepare(
        'UPDATE schedules SET enabled = ?, next_occurrence = ? WHERE id = ?'
      )
      .run(enabled ? 1 : 0, next, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE schedule_id = ?').run(id);
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  /** Runs left in flight by a dead process are ambiguous; mark, never re-run. */
  recover(): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', finished_at = ?, error = 'Gateway stopped during this run'
         WHERE status IN ('launching', 'running')`
      )
      .run(this.now());
  }

  start(tickMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), tickMs);
    this.timer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.db.close();
  }

  /** Claim and launch every due occurrence. Resolves once prompts are accepted. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.db
      .prepare(
        'SELECT id FROM schedules WHERE enabled = 1 AND next_occurrence <= ?'
      )
      .all(now) as { id: string }[];
    const launches: Promise<void>[] = [];
    for (const { id } of due) {
      const claimed = this.claim(id, now);
      if (claimed)
        launches.push(this.launch(claimed.schedule, claimed.occurrenceId));
    }
    await Promise.all(launches);
  }

  private claim(
    id: string,
    now: number
  ): { schedule: Schedule; occurrenceId: string } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const schedule = this.get(id);
      // Re-read under the lock: another instance may already have claimed it.
      if (!schedule || !schedule.enabled || schedule.nextOccurrence > now) {
        this.db.exec('ROLLBACK');
        return null;
      }
      // `latest` is the newest occurrence that is due; `periods` older ones were missed.
      let latest = schedule.nextOccurrence;
      let periods = 0;
      if (schedule.kind === 'interval') {
        periods = Math.floor((now - latest) / schedule.everyMs);
        latest += periods * schedule.everyMs;
      } else {
        for (
          let following = this.stepAfter(schedule, latest);
          following <= now && periods < MAX_CATCH_UP_STEPS;
          following = this.stepAfter(schedule, latest)
        ) {
          latest = following;
          periods++;
        }
      }
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO runs (occurrence_id, schedule_id, conversation_id, due_at, status, started_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const record = (due: number, status: RunStatus, error: string | null) =>
        insert.run(
          `${id}:${due}`,
          id,
          schedule.conversationId,
          due,
          status,
          status === 'launching' ? now : null,
          error
        ).changes > 0;

      let launch: string | null = null;
      if (now - latest > this.graceMs) {
        record(
          schedule.nextOccurrence,
          'skipped_missed',
          `${periods + 1} missed`
        );
      } else {
        if (periods > 0) {
          record(
            schedule.nextOccurrence,
            'skipped_missed',
            `${periods} missed`
          );
        }
        const busy =
          this.executor.isRunning(schedule.conversationId) ||
          this.db
            .prepare(
              `SELECT 1 FROM runs WHERE conversation_id = ? AND status IN ('launching', 'running') LIMIT 1`
            )
            .get(schedule.conversationId) !== undefined;
        if (busy) record(latest, 'skipped_overlap', 'Conversation was busy');
        else if (record(latest, 'launching', null)) launch = `${id}:${latest}`;
      }
      this.db
        .prepare('UPDATE schedules SET next_occurrence = ? WHERE id = ?')
        .run(this.stepAfter(schedule, latest), id);
      this.db.exec('COMMIT');
      return launch ? { schedule, occurrenceId: launch } : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private async launch(
    schedule: Schedule,
    occurrenceId: string
  ): Promise<void> {
    const { conversationId } = schedule;
    let finished = false;
    let lastText: string | null = null;
    let errorMessage: string | null = null;
    const finish = (status: RunStatus, error: string | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      this.db
        .prepare(
          `UPDATE runs SET status = ?, finished_at = ?, error = ?, result = ?
           WHERE occurrence_id = ? AND status IN ('launching', 'running')`
        )
        .run(status, this.now(), error, lastText, occurrenceId);
    };
    const unsubscribe = this.executor.subscribe(conversationId, (event) => {
      if (event.type === 'message') {
        const message = event.message as { role?: string; content?: unknown };
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          const text = (message.content as { type?: string; text?: string }[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
          if (text) lastText = text;
        }
      } else if (event.type === 'error') {
        errorMessage = event.message;
      } else if (event.type === 'settled') {
        if (errorMessage) finish('failed', errorMessage);
        else finish(event.aborted ? 'cancelled' : 'completed', null);
      } else if (event.type === 'status' && !event.running) {
        finish(errorMessage ? 'failed' : 'completed', errorMessage);
      }
    });
    const cleanup = () => {
      unsubscribe();
      this.cleanups.delete(cleanup);
    };
    this.cleanups.add(cleanup);
    try {
      await this.executor.prompt(conversationId, schedule.prompt);
    } catch (error) {
      finish('failed', error instanceof Error ? error.message : String(error));
      return;
    }
    if (finished) return;
    this.db
      .prepare(
        `UPDATE runs SET status = 'running' WHERE occurrence_id = ? AND status = 'launching'`
      )
      .run(occurrenceId);
    // A prompt Pi "handled" without starting a run never settles.
    if (!this.executor.isRunning(conversationId)) finish('completed', null);
  }
}

function toSchedule(row: Row): Schedule {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    prompt: String(row.prompt),
    timezone: String(row.timezone),
    kind: (row.kind as RecurrenceKind) ?? 'interval',
    everyMs: Number(row.every_ms),
    timeOfDay: row.time_of_day === null ? null : String(row.time_of_day),
    weekdays: String(row.weekdays ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number),
    enabled: row.enabled === 1,
    nextOccurrence: Number(row.next_occurrence),
  };
}

function toRun(row: Row): Run {
  return {
    occurrenceId: String(row.occurrence_id),
    scheduleId: String(row.schedule_id),
    dueAt: Number(row.due_at),
    status: row.status as RunStatus,
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    error: row.error === null ? null : String(row.error),
    result: row.result === null ? null : String(row.result),
  };
}
