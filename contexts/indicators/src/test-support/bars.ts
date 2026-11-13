// Test bars and an instrument for the indicators context's tests.

import type { Bar, Instrument } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';

export const btc: Instrument = {
  symbol: 'BTCUSD',
  kind: 'crypto',
  venue: 'test',
  timeZone: 'UTC',
  priceScale: 2,
  volumeScale: 8,
};

const START = 1_731_000_000 - (1_731_000_000 % 60);

/** `n` one-minute bars with a deterministic zig-zag, prices in cents. */
export function makeBars(n: number, startOffset = 0): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = i + startOffset;
    const base = 6_000_000 + ((k * 7919) % 2_000) * (k % 2 === 0 ? 1 : -1) + k * 13;
    const open = base;
    const close = base + ((k * 31) % 400) - 200;
    const high = Math.max(open, close) + ((k * 17) % 150) + 1;
    const low = Math.min(open, close) - ((k * 23) % 150) - 1;
    bars.push({
      time: barTime(START + k * 60),
      open: price(open),
      high: price(high),
      low: price(low),
      close: price(close),
      volume: volume(100_000_000 + k),
    });
  }
  return bars;
}
