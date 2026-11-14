// M2-05 done-check: the chart renders and the live bar updates. Through the
// real browser, the built chart and the real platform server (on made-up bars;
// see playwright.config.ts). The tests drive the live feed with the e2e
// server's /e2e/trade and /e2e/store and read the bars the chart holds.

import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const PLATFORM = 'http://127.0.0.1:8181';
/** The e2e server's NOW: minute 0 starts here. */
const NOW_MS = 1_794_312_000_000;

interface Shown {
  readonly ticker: string | undefined;
  readonly period: string | undefined;
  readonly bars: readonly (readonly [number, number])[];
}

/** What the chart holds: its instrument, timeframe, and [time ms, close] per bar. */
function shown(page: Page): Promise<Shown> {
  return page.evaluate(() => {
    const chart = window.__aiaChart;
    const period = chart?.getPeriod();
    return {
      ticker: chart?.getSymbol()?.ticker,
      period: period === null || period === undefined ? undefined : `${period.span}${period.type}`,
      bars: (chart?.getDataList() ?? []).map((d) => [d.timestamp, d.close] as const),
    };
  });
}

const trade = (request: APIRequestContext, instrument: string, minute: number, close: number) =>
  request.post(`${PLATFORM}/e2e/trade`, { data: { instrument, minute, close } });
const store = (request: APIRequestContext, instrument: string, minute: number, close?: number) =>
  request.post(`${PLATFORM}/e2e/store`, { data: { instrument, minute, ...(close === undefined ? {} : { close }) } });

/** Opens the chart and waits until it shows its first page and is live. */
async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-connection', 'open');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await shown(page)).bars.length).toBe(500);
}

test.describe.configure({ mode: 'serial' });

test('the chart renders the newest 500 bars and the live bar updates', async ({ page, request }) => {
  await open(page);
  await expect(page.getByTestId('chart').locator('canvas').first()).toBeVisible();
  const first = await shown(page);
  expect(first.ticker).toBe('BTCUSD');
  expect(first.period).toBe('1minute');
  expect(first.bars.at(-1)?.[0]).toBe(NOW_MS - 60_000);

  // A trade in the minute starting at NOW: a new live bar appears.
  expect((await trade(request, 'BTCUSD', 0, 91_000.5)).ok()).toBe(true);
  await expect.poll(async () => (await shown(page)).bars.at(-1)).toEqual([NOW_MS, 91_000.5]);

  // Another trade in the same minute: that bar updates in place.
  expect((await trade(request, 'BTCUSD', 0, 91_010.25)).ok()).toBe(true);
  await expect.poll(async () => (await shown(page)).bars.at(-1)).toEqual([NOW_MS, 91_010.25]);
  expect((await shown(page)).bars).toHaveLength(501);
});

test('the previous bar is revised when its stored value replaces the forming one', async ({ page, request }) => {
  await open(page);
  // The page was loaded after the trades above: it has history up to NOW only, and the forming minute comes live.
  expect((await trade(request, 'BTCUSD', 0, 91_020)).ok()).toBe(true);
  expect((await trade(request, 'BTCUSD', 1, 91_030)).ok()).toBe(true);
  await expect.poll(async () => (await shown(page)).bars.slice(-2)).toEqual([
    [NOW_MS, 91_020],
    [NOW_MS + 60_000, 91_030],
  ]);

  // Minute 0 is stored with a last trade at 91,015: an update to the bar before the newest one.
  expect((await store(request, 'BTCUSD', 0, 91_015)).ok()).toBe(true);
  await expect.poll(async () => (await shown(page)).bars.slice(-2)).toEqual([
    [NOW_MS, 91_015],
    [NOW_MS + 60_000, 91_030],
  ]);
});

test('switching instrument and timeframe loads their bars and follows them live', async ({ page, request }) => {
  await open(page);

  await page.getByTestId('instrument').selectOption('ETHUSD');
  await expect.poll(async () => (await shown(page)).ticker).toBe('ETHUSD');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await shown(page)).bars.length).toBe(500);
  const eth = await shown(page);
  expect(eth.bars.at(-1)?.[1]).toBeGreaterThan(2_500);
  expect(eth.bars.at(-1)?.[1]).toBeLessThan(3_500);

  await page.getByTestId('tf-1h').click();
  await expect.poll(async () => (await shown(page)).period).toBe('1hour');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await shown(page)).bars.at(-1)?.[0]).toBe(NOW_MS - 3_600_000);

  // A trade on ETHUSD forms its 1h bar starting at NOW.
  expect((await trade(request, 'ETHUSD', 0, 3_111.111)).ok()).toBe(true);
  await expect.poll(async () => (await shown(page)).bars.at(-1)).toEqual([NOW_MS, 3_111.111]);

  // BTCUSD trades are no longer shown.
  const before = (await shown(page)).bars.length;
  expect((await trade(request, 'BTCUSD', 1, 99_999)).ok()).toBe(true);
  await page.waitForTimeout(300);
  expect((await shown(page)).bars).toHaveLength(before);
});
