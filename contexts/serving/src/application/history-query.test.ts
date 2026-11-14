import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, parseScaled, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { BarsPage, PageQuery } from '@aia/data';
import { BTCUSD, MemoryDataLayer, NVDA } from '@aia/data';

import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, HistoryQuery } from './history-query.js';

const T0 = barTime(1_762_800_000);
const asked: Array<{ symbol: string; timeframe: Timeframe; query: PageQuery }> = [];
// What is served comes from the data layer's own rules.
const layer = new MemoryDataLayer({ instruments: [BTCUSD, NVDA] });

function query(page: BarsPage = { bars: [], next: null }): HistoryQuery {
  asked.length = 0;
  return new HistoryQuery({
    data: {
      instruments: [BTCUSD, NVDA],
      whyNotServed: (instrument, timeframe) => layer.whyNotServed(instrument, timeframe),
      page: (instrument: Instrument, timeframe: Timeframe, q: PageQuery) => {
        asked.push({ symbol: instrument.symbol, timeframe, query: q });
        return Promise.resolve(page);
      },
    },
  });
}

const errorOf = (q: Record<string, unknown>) => {
  const parsed = query().parse(q);
  return parsed.ok ? undefined : parsed.error;
};

describe('HistoryQuery.parse', () => {
  it('accepts a minimal request with the default limit', () => {
    const parsed = query().parse({ instrument: 'BTCUSD', tf: '5m' });
    expect(parsed).toEqual({ ok: true, request: { instrument: BTCUSD, timeframe: '5m', limit: HISTORY_DEFAULT_LIMIT } });
  });

  it('accepts limit and before', () => {
    const parsed = query().parse({ instrument: 'BTCUSD', tf: '1m', limit: '20', before: String(T0) });
    expect(parsed.ok && parsed.request).toMatchObject({ limit: 20, before: T0 });
  });

  it('enforces the cap: 1,000 is accepted, 1,001 is refused with the cap in the message', () => {
    expect(query().parse({ instrument: 'BTCUSD', tf: '5m', limit: String(HISTORY_MAX_LIMIT) }).ok).toBe(true);
    const error = errorOf({ instrument: 'BTCUSD', tf: '5m', limit: '1001' });
    expect(error?.code).toBe('limit_too_large');
    expect(error?.message).toContain('1000');
    expect(errorOf({ instrument: 'BTCUSD', tf: '5m', limit: '99999999999' })?.code).toBe('bad_parameter');
  });

  it.each([
    [{ tf: '5m' }, 'instrument'],
    [{ instrument: 'BTCUSD' }, 'tf'],
    [{ instrument: 'BTCUSD', tf: '5M' }, 'tf'],
    [{ instrument: 'BTCUSD', tf: '5m', limit: '0' }, 'limit'],
    [{ instrument: 'BTCUSD', tf: '5m', limit: '-5' }, 'limit'],
    [{ instrument: 'BTCUSD', tf: '5m', limit: '2.5' }, 'limit'],
    [{ instrument: 'BTCUSD', tf: '5m', before: '1762800000000' }, 'before'],
    [{ instrument: 'BTCUSD', tf: '5m', before: 'yesterday' }, 'before'],
    [{ instrument: 'BTCUSD', tf: '5m', timeframe: '5m' }, 'timeframe'],
    [{ instrument: ['BTCUSD', 'ETHUSD'], tf: '5m' }, 'instrument'],
  ])('refuses %j, naming "%s"', (q, name) => {
    const error = errorOf(q);
    expect(error?.code).toBe('bad_parameter');
    expect(error?.message).toContain(name);
  });

  it('refuses an unknown instrument, listing the known ones', () => {
    expect(errorOf({ instrument: 'DOGEUSD', tf: '5m' })).toEqual({
      code: 'unknown_instrument',
      message: 'unknown instrument "DOGEUSD"; known: BTCUSD, NVDA',
    });
  });

  it('refuses stocks and calendar timeframes until M1-08', () => {
    expect(errorOf({ instrument: 'NVDA', tf: '5m' })?.code).toBe('timeframe_not_served');
    expect(errorOf({ instrument: 'BTCUSD', tf: '1D' })?.code).toBe('timeframe_not_served');
  });
});

describe('HistoryQuery.run', () => {
  const bar: Bar = {
    time: T0,
    open: price(parseScaled('73695.96', 2)),
    high: price(parseScaled('73721.19', 2)),
    low: price(parseScaled('73695.05', 2)),
    close: price(parseScaled('73715.25', 2)),
    volume: volume(parseScaled('2.08374451', 8)),
  };

  it('returns the page in display units, with next', async () => {
    const q = query({ bars: [bar], next: T0 as BarTime });
    const response = await q.run({ instrument: BTCUSD, timeframe: '5m', limit: 1 }, barTime(T0 + 600));
    expect(response).toEqual({
      instrument: 'BTCUSD',
      timeframe: '5m',
      bars: [{ time: T0, open: 73695.96, high: 73721.19, low: 73695.05, close: 73715.25, volume: 2.08374451 }],
      next: T0,
    });
  });

  it('passes limit, before, now and where history starts to the page', async () => {
    const q = query();
    await q.run({ instrument: BTCUSD, timeframe: '1h', limit: 7, before: T0 }, barTime(T0 + 1));
    expect(asked).toEqual([
      // Where history starts is the data layer's to apply since M1-16 (covered by the DataAccess contract).
      { symbol: 'BTCUSD', timeframe: '1h', query: { limit: 7, before: T0, now: T0 + 1 } },
    ]);
  });
});
