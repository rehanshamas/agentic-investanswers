import type { Bar, BarTime } from '@aia/shared-kernel';
import { barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { RawDayRef } from './raw-bar-store-port.js';
import { RawMinuteSource } from './raw-minute-source.js';

function bar(time: BarTime): Bar {
  const p = price(parseScaled('100.00', 2));
  return { time, open: p, high: p, low: p, close: p, volume: volume(1) };
}

class MemoryRaw {
  readonly asked: RawDayRef[] = [];
  constructor(private readonly days: Record<string, Bar[]>) {}

  getDay(ref: RawDayRef): Promise<Bar[] | undefined> {
    this.asked.push(ref);
    return Promise.resolve(this.days[`${ref.provider}/${ref.symbol}/${ref.date}`]);
  }
}

const late31 = barTimeFromUtcParts(2025, 12, 31, 23, 58);
const late31b = barTimeFromUtcParts(2025, 12, 31, 23, 59);
const early1 = barTimeFromUtcParts(2026, 1, 1, 0, 1);
const early2 = barTimeFromUtcParts(2026, 1, 2, 0, 0);

describe('RawMinuteSource', () => {
  it('reads each UTC day across a year end, trims to the range, and skips missing days', async () => {
    const raw = new MemoryRaw({
      'coinapi/BTCUSD/2025-12-31': [bar(late31), bar(late31b)],
      'coinapi/BTCUSD/2026-01-01': [bar(early1)],
      // 2026-01-02 was never written: a gap, not an error.
    });
    const source = new RawMinuteSource(raw, () => 'coinapi');

    const bars = await source.read('BTCUSD', late31b, early2);

    expect(bars.map((b) => b.time)).toEqual([late31b, early1]);
    expect(raw.asked.map((r) => r.date)).toEqual(['2025-12-31', '2026-01-01', '2026-01-02']);
    expect(raw.asked.every((r) => r.provider === 'coinapi' && r.symbol === 'BTCUSD')).toBe(true);
  });

  it('reads nothing for a backwards range', async () => {
    const raw = new MemoryRaw({});
    expect(await new RawMinuteSource(raw, () => 'coinapi').read('BTCUSD', early2, early1)).toEqual([]);
    expect(raw.asked).toEqual([]);
  });

  it('reads live minutes for a day with no day file, and prefers the day file once it exists (M1-05)', async () => {
    const live: Record<string, Bar[]> = {
      'live/BTCUSD/2025-12-31': [bar(late31)],
      'live/BTCUSD/2026-01-01': [bar(early1), bar(barTimeFromUtcParts(2026, 1, 1, 0, 2))],
    };
    const raw = Object.assign(new MemoryRaw({ 'hist/BTCUSD/2025-12-31': [bar(late31), bar(late31b)] }), {
      getLiveMinutes: (ref: RawDayRef) => Promise.resolve(live[`${ref.provider}/${ref.symbol}/${ref.date}`] ?? []),
    });
    const source = new RawMinuteSource(raw, () => 'hist', () => 'live');

    const bars = await source.read('BTCUSD', late31, early2);

    // 31 Dec from its day file (2 bars, not the 1 live one); 1 Jan from live minutes.
    expect(bars.map((b) => b.time)).toEqual([late31, late31b, early1, barTimeFromUtcParts(2026, 1, 1, 0, 2)]);
  });
});
