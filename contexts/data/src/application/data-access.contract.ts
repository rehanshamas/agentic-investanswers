// The DataAccess contract (M1-16): the cases every adapter must pass, the
// in-process one today and a remote one if the data layer ever runs as its own
// service. A factory builds an adapter holding the given 1-minute bars, whose
// cooked bars are their roll-up, plus a way to announce live updates on it.

import type { Bar, BarTime } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { BTCUSD, ETHUSD, NVDA, rollUp } from '@aia/market-data';
import type { LiveBarUpdate, LiveBatch } from '@aia/market-data';
import { afterEach, describe, expect, it } from 'vitest';

import type { Announcer } from '../adapters/memory-data-layer.js';
import type { DataAccess } from './data-access.js';

export interface ContractSubject {
  readonly data: DataAccess;
  readonly announcer: (publisher: string) => Announcer;
  readonly cleanup: () => Promise<void>;
}

export type ContractFactory = (minutes: readonly Bar[], earliest: BarTime) => Promise<ContractSubject>;

const T0 = 1_762_800_000; // a whole 4h boundary
export const EARLIEST = barTime(T0 - 86_400);

/** Six hours of BTC minutes, with gaps, so pages and roll-ups cross holes. */
export function contractMinutes(): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < 360; i++) {
    if (i % 37 === 5 || (i >= 200 && i < 230)) continue;
    const p = 7_000_000 + ((i * 7_919) % 9_000);
    out.push({ time: barTime(T0 + i * 60), open: price(p), high: price(p + 30), low: price(p - 30), close: price(p + 3), volume: volume(100_000_000 + i) });
  }
  return out;
}

export function dataAccessContract(name: string, make: ContractFactory): void {
  describe(`DataAccess contract: ${name}`, () => {
    const minutes = contractMinutes();
    const now = barTime(T0 + 360 * 60 + 5);
    let subject: ContractSubject | undefined;
    const open = async () => (subject = await make(minutes, EARLIEST));
    afterEach(async () => {
      await subject?.cleanup();
      subject = undefined;
    });

    it('lists its instruments and says what it does not serve', async () => {
      const { data } = await open();
      expect(data.instruments.map((i) => i.symbol)).toContain('BTCUSD');
      expect(data.whyNotServed(BTCUSD, '5m')).toBeUndefined();
      expect(data.whyNotServed(BTCUSD, '1D')).toEqual(expect.any(String));
      expect(data.whyNotServed(NVDA, '1m')).toEqual(expect.any(String));
    });

    it('gives ranges equal to a roll-up of the 1-minute bars, for every timeframe', async () => {
      const { data } = await open();
      const from = barTime(T0 + 17 * 60);
      const until = barTime(T0 + 300 * 60);
      expect(await data.bars(BTCUSD, '1m', from, until)).toEqual(minutes.filter((b) => b.time >= from && b.time <= until));
      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        expect(await data.bars(BTCUSD, tf, from, until), tf).toEqual(rollUp(BTCUSD, tf, minutes).filter((b) => b.time >= from && b.time <= until));
      }
      expect(await data.bars(ETHUSD, '5m', from, until)).toEqual([]);
    });

    it('pages history newest first: every bar once, ascending, then next is null at where history starts', async () => {
      const { data } = await open();
      for (const tf of ['1m', '5m'] as const) {
        const seen: number[] = [];
        let before: BarTime | undefined;
        for (let round = 0; round < 100; round++) {
          const page = await data.page(BTCUSD, tf, { limit: 25, now, ...(before === undefined ? {} : { before }) });
          expect(page.bars.map((b) => b.time)).toEqual([...page.bars.map((b) => b.time)].sort((a, b) => a - b));
          seen.unshift(...page.bars.map((b) => b.time));
          if (page.next === null) break;
          before = page.next;
        }
        const expected = (tf === '1m' ? minutes : rollUp(BTCUSD, '5m', minutes)).map((b) => b.time);
        expect(seen, tf).toEqual(expected);
      }
    });

    it('delivers live updates to a subscriber, in order, per publisher', async () => {
      const { data, announcer } = await open();
      const got: LiveBatch[] = [];
      await data.subscribe({ batch: (b) => got.push(b), lost: () => {} });
      const updates: LiveBarUpdate[] = minutes.slice(0, 20).map((bar) => ({ symbol: 'BTCUSD', timeframe: '1m', bar, forming: false }));
      const a = announcer('shard-a');
      const b = announcer('shard-b');
      for (const u of updates) {
        await a.publish([u]);
        await b.publish([{ ...u, symbol: 'ETHUSD' }]);
      }
      const deadline = Date.now() + 3_000;
      while (got.length < 40 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(got.filter((g) => g.publisher === 'shard-a').map((g) => g.seq)).toEqual(updates.map((_, i) => i + 1));
      expect(got.filter((g) => g.publisher === 'shard-b').map((g) => g.updates[0]?.bar.time)).toEqual(updates.map((u) => u.bar.time));
    });
  });
}
