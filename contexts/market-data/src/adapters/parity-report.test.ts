// The parity harness end to end, against the committed synthetic samples in
// `parity-samples/` (see generate.py there). This is what runs in CI while
// the real exports cannot be committed (docs/bar-rules.md, M1-13).

import { join } from 'node:path';

import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { price } from '@aia/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { CookIntraday, INTRADAY_ROLLUPS } from '../application/cook-intraday.js';
import type { CookedBarStorePort } from '../application/cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from '../application/one-minute-bar-source-port.js';
import { RunParity, parityPassed } from '../application/run-parity.js';
import { BTCUSD } from '../domain/parity-instruments.js';
import { formatParityReport } from './parity-report.js';
import { TradingViewExportSource, loadFixture } from './tradingview-export.js';

const SAMPLES = join(__dirname, 'parity-samples');
const SAMPLED: readonly Timeframe[] = ['1m', ...INTRADAY_ROLLUPS];

class MemorySource implements OneMinuteBarSourcePort {
  constructor(private readonly bars: readonly Bar[]) {}

  read(_symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

class MemoryStore implements CookedBarStorePort {
  readonly held = new Map<string, Bar[]>();

  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    const key = `${symbol}/${timeframe}`;
    const merged = new Map((this.held.get(key) ?? []).map((b) => [b.time, b]));
    for (const bar of bars) merged.set(bar.time, bar);
    this.held.set(key, [...merged.values()].sort((a, b) => a.time - b.time));
    return Promise.resolve();
  }

  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const bars = this.held.get(`${symbol}/${timeframe}`) ?? [];
    return Promise.resolve(bars.filter((b) => b.time >= from && b.time <= until));
  }

  getPartition(): Promise<Bar[] | undefined> {
    return Promise.resolve(undefined);
  }
}

let minutes: Bar[];
let source: MemorySource;
let store: MemoryStore;

/** Cook every intraday timeframe from the 1m sample, as M1-06 would. */
async function cookAll(): Promise<void> {
  const cook = new CookIntraday({ source, store });
  const first = minutes[0];
  const last = minutes[minutes.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty 1m sample');
  for (const timeframe of INTRADAY_ROLLUPS) {
    await cook.cookRange(BTCUSD, timeframe, first.time, last.time);
  }
}

function run(timeframes: readonly Timeframe[] = SAMPLED): ReturnType<RunParity['run']> {
  return new RunParity({
    exports: new TradingViewExportSource({ dir: SAMPLES }),
    cooked: store,
    minutes: source,
  }).run([BTCUSD], timeframes);
}

beforeEach(async () => {
  minutes = (await loadFixture(BTCUSD, '1m', { dir: SAMPLES })).bars;
  source = new MemorySource(minutes);
  store = new MemoryStore();
});

describe('parity against the synthetic samples', () => {
  it('is exact for every sampled timeframe once the bars are cooked', async () => {
    await cookAll();
    const results = await run();
    const report = formatParityReport(results);
    expect(results.map((r) => r.kind === 'compared' && r.comparison.status)).toEqual(
      SAMPLED.map(() => 'exact'),
    );
    expect(parityPassed(results)).toBe(true);
    expect(report).toContain('PARITY OK: 5 of 5 files exact.');
  });

  it('compares every bar, and never the forming one', async () => {
    await cookAll();
    const results = await run();
    // Bar counts the generator wrote, minus the forming row: 720 minutes less
    // 10 with no trades, and 144 5m buckets less the one (01:10) with none.
    const matched = results.map((r) => (r.kind === 'compared' ? r.comparison.matched : -1));
    expect(matched).toEqual([710, 143, 48, 12, 3]);
  });

  it('fails on one wrong bar and names it, with carets under the field', async () => {
    await cookAll();
    const hourly = store.held.get('BTCUSD/1h');
    const target = hourly?.[2];
    if (hourly === undefined || target === undefined) throw new Error('no 1h bars cooked');
    hourly[2] = { ...target, high: price(target.high + 1) };

    const results = await run();
    const report = formatParityReport(results);
    expect(parityPassed(results)).toBe(false);
    expect(report).toMatch(/^btcusd_1h\.csv\s+FAIL\s/m);
    expect(report).toContain(
      'btcusd_1h.csv: first difference at 2025-12-31 18:00 UTC (1767204000), 1 field differs: high',
    );
    const block = report.slice(report.indexOf('btcusd_1h.csv: first difference'));
    const [, header, theirs, ours, carets] = block.split('\n');
    expect(header).toMatch(/open\s+high\s+low\s+close\s+volume/);
    expect(theirs).toMatch(/^\s+export\s/);
    expect(ours).toMatch(/^\s+ours\s/);
    // The carets sit exactly under the high column, and only there.
    const column = (header ?? '').indexOf('high');
    expect(carets?.trim()).toMatch(/^\^+$/);
    expect(carets?.lastIndexOf('^')).toBe(column + 'high'.length - 1);
    expect(report).toContain('PARITY FAILED: 4 of 5 files exact.');
  });

  it('fails with a readable report while nothing is built', async () => {
    source = new MemorySource([]);
    const results = await run();
    const report = formatParityReport(results);
    expect(parityPassed(results)).toBe(false);
    for (const timeframe of ['1m', '5m', '15m', '1h', '4h']) {
      expect(report).toMatch(new RegExp(`^btcusd_${timeframe}\\.csv\\s+NOT BUILT\\s`, 'm'));
    }
    expect(report).toContain('NOT BUILT: we hold no bars');
    expect(report).toContain('PARITY FAILED: 0 of 5 files exact.');
    // Nothing differs bar by bar yet, so no first-difference blocks.
    expect(report).not.toContain('first difference');
  });

  it('reports a missing export per file and carries on', async () => {
    await cookAll();
    const results = await run(['5m', '1D']);
    const report = formatParityReport(results);
    expect(report).toMatch(/^btcusd_5m\.csv\s+EXACT\s/m);
    expect(report).toMatch(/^btcusd_1d\.csv\s+NO EXPORT\s/m);
    expect(report).toContain('NO EXPORT: btcusd_1d.csv is missing from');
    expect(parityPassed(results)).toBe(false);
  });

  it('skips the export before our history starts, and says so', async () => {
    // Our history starts at 20:00: the 16:00 4h bar is beyond it, and our
    // first bar (20:00) is skipped as possibly partial, leaving only 00:00.
    source = new MemorySource(minutes.filter((b) => b.time >= 1767211200));
    await cookAll();
    const results = await run(['4h']);
    const report = formatParityReport(results);
    expect(results[0]).toMatchObject({
      kind: 'compared',
      comparison: { status: 'exact', matched: 1, window: { skipped: 2 } },
    });
    expect(report).toContain('SKIPPED: export bars before our history begins');
  });

  it('is never a pass with nothing to compare', () => {
    expect(parityPassed([])).toBe(false);
  });
});
