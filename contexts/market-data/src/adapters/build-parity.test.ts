// Build parity and the fidelity report end to end, against the committed
// synthetic samples in `parity-samples/`. The samples' higher timeframes were
// aggregated independently in Python (generate.py), so an exact result here
// is our rollups agreeing with a second implementation, not with themselves.

import { join } from 'node:path';

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { ParityExport, ParityExportSourcePort } from '../application/run-parity.js';
import { RunParity, parityPassed } from '../application/run-parity.js';
import { BTCUSD } from '../domain/parity-instruments.js';
import { formatFidelityReport, formatParityReport } from './parity-report.js';
import { TradingViewExportSource } from './tradingview-export.js';

const SAMPLES = join(__dirname, 'parity-samples');
const TARGETS: readonly Timeframe[] = ['5m', '15m', '1h', '4h'];

/** The samples, with an optional change to one bar of one file. */
class Samples implements ParityExportSourcePort {
  private readonly files = new TradingViewExportSource({ dir: SAMPLES });
  constructor(private readonly tamper?: { timeframe: Timeframe; index: number; change: (b: Bar) => Bar }) {}

  async load(instrument: Instrument, timeframe: Timeframe): Promise<ParityExport> {
    const loaded = await this.files.load(instrument, timeframe);
    const t = this.tamper;
    if (t === undefined || t.timeframe !== timeframe) return loaded;
    return { ...loaded, bars: loaded.bars.map((b, i) => (i === t.index ? t.change(b) : b)) };
  }
}

function build(exports: ParityExportSourcePort, targets = TARGETS): ReturnType<RunParity['runBuild']> {
  // The samples cover 12 hours, so the 14-day settle rule is off here; it is
  // tested in domain/build-parity.test.ts.
  return new RunParity({ exports, settleSeconds: 0 }).runBuild([BTCUSD], targets);
}

describe('build parity on the synthetic samples', () => {
  it('is exact for every target, with no stores at all', async () => {
    const results = await build(new Samples());
    expect(parityPassed(results)).toBe(true);
    // Each target loses only the bar holding its source's last bar, which
    // may be partial: 5m 143 - 1, 15m 48 - 1, 1h 12 - 1, 4h 3 - 1.
    expect(results.map((r) => (r.kind === 'compared' ? r.comparison.matched : -1))).toEqual([
      142, 47, 11, 2,
    ]);
    const report = formatParityReport(results, { label: 'BUILD PARITY' });
    expect(report).toMatch(/^btcusd_5m\.csv\s+EXACT\s.*btcusd_1m\.csv$/m);
    expect(report).toContain('BUILD PARITY OK: 4 of 4 files exact.');
  });

  it('fails on one wrong bar in a target export and names it', async () => {
    const results = await build(
      new Samples({ timeframe: '15m', index: 5, change: (b) => ({ ...b, low: price(b.low - 1) }) }),
    );
    const report = formatParityReport(results, { label: 'BUILD PARITY' });
    expect(parityPassed(results)).toBe(false);
    expect(report).toMatch(/^btcusd_15m\.csv\s+FAIL\s/m);
    expect(report).toContain('btcusd_15m.csv: first difference at 2025-12-31 17:15 UTC');
    expect(report).toContain('1 field differs: low');
    expect(report).toContain('BUILD PARITY FAILED: 3 of 4 files exact.');
  });

  it('fails when the finer export is wrong, too: either side can be the one that differs', async () => {
    const results = await build(
      new Samples({ timeframe: '1h', index: 0, change: (b) => ({ ...b, volume: volume(b.volume + 1) }) }),
      ['4h'],
    );
    expect(results[0]).toMatchObject({ comparison: { status: 'differs', differing: 1 } });
  });

  it('reports a timeframe without a finer sample as NO EXPORT, and skips 1m', async () => {
    const results = await build(new Samples(), ['1m', '5m', '1D']);
    const report = formatParityReport(results, { label: 'BUILD PARITY' });
    expect(results).toHaveLength(2);
    expect(report).toMatch(/^btcusd_1d\.csv\s+NO EXPORT\s/m);
    expect(parityPassed(results)).toBe(false);
  });
});

describe('the fidelity report', () => {
  /** Our "stored" bars: the sample itself, with every 10th volume 1% high. */
  function stored(bars: readonly Bar[]): Bar[] {
    return bars.map((b, i) => (i % 10 === 0 ? { ...b, volume: volume(Math.round(b.volume * 1.01)) } : b));
  }

  it('shows match rates per field and the largest volume gap, with no verdict', async () => {
    const samples = new TradingViewExportSource({ dir: SAMPLES });
    const minutes = stored((await samples.load(BTCUSD, '1m')).bars);
    const results = await new RunParity({
      exports: samples,
      minutes: {
        read: (_s: string, from: BarTime, until: BarTime) =>
          Promise.resolve(minutes.filter((b) => b.time >= from && b.time <= until)),
      },
    }).run([BTCUSD], ['1m']);

    const report = formatFidelityReport(results);
    // 710 bars; 71 have their volume changed, and 1% of these small volumes
    // rounds to a real change on every one of them.
    expect(report).toMatch(/^btcusd_1m\.csv\s+DIFFERS\s.*\s710\s+100\.00\s+100\.00\s+100\.00\s+100\.00\s+90\.00\s+1\.\d\d\s+0\s+0$/m);
    expect(report).toContain('Source fidelity is reported only; it does not affect the exit code.');
    expect(report).not.toMatch(/OK:|FAILED:/);
  });
});
