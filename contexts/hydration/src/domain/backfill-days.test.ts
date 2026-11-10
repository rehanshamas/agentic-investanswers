import { barTimeFromUtcParts } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { BackfillDaysError, backfillDays, lastCompleteDay } from './backfill-days.js';

const HOUR = 3600;

describe('lastCompleteDay', () => {
  it('is yesterday once the settle time has passed', () => {
    expect(lastCompleteDay(barTimeFromUtcParts(2026, 11, 9, 1, 0), HOUR)).toBe('2026-11-08');
    expect(lastCompleteDay(barTimeFromUtcParts(2026, 11, 9, 15, 30), HOUR)).toBe('2026-11-08');
  });

  it('is the day before yesterday until yesterday has settled', () => {
    expect(lastCompleteDay(barTimeFromUtcParts(2026, 11, 9, 0, 59), HOUR)).toBe('2026-11-07');
  });

  it('crosses month and year ends', () => {
    expect(lastCompleteDay(barTimeFromUtcParts(2026, 1, 1, 12, 0), HOUR)).toBe('2025-12-31');
  });
});

describe('backfillDays', () => {
  const now = barTimeFromUtcParts(2026, 3, 2, 12, 0);

  it('lists every day inclusive, across a month end', () => {
    expect(backfillDays('2026-02-27', '2026-03-01', now, HOUR)).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('never goes past the last complete day, whatever until says', () => {
    expect(backfillDays('2026-02-28', '2026-12-31', now, HOUR)).toEqual(['2026-02-28', '2026-03-01']);
    expect(backfillDays('2026-02-28', undefined, now, HOUR)).toEqual(['2026-02-28', '2026-03-01']);
  });

  it('is empty when nothing in the range is complete yet', () => {
    expect(backfillDays('2026-03-02', undefined, now, HOUR)).toEqual([]);
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(() => backfillDays('2026/02/01', undefined, now)).toThrow(BackfillDaysError);
    expect(() => backfillDays('2026-02-01', 'soon', now)).toThrow(BackfillDaysError);
  });
});
