// Wall-clock arithmetic for a named IANA zone, using built-in `Intl`.
//
// Stock sessions are defined in America/New_York and stored in UTC
// (docs/bar-rules.md), so something must know when New York is UTC-5 and when
// it is UTC-4. `Intl` is backed by the runtime's tzdata, so it is right for
// historic rules too. Hard-coding "second Sunday in March" would only be
// correct from 2007 onward and would silently misalign older bars, and a
// date library would be a new dependency for no gain.
//
// Pure: `Intl.DateTimeFormat`, `new Date(ms)` and `Date.UTC` all read no clock.

export class TimeZoneError extends Error {}

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** A time of day in a zone's wall clock. */
export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  // hourCycle h23 so midnight is hour 0; `hour12: false` can yield hour 24.
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, created);
  return created;
}

/** The wall-clock parts of an instant, in the given zone. */
export function zonedParts(epochSeconds: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochSeconds * 1000));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new TimeZoneError(`Intl gave no ${type} for zone ${timeZone}; is the runtime's ICU data complete?`);
    }
    return Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function partsAsIfUtc(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
}

/**
 * The instant at which the given wall clock reads in the given zone.
 *
 * Inverted by iteration: guess, read the guess back, correct by the
 * difference. Two passes are enough because an offset is itself constant
 * either side of a transition; a third is kept as a belt and braces.
 *
 * Ambiguous and nonexistent wall clocks (the hour repeated or skipped at a DST
 * transition) resolve to the closest real instant. Session boundaries are
 * 09:30, 13:00 and 16:00, and US transitions happen at 02:00 local on a
 * Sunday, so no session boundary can land in a gap.
 */
export function epochSecondsFromZonedParts(parts: ZonedParts, timeZone: string): number {
  const target = partsAsIfUtc(parts);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const difference = partsAsIfUtc(zonedParts(guess, timeZone)) - target;
    if (difference === 0) return guess;
    guess -= difference;
  }
  return guess;
}

/** Seconds the zone is ahead of UTC at this instant; negative for the Americas. */
export function zoneOffsetSeconds(epochSeconds: number, timeZone: string): number {
  return partsAsIfUtc(zonedParts(epochSeconds, timeZone)) - epochSeconds;
}

/** `YYYY-MM-DD` for an instant, as the zone's calendar reads it. */
export function zonedDateKey(epochSeconds: number, timeZone: string): string {
  const parts = zonedParts(epochSeconds, timeZone);
  return dateKey(parts.year, parts.month, parts.day);
}

/** `YYYY-MM-DD` from calendar parts. */
export function dateKey(year: number, month: number, day: number): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${year.toString().padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** Parse `YYYY-MM-DD` into parts. Throws on anything else. */
export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) throw new TimeZoneError(`Expected YYYY-MM-DD, got ${JSON.stringify(key)}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Day of the week for a calendar date: 0 is Sunday, 6 is Saturday. */
export function dayOfWeek(key: string): number {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Shift a calendar date by whole days, staying in the calendar rather than in instants. */
export function addDays(key: string, days: number): string {
  const { year, month, day } = parseDateKey(key);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return dateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}
