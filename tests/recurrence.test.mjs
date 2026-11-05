import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextOccurrenceAfter,
  parseTimeOfDay,
  zonedInstant,
} from '../server/scheduler/recurrence.ts';

const iso = (ms) => new Date(ms).toISOString();
const daily = (timezone, timeOfDay) => ({
  kind: 'daily',
  timezone,
  timeOfDay,
  weekdays: [],
});
const NY = 'America/New_York';

test('parses time of day strictly', () => {
  assert.deepEqual(parseTimeOfDay('09:05'), { hour: 9, minute: 5 });
  for (const bad of ['9:05', '24:00', '12:60', '', '12:5', '12:00:00'])
    assert.equal(parseTimeOfDay(bad), null, bad);
});

test('a normal day maps local time to the right UTC instant', () => {
  assert.equal(
    iso(zonedInstant(2026, 1, 15, 9, 0, NY)),
    '2026-01-15T14:00:00.000Z'
  );
  assert.equal(
    iso(zonedInstant(2026, 7, 15, 9, 0, NY)),
    '2026-07-15T13:00:00.000Z'
  );
  assert.equal(
    iso(zonedInstant(2026, 7, 15, 9, 0, 'Asia/Kolkata')),
    '2026-07-15T03:30:00.000Z'
  );
});

test('spring forward: a nonexistent local time runs once, shifted by the gap', () => {
  // New York 2026-03-08 02:00 -> 03:00. 02:30 does not exist.
  assert.equal(
    iso(zonedInstant(2026, 3, 8, 2, 30, NY)),
    '2026-03-08T07:30:00.000Z'
  ); // = 03:30 EDT
  const before = Date.UTC(2026, 2, 7, 12);
  const first = nextOccurrenceAfter(daily(NY, '02:30'), before);
  assert.equal(iso(first), '2026-03-08T07:30:00.000Z');
  // The day after resumes at the real 02:30 EDT.
  assert.equal(
    iso(nextOccurrenceAfter(daily(NY, '02:30'), first)),
    '2026-03-09T06:30:00.000Z'
  );
});

test('fall back: a repeated local time runs once, at the first occurrence', () => {
  // New York 2026-11-01 01:00-02:00 happens twice. 01:30 EDT = 05:30Z, 01:30 EST = 06:30Z.
  assert.equal(
    iso(zonedInstant(2026, 11, 1, 1, 30, NY)),
    '2026-11-01T05:30:00.000Z'
  );
  const first = nextOccurrenceAfter(
    daily(NY, '01:30'),
    Date.UTC(2026, 10, 1, 0)
  );
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  // Not again an hour later: the next run is the next local day.
  assert.equal(
    iso(nextOccurrenceAfter(daily(NY, '01:30'), first)),
    '2026-11-02T06:30:00.000Z'
  );
});

test('a 23-hour and a 25-hour day each have exactly one daily run', () => {
  const rule = daily(NY, '12:00');
  const runs = [];
  let t = Date.UTC(2026, 2, 6);
  for (let i = 0; i < 5; i++) runs.push((t = nextOccurrenceAfter(rule, t)));
  assert.deepEqual(runs.map(iso), [
    '2026-03-06T17:00:00.000Z',
    '2026-03-07T17:00:00.000Z',
    '2026-03-08T16:00:00.000Z', // 23-hour day: noon EDT
    '2026-03-09T16:00:00.000Z',
    '2026-03-10T16:00:00.000Z',
  ]);
});

test('zones with a midnight gap and a half-hour DST shift behave', () => {
  // Havana springs forward at 00:00 -> 01:00 on 2026-03-08, so 00:30 does not exist.
  assert.equal(
    iso(zonedInstant(2026, 3, 8, 0, 30, 'America/Havana')),
    '2026-03-08T05:30:00.000Z'
  ); // 01:30 CDT
  // Lord Howe shifts by 30 minutes (UTC+10:30 -> +11 on 2026-10-04).
  assert.equal(
    iso(zonedInstant(2026, 10, 3, 9, 0, 'Australia/Lord_Howe')),
    '2026-10-02T22:30:00.000Z'
  );
  assert.equal(
    iso(zonedInstant(2026, 10, 5, 9, 0, 'Australia/Lord_Howe')),
    '2026-10-04T22:00:00.000Z'
  );
});

test('weekly rules pick only the chosen local weekdays', () => {
  const rule = {
    kind: 'weekly',
    timezone: NY,
    timeOfDay: '08:00',
    weekdays: [1, 3],
  }; // Mon, Wed
  let t = Date.UTC(2026, 2, 1); // Sunday
  const seen = [];
  for (let i = 0; i < 4; i++)
    seen.push(iso((t = nextOccurrenceAfter(rule, t))));
  assert.deepEqual(seen, [
    '2026-03-02T13:00:00.000Z', // Mon, EST
    '2026-03-04T13:00:00.000Z', // Wed
    '2026-03-09T12:00:00.000Z', // Mon, after spring forward -> EDT
    '2026-03-11T12:00:00.000Z',
  ]);
});

test('"after" is exclusive and the local date comes from the zone, not UTC', () => {
  const rule = daily(NY, '09:00');
  const nine = Date.UTC(2026, 0, 15, 14);
  assert.equal(
    iso(nextOccurrenceAfter(rule, nine)),
    '2026-01-16T14:00:00.000Z'
  );
  // 02:00Z on the 16th is still the 15th evening in New York.
  assert.equal(
    iso(nextOccurrenceAfter(rule, Date.UTC(2026, 0, 16, 2))),
    '2026-01-16T14:00:00.000Z'
  );
});

test('year boundaries and leap day are handled', () => {
  assert.equal(
    iso(nextOccurrenceAfter(daily('UTC', '00:00'), Date.UTC(2026, 11, 31, 12))),
    '2027-01-01T00:00:00.000Z'
  );
  assert.equal(
    iso(nextOccurrenceAfter(daily('UTC', '10:00'), Date.UTC(2028, 1, 28, 12))),
    '2028-02-29T10:00:00.000Z'
  );
});
