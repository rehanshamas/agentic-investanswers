import { describe, expect, it } from 'vitest';

import {
  addMinutes,
  addSeconds,
  barTime,
  barTimeFromMillis,
  barTimeFromUtcParts,
  BarTimeError,
  floorToSeconds,
  toEpochMillis,
  toEpochSeconds,
} from './bar-time.js';

describe('barTime', () => {
  it('accepts whole seconds in a plausible range', () => {
    expect(toEpochSeconds(barTime(1_705_419_000))).toBe(1_705_419_000);
  });

  it('rejects a millisecond value passed as seconds', () => {
    // The mistake this brand exists to catch: `Date.now()` is milliseconds, and
    // against a bare `number` it would typecheck and give bars 1000x out.
    expect(() => barTime(1_705_419_000_000)).toThrow(BarTimeError);
  });

  it('rejects fractional seconds', () => {
    expect(() => barTime(1_705_419_000.5)).toThrow(BarTimeError);
  });

  it('rejects values before 1990, which are usually a unit mix-up', () => {
    expect(() => barTime(0)).toThrow(BarTimeError);
  });
});

describe('conversions', () => {
  it('converts to and from milliseconds', () => {
    const time = barTimeFromUtcParts(2024, 1, 16, 14, 30, 0);
    expect(toEpochMillis(time)).toBe(1_705_415_400_000);
    expect(barTimeFromMillis(toEpochMillis(time))).toBe(time);
  });

  it('refuses milliseconds with a fractional second, rather than truncating', () => {
    expect(() => barTimeFromMillis(1_705_415_400_500)).toThrow(BarTimeError);
  });

  it('builds from UTC calendar parts', () => {
    expect(barTimeFromUtcParts(2024, 1, 16)).toBe(barTime(Date.UTC(2024, 0, 16) / 1000));
    expect(barTimeFromUtcParts(2024, 3, 15, 7, 43, 29)).toBe(
      barTime(Date.UTC(2024, 2, 15, 7, 43, 29) / 1000),
    );
  });
});

describe('arithmetic', () => {
  it('adds seconds and minutes', () => {
    const time = barTimeFromUtcParts(2024, 1, 16, 14, 30, 0);
    expect(addSeconds(time, 90)).toBe(barTimeFromUtcParts(2024, 1, 16, 14, 31, 30));
    expect(addMinutes(time, 60)).toBe(barTimeFromUtcParts(2024, 1, 16, 15, 30, 0));
    expect(addMinutes(time, -30)).toBe(barTimeFromUtcParts(2024, 1, 16, 14, 0, 0));
  });

  it('floors to a step, which is how crypto bars are anchored to the epoch', () => {
    const time = barTimeFromUtcParts(2024, 3, 15, 7, 43, 29);
    expect(floorToSeconds(time, 60)).toBe(barTimeFromUtcParts(2024, 3, 15, 7, 43, 0));
    expect(floorToSeconds(time, 3600)).toBe(barTimeFromUtcParts(2024, 3, 15, 7, 0, 0));
    expect(floorToSeconds(time, 14_400)).toBe(barTimeFromUtcParts(2024, 3, 15, 4, 0, 0));
  });

  it('rejects a step that is not a positive whole number of seconds', () => {
    const time = barTimeFromUtcParts(2024, 3, 15, 7, 43, 29);
    expect(() => floorToSeconds(time, 0)).toThrow(BarTimeError);
    expect(() => floorToSeconds(time, -60)).toThrow(BarTimeError);
    expect(() => floorToSeconds(time, 1.5)).toThrow(BarTimeError);
  });
});
