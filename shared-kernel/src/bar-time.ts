// BarTime: the open time of a bar, in whole UTC seconds.
//
// Seconds, not milliseconds, because the TradingView exports carry UNIX epoch
// seconds (docs/bar-rules.md, "Timestamps") and parity is an exact comparison.
// Branded so a millisecond value cannot be passed where a bar time belongs:
// that mistake typechecks against a bare `number` and yields bars 1000x out.
//
// Nothing here reads the clock. Callers pass the instant in.

declare const barTimeBrand: unique symbol;

/** The open time of a bar, in whole seconds since the UNIX epoch, UTC. */
export type BarTime = number & { readonly [barTimeBrand]: true };

/** Thrown when a value cannot be a bar time. */
export class BarTimeError extends Error {}

// Sanity window: 1990-01-01 to 2100-01-01 in seconds. A millisecond value for
// any date after 1970 lands far above this, so the common mistake is caught.
const MIN_SECONDS = 631_152_000;
const MAX_SECONDS = 4_102_444_800;

/** Build a BarTime from whole UTC seconds. Rejects non-integers and millisecond-magnitude values. */
export function barTime(seconds: number): BarTime {
  if (!Number.isInteger(seconds)) {
    throw new BarTimeError(`BarTime must be whole seconds, got ${seconds}`);
  }
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new BarTimeError(
      `BarTime ${seconds} is outside 1990-2100; a millisecond value passed as seconds is the usual cause`,
    );
  }
  return seconds as BarTime;
}

/** Seconds since the epoch, for arithmetic and storage. */
export function toEpochSeconds(t: BarTime): number {
  return t;
}

/** Milliseconds since the epoch, for interop with `Date` and provider payloads. */
export function toEpochMillis(t: BarTime): number {
  return t * 1000;
}

/** Build a BarTime from a millisecond instant, which must land on a whole second. */
export function barTimeFromMillis(millis: number): BarTime {
  if (!Number.isInteger(millis)) {
    throw new BarTimeError(`Expected whole milliseconds, got ${millis}`);
  }
  if (millis % 1000 !== 0) {
    throw new BarTimeError(`Bar times are whole seconds; ${millis}ms has a fractional second`);
  }
  return barTime(millis / 1000);
}

/** Build a BarTime from UTC calendar parts. Pure: `Date.UTC` reads no clock. */
export function barTimeFromUtcParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): BarTime {
  return barTime(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

/** Add whole seconds. */
export function addSeconds(t: BarTime, seconds: number): BarTime {
  return barTime(t + seconds);
}

/** Add whole minutes. */
export function addMinutes(t: BarTime, minutes: number): BarTime {
  return addSeconds(t, minutes * 60);
}

/** Round down to a whole number of seconds from the epoch. */
export function floorToSeconds(t: BarTime, seconds: number): BarTime {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new BarTimeError(`Step must be a positive whole number of seconds, got ${seconds}`);
  }
  return barTime(Math.floor(t / seconds) * seconds);
}
