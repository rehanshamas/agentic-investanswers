import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TIMEFRAMES } from '@aia/shared-kernel';
import type { Instrument } from '@aia/shared-kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { BTCUSD, ETHUSD } from '../domain/parity-instruments.js';
import {
  DEFAULT_FIXTURE_DIR,
  FixtureError,
  fixtureFileName,
  listFixtureFiles,
  loadFixture,
  loadFixtures,
  summariseFixtures,
} from './tradingview-export.js';

/** Where the real exports live, relative to the repo root. */
const REAL_DIR = join(__dirname, '..', '..', '..', '..', DEFAULT_FIXTURE_DIR);

/** A throwaway directory for the hand-written edge-case files. */
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'aia-fixture-'));
});

const HEADER = 'time,open,high,low,close,Volume';
async function write(name: string, body: string): Promise<void> {
  await writeFile(join(scratch, name), body, 'utf8');
}

describe('fixtureFileName', () => {
  it('uses the lower-case storage token, with 1mo for monthly', () => {
    expect(fixtureFileName('BTCUSD', '1m')).toBe('btcusd_1m.csv');
    expect(fixtureFileName('BTCUSD', '1M')).toBe('btcusd_1mo.csv');
    expect(fixtureFileName('BTCUSD', '1D')).toBe('btcusd_1d.csv');
    expect(fixtureFileName('NVDA', '4h')).toBe('nvda_4h.csv');
  });

  it('gives every timeframe a distinct name, even ignoring case', () => {
    const names = TIMEFRAMES.map((t) => fixtureFileName('BTCUSD', t).toLowerCase());
    expect(new Set(names).size).toBe(TIMEFRAMES.length);
  });
});

describe('parsing', () => {
  it('reads a well-formed file into exact scaled integers', async () => {
    await write('btcusd_1h.csv', [
      HEADER,
      '1710460800,68123.45,68200.00,68100.01,68150.99,1.23456789',
      '1710464400,68150.99,68300.50,68150.00,68290.10,0.00000001',
      '1710468000,68290.10,68290.10,68290.10,68290.10,0',
    ].join('\n'));
    const fixture = await loadFixture(BTCUSD, '1h', { dir: scratch });

    // Three rows in, two bars out: the last is the forming bar.
    expect(fixture.bars).toHaveLength(2);
    expect(fixture.formingBarDropped?.time).toBe(1710468000);
    expect(fixture.bars[0]?.open).toBe(6812345); // 68123.45 at scale 2
    expect(fixture.bars[0]?.volume).toBe(123456789); // 1.23456789 at scale 8
    expect(fixture.bars[1]?.volume).toBe(1); // one satoshi-equivalent unit
  });

  it('accepts a capitalised Volume column, which is what TradingView writes', async () => {
    await write('btcusd_5m.csv', [HEADER, '1710460800,1.00,1.00,1.00,1.00,0', '1710461100,1.00,1.00,1.00,1.00,0'].join('\n'));
    await expect(loadFixture(BTCUSD, '5m', { dir: scratch })).resolves.toBeDefined();
  });

  it('rounds away float noise in volume, having proved it is noise', async () => {
    // TradingView's own float sums: measured worst case 4.55e-13.
    await write('btcusd_15m.csv', [
      HEADER,
      '1710460800,1.00,1.00,1.00,1.00,10.178870479999999',
      '1710461700,1.00,1.00,1.00,1.00,0',
    ].join('\n'));
    const fixture = await loadFixture(BTCUSD, '15m', { dir: scratch });
    expect(fixture.bars[0]?.volume).toBe(1017887048); // 10.17887048 at scale 8
  });

  it('refuses a value that genuinely needs more precision than the scale', async () => {
    // Not noise: a real third decimal place on a 2-decimal instrument.
    await write('btcusd_1m.csv', [
      HEADER,
      '1710460800,68123.456,68123.456,68123.456,68123.456,1',
      '1710460860,1.00,1.00,1.00,1.00,0',
    ].join('\n'));
    await expect(loadFixture(BTCUSD, '1m', { dir: scratch })).rejects.toThrow(FixtureError);
  });

  it('holds ETH prices at three decimal places', async () => {
    await write('ethusd_1d.csv', [
      HEADER,
      '1590624000,208.41,220.675,204.5,220.415,1000',
      '1590710400,220.345,224.8,217.535,220.62,1000',
      '1590796800,220.62,221.00,220.00,220.50,1000',
    ].join('\n'));
    const fixture = await loadFixture(ETHUSD, '1D', { dir: scratch });
    expect(fixture.bars[0]?.high).toBe(220675); // 220.675 at scale 3
    expect(fixture.bars[1]?.low).toBe(217535); // 217.535 at scale 3
  });

  it('reports a missing file in a way that says what to do', async () => {
    await expect(loadFixture(BTCUSD, '4h', { dir: join(scratch, 'nope') })).rejects.toThrow(
      /is missing from/,
    );
  });

  it('rejects a missing column rather than reading the wrong one', async () => {
    await write('btcusd_1w.csv', 'time,open,high,low,close\n1710460800,1,1,1,1');
    await expect(loadFixture(BTCUSD, '1W', { dir: scratch })).rejects.toThrow(/no "volume" column/);
  });

  it('rejects a millisecond timestamp, which is the likely export mistake', async () => {
    await write('btcusd_1mo.csv', [HEADER, '1710460800000,1,1,1,1,0'].join('\n'));
    await expect(loadFixture(BTCUSD, '1M', { dir: scratch })).rejects.toThrow();
  });

  it('rejects an empty cell instead of reading it as zero', async () => {
    await write('btcusd_1d.csv', [HEADER, '1710460800,1,,1,1,0', '1710547200,1,1,1,1,0'].join('\n'));
    await expect(loadFixture(BTCUSD, '1D', { dir: scratch })).rejects.toThrow(/is empty/);
  });

  it('rejects an incoherent bar, where the high is not the highest price', async () => {
    await write('btcusd_1m.csv', [
      HEADER,
      '1710460800,100.00,99.00,98.00,98.50,1',
      '1710460860,1.00,1.00,1.00,1.00,0',
    ].join('\n'));
    await expect(loadFixture(BTCUSD, '1m', { dir: scratch })).rejects.toThrow();
  });

  it('rejects bars that are not strictly ascending', async () => {
    await write('btcusd_5m.csv', [
      HEADER,
      '1710461100,1.00,1.00,1.00,1.00,0',
      '1710460800,1.00,1.00,1.00,1.00,0',
    ].join('\n'));
    await expect(loadFixture(BTCUSD, '5m', { dir: scratch })).rejects.toThrow(/ascending/);
  });

  it('rejects a crypto bar off the timeframe grid', async () => {
    await write('btcusd_1h.csv', [
      HEADER,
      '1710460830,1.00,1.00,1.00,1.00,0', // 30 seconds past the hour
      '1710464400,1.00,1.00,1.00,1.00,0',
    ].join('\n'));
    await expect(loadFixture(BTCUSD, '1h', { dir: scratch })).rejects.toThrow(/grid/);
  });
});

describe('the real exports', () => {
  it('lists 16 crypto files', async () => {
    const files = await listFixtureFiles(REAL_DIR);
    expect(files).toHaveLength(16);
    expect(files).toContain('btcusd_1m.csv');
    expect(files).toContain('ethusd_1mo.csv');
  });

  it('loads every crypto timeframe, and prints the row counts', async () => {
    // The done-check for this task: a loader test with row counts per file.
    const fixtures = await loadFixtures([BTCUSD, ETHUSD], TIMEFRAMES, { dir: REAL_DIR });
    expect(fixtures).toHaveLength(16);
    for (const fixture of fixtures) {
      expect(fixture.bars.length).toBeGreaterThan(100);
      expect(fixture.formingBarDropped).toBeDefined();
    }
    console.log(`\n${summariseFixtures(fixtures)}\n`);
  });

  it('agrees with the counts measured outside the loader', async () => {
    // Row counts seen directly in the files, minus the dropped forming bar.
    const expected: Record<string, number> = {
      'btcusd_1m.csv': 2504, 'btcusd_5m.csv': 1652, 'btcusd_15m.csv': 9325,
      'btcusd_1h.csv': 14189, 'btcusd_4h.csv': 10215, 'btcusd_1d.csv': 4326,
      'btcusd_1w.csv': 620, 'btcusd_1mo.csv': 143,
      'ethusd_1m.csv': 2511, 'ethusd_5m.csv': 7886, 'ethusd_15m.csv': 12539,
      'ethusd_1h.csv': 4459, 'ethusd_4h.csv': 10634, 'ethusd_1d.csv': 3821,
      'ethusd_1w.csv': 545, 'ethusd_1mo.csv': 126,
    };
    const fixtures = await loadFixtures([BTCUSD, ETHUSD], TIMEFRAMES, { dir: REAL_DIR });
    const actual = Object.fromEntries(fixtures.map((f) => [f.file, f.bars.length]));
    expect(actual).toEqual(expected);
  });

  it('gives bars whose own prices are coherent and strictly ascending', async () => {
    const fixtures = await loadFixtures([BTCUSD, ETHUSD], TIMEFRAMES, { dir: REAL_DIR });
    for (const fixture of fixtures) {
      let previous = 0;
      for (const bar of fixture.bars) {
        expect(bar.time).toBeGreaterThan(previous);
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        previous = bar.time;
      }
    }
  });
});

describe('summariseFixtures', () => {
  it('prints a row per file plus a total, and shows the dropped bar', async () => {
    await write('btcusd_1m.csv', [
      HEADER,
      '1710460800,1.00,1.00,1.00,1.00,0',
      '1710460860,1.00,1.00,1.00,1.00,0',
    ].join('\n'));
    const fixture = await loadFixture(BTCUSD, '1m', { dir: scratch });
    const text = summariseFixtures([fixture]);
    expect(text).toContain('btcusd_1m.csv');
    expect(text).toContain('TOTAL');
    expect(text).toMatch(/DROPPED/);
  });
});

/** Keeps the Instrument import honest about what the loader needs. */
const _shape: Instrument = BTCUSD;
void _shape;
