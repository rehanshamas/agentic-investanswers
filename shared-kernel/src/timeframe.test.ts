import { describe, expect, it } from 'vitest';

import {
  isIntraday,
  isTimeframe,
  TIMEFRAMES,
  timeframeKind,
  timeframeMinutes,
  timeframeSeconds,
} from './timeframe.js';

describe('timeframes', () => {
  it('lists the eight the MVP serves, shortest first', () => {
    expect([...TIMEFRAMES]).toEqual(['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M']);
  });

  it('tells one minute from one month by case', () => {
    // docs/glossary.md fixes this spelling. Only export *file* names avoid the
    // case distinction, because file systems fold it (docs/bar-rules.md).
    expect(timeframeMinutes('1m')).toBe(1);
    expect(timeframeKind('1m')).toBe('intraday');
    expect(timeframeMinutes('1M')).toBeUndefined();
    expect(timeframeKind('1M')).toBe('monthly');
  });

  it('gives minutes and seconds for intraday timeframes', () => {
    expect(timeframeMinutes('5m')).toBe(5);
    expect(timeframeMinutes('15m')).toBe(15);
    expect(timeframeMinutes('1h')).toBe(60);
    expect(timeframeMinutes('4h')).toBe(240);
    expect(timeframeSeconds('4h')).toBe(14_400);
  });

  it('gives no length for calendar timeframes, whose length varies', () => {
    for (const timeframe of ['1D', '1W', '1M'] as const) {
      expect(timeframeMinutes(timeframe)).toBeUndefined();
      expect(timeframeSeconds(timeframe)).toBeUndefined();
      expect(isIntraday(timeframe)).toBe(false);
    }
  });

  it('classifies every timeframe', () => {
    expect(TIMEFRAMES.map(timeframeKind)).toEqual([
      'intraday',
      'intraday',
      'intraday',
      'intraday',
      'intraday',
      'daily',
      'weekly',
      'monthly',
    ]);
  });

  it('recognises valid timeframe strings and rejects near misses', () => {
    for (const timeframe of TIMEFRAMES) expect(isTimeframe(timeframe)).toBe(true);
    for (const bad of ['1min', '60m', '1d', '1w', '1mo', '2h', '', 'toString']) {
      expect(isTimeframe(bad)).toBe(false);
    }
  });

  it('divides a day evenly for every intraday timeframe', () => {
    // What lets crypto bars be anchored by flooring against the epoch.
    for (const timeframe of TIMEFRAMES) {
      const seconds = timeframeSeconds(timeframe);
      if (seconds !== undefined) expect(86_400 % seconds).toBe(0);
    }
  });
});
