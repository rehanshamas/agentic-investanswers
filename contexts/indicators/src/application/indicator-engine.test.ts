import type { Bar } from '@aia/shared-kernel';
import { price } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MemoryIndicatorOutputCache } from '../adapters/memory-indicator-output-cache.js';
import type { IndicatorDefinition } from '../domain/indicator-definition.js';
import { defaultSettings } from '../domain/inputs.js';
import { runStart } from '../domain/run-window.js';
import { runAll } from '../domain/stepping.js';
import { btc, makeBars } from '../test-support/bars.js';
import { fakeChannel } from '../test-support/fake-channel.js';
import { MemoryBarSource } from '../test-support/memory-bar-source.js';
import type { IndicatorRequest } from './indicator-engine.js';
import { ENGINE_MAX_POINTS, IndicatorEngine, IndicatorRegistry, IndicatorRegistryError } from './indicator-engine.js';

const WINDOW = 50; // bars per run-window block in these tests
const channel = fakeChannel as IndicatorDefinition<unknown>;
const registry = new IndicatorRegistry([channel]);
const settings = { length: 5, offset: 0.5 };
const request: IndicatorRequest = { indicatorId: 'fakeChannel', instrument: btc, timeframe: '1m', settings, limit: ENGINE_MAX_POINTS };

function setUp(bars: Bar[]) {
  const source = new MemoryBarSource(bars);
  const cache = new MemoryIndicatorOutputCache();
  const engine = new IndicatorEngine({ registry, bars: source, cache, windowBars: WINDOW });
  return { source, cache, engine };
}

/** What a full run over the same window draws, computed without the engine. */
function expected(bars: Bar[]) {
  const newest = bars[bars.length - 1] as Bar;
  const start = runStart('1m', newest.time, WINDOW);
  const full = { ...defaultSettings(channel.inputs), ...settings };
  return runAll(channel, full, btc, bars.filter((b) => b.time >= start)).points;
}

async function points(engine: IndicatorEngine, extra: Partial<IndicatorRequest> = {}) {
  const result = await engine.drawn({ ...request, ...extra });
  if (!result.ok) throw new Error(`expected a result, got ${result.code}`);
  return result;
}

describe('IndicatorEngine', () => {
  const all = makeBars(400);
  // 1m bars from makeBars start at a minute boundary; pick a count that stays inside one block.
  const firstBlockEnd = all.findIndex((b) => runStart('1m', b.time, WINDOW) !== runStart('1m', (all[0] as Bar).time, WINDOW));
  const inBlock = all.slice(0, firstBlockEnd - 5);

  it('computes on a miss, and serves the same request from the cache with no recomputing', async () => {
    const { engine, source } = setUp([...inBlock]);
    const first = await points(engine);
    expect(first.points).toEqual(expected(inBlock));
    expect(engine.stats).toMatchObject({ misses: 1, hits: 0 });

    const stepsBefore = engine.stats.steps;
    const readsBefore = source.reads;
    const second = await points(engine);
    expect(second.points).toEqual(first.points);
    expect(engine.stats.steps - stepsBefore).toBe(0);
    expect(engine.stats.hits).toBe(1);
    expect(source.reads - readsBefore).toBe(2); // newest bar, then the bars from the cached last bar
  });

  it('extends by one bar when one bar closes, rather than recomputing', async () => {
    const bars = inBlock.slice(0, -1);
    const { engine, source } = setUp([...bars]);
    await points(engine);
    source.bars.push(inBlock[inBlock.length - 1] as Bar);

    const stepsBefore = engine.stats.steps;
    const extended = await points(engine);
    expect(engine.stats.steps - stepsBefore).toBe(1);
    expect(extended.points).toEqual(expected(inBlock));

    // And the extension was stored: asking again steps nothing.
    const again = engine.stats.steps;
    await points(engine);
    expect(engine.stats.steps - again).toBe(0);
  });

  it('gives the same answer after losing the cache as when extending it', async () => {
    const { engine, source, cache } = setUp(inBlock.slice(0, 20));
    await points(engine);
    for (const bar of inBlock.slice(20)) {
      source.bars.push(bar);
      await points(engine);
    }
    const extended = await points(engine);
    cache.clear();
    const recomputed = await points(engine);
    expect(recomputed.points).toEqual(extended.points);
    expect(engine.stats.misses).toBe(2);
  });

  it('recomputes when the cached last bar changed in the store (a re-cook)', async () => {
    const { engine, source } = setUp([...inBlock]);
    await points(engine);
    const last = source.bars[source.bars.length - 1] as Bar;
    source.bars[source.bars.length - 1] = { ...last, close: price(last.close + 1), high: price(Math.max(last.high, last.close + 1)) };

    const result = await points(engine);
    expect(engine.stats.stale).toBe(1);
    expect(result.points).toEqual(expected(source.bars));
  });

  it('moves the run start once the newest bar enters the next block, under a new cache key', async () => {
    const { engine, source, cache } = setUp(all.slice(0, firstBlockEnd));
    await points(engine);
    source.bars.push(all[firstBlockEnd] as Bar);
    const crossed = await points(engine);
    expect(crossed.points).toEqual(expected(all.slice(0, firstBlockEnd + 1)));
    expect(cache.size).toBe(2);
  });

  it('previews the forming bar from the closed state, and never caches it', async () => {
    const { engine } = setUp([...inBlock]);
    const formingBar = all[inBlock.length] as Bar;
    const withForming = await points(engine, { forming: formingBar });
    expect(withForming.forming).toEqual(expected([...inBlock, formingBar]).at(-1));

    const stepsBefore = engine.stats.steps;
    const closedOnly = await points(engine);
    expect(engine.stats.steps - stepsBefore).toBe(0);
    expect(closedOnly.points).toEqual(withForming.points);
    expect(closedOnly.forming).toBeUndefined();
  });

  it('ignores a forming bar that is not newer than the last closed bar', async () => {
    const { engine } = setUp([...inBlock]);
    const result = await points(engine, { forming: inBlock[inBlock.length - 1] as Bar });
    expect(result.forming).toBeUndefined();
  });

  it('keys the cache by settings: different settings never share a run', async () => {
    const { engine, cache } = setUp([...inBlock]);
    const a = await points(engine);
    const b = await points(engine, { settings: { ...settings, length: 9 } });
    expect(a.points).not.toEqual(b.points);
    expect(cache.size).toBe(2);
    // Same meaning, different spelling: one entry.
    await points(engine, { settings: { offset: 0.5, length: 5, showSignals: true } });
    expect(cache.size).toBe(2);
  });

  it('returns at most `limit` points, the newest', async () => {
    const { engine } = setUp([...inBlock]);
    const result = await points(engine, { limit: 10 });
    expect(result.points).toEqual(expected(inBlock).slice(-10));
  });

  it('draws nothing when there are no bars yet', async () => {
    const { engine } = setUp([]);
    expect(await engine.drawn(request)).toEqual({ ok: true, points: [] });
  });

  it('refuses an unknown indicator and settings out of range, before reading any bar', async () => {
    const { engine, source } = setUp([...inBlock]);
    expect(await engine.drawn({ ...request, indicatorId: 'atr' })).toMatchObject({ ok: false, code: 'unknown_indicator' });
    const bad = await engine.drawn({ ...request, settings: { length: 0 } });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_settings' });
    expect(source.reads).toBe(0);
  });

  it('returns drawn values only, never indicator state', async () => {
    const { engine } = setUp([...inBlock]);
    const text = JSON.stringify(await points(engine));
    expect(text).not.toContain('internalScratch');
    expect(text).not.toContain('previousUpper');
    expect(text).not.toContain('window');
  });
});

describe('IndicatorRegistry', () => {
  it('refuses the same id twice and a broken definition', () => {
    expect(() => new IndicatorRegistry([channel, channel])).toThrow(IndicatorRegistryError);
    expect(() => new IndicatorRegistry([{ ...channel, outputs: [] }])).toThrow(/no outputs/);
  });

  it('lists what it holds', () => {
    expect(registry.list().map((d) => d.id)).toEqual(['fakeChannel']);
    expect(registry.get('nope')).toBeUndefined();
  });
});
