/**
 * Calendar recurrence in an IANA time zone, DST-aware. Pure functions: the
 * scheduler stores the rule and asks for the next instant after a given time.
 *
 * Daylight-saving rules (documented behavior, covered by tests):
 *  - A local time that does not exist (spring-forward gap) runs once, shifted
 *    forward by the length of the gap (02:30 becomes 03:30).
 *  - A local time that happens twice (fall-back) runs once, at the first one.
 *  - Occurrences are per local calendar day, so a day that is 23 or 25 hours
 *    long still has exactly one run.
 */

export type RecurrenceKind = 'interval' | 'daily' | 'weekly';

export interface CalendarRule {
  kind: 'daily' | 'weekly';
  timezone: string;
  /** "HH:MM", 24-hour, local to `timezone`. */
  timeOfDay: string;
  /** 0 = Sunday … 6 = Saturday. Weekly only; daily runs every day. */
  weekdays: number[];
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTimeOfDay(
  value: string
): { hour: number; minute: number } | null {
  const m = TIME_PATTERN.exec(value);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, f);
  }
  return f;
}

interface Civil {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

function civilAt(ms: number, timezone: string): Civil {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms)))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/** Offset of `timezone` from UTC at an instant, in ms (positive east of UTC). */
function offsetAt(ms: number, timezone: string): number {
  const c = civilAt(ms, timezone);
  const wall = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, 0);
  return wall - Math.floor(ms / 60_000) * 60_000;
}

const DAY = 86_400_000;

/** The instant for a local wall-clock time, applying the DST rules above. */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Offsets a day either side bracket any single transition near this date.
  const before = offsetAt(wall - DAY, timezone);
  const after = offsetAt(wall + DAY, timezone);
  const candidates = [wall - before, wall - after].filter(
    (t, i, all) => all.indexOf(t) === i
  );
  const valid = candidates.filter((t) => {
    const c = civilAt(t, timezone);
    return (
      c.year === year &&
      c.month === month &&
      c.day === day &&
      c.hour === hour &&
      c.minute === minute
    );
  });
  // Fold: both valid, take the first. Gap: none valid, shift forward by using
  // the pre-transition offset, which lands after the gap.
  if (valid.length > 0) return Math.min(...valid);
  return wall - before;
}

/** The first occurrence strictly after `after` (epoch ms). */
export function nextOccurrenceAfter(rule: CalendarRule, after: number): number {
  const time = parseTimeOfDay(rule.timeOfDay);
  if (!time) throw new Error('Invalid time of day');
  const days =
    rule.kind === 'weekly' && rule.weekdays.length > 0
      ? new Set(rule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  const start = civilAt(after, rule.timezone);
  // A gap or fold can move an occurrence by up to a day, so look a little further than a week.
  for (let i = -1; i <= 9; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!days.has(date.getUTCDay())) continue;
    const instant = zonedInstant(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      time.hour,
      time.minute,
      rule.timezone
    );
    if (instant > after) return instant;
  }
  throw new Error('No occurrence found');
}
