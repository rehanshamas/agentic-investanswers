import { describe, expect, it } from 'vitest';

import {
  FeedPlanError,
  feedsFor,
  historySegments,
  historySourceOn,
  historyStart,
  liveSourceOn,
  parseFeedPlan,
} from './feed-plan.js';

const HOUR = 3600;

/** BTCUSD on Coinbase, switching history to a second provider on 2027-01-01. */
const switching = {
  instruments: [
    {
      symbol: 'BTCUSD',
      defaultFrom: '2024-11-01',
      history: [
        { provider: 'coinbase', settleSeconds: HOUR },
        { provider: 'other', from: '2027-01-01', settleSeconds: 2 * HOUR },
      ],
      live: [{ provider: 'coinbase' }, { provider: 'other', from: '2027-01-01' }],
    },
    {
      symbol: 'NVDA',
      defaultFrom: '2024-11-11',
      history: [
        {
          provider: 'massive',
          from: '2024-11-11',
          settleSeconds: 2 * 24 * HOUR,
        },
      ],
    },
  ],
};

describe('parseFeedPlan', () => {
  it('accepts a plan with dated switches and an instrument without live', () => {
    const plan = parseFeedPlan(switching);
    expect(feedsFor(plan, 'BTCUSD').history).toHaveLength(2);
    expect(feedsFor(plan, 'NVDA').live).toEqual([]);
  });

  it.each([
    ['no instruments array', {}],
    ['a duplicated symbol', { instruments: [switching.instruments[1], switching.instruments[1]] }],
    [
      'no history',
      {
        instruments: [{ symbol: 'X', defaultFrom: '2024-01-01', history: [] }],
      },
    ],
    [
      'a later source without from',
      {
        instruments: [
          {
            symbol: 'X',
            defaultFrom: '2024-01-01',
            history: [
              { provider: 'a', settleSeconds: 0 },
              { provider: 'b', settleSeconds: 0 },
            ],
          },
        ],
      },
    ],
    [
      'sources out of order',
      {
        instruments: [
          {
            symbol: 'X',
            defaultFrom: '2024-01-01',
            history: [
              { provider: 'a', from: '2024-01-01', settleSeconds: 0 },
              { provider: 'b', from: '2023-01-01', settleSeconds: 0 },
            ],
          },
        ],
      },
    ],
    [
      'an unsafe provider name',
      {
        instruments: [
          {
            symbol: 'X',
            defaultFrom: '2024-01-01',
            history: [{ provider: '../raw', settleSeconds: 0 }],
          },
        ],
      },
    ],
    [
      'a missing settle time',
      {
        instruments: [
          {
            symbol: 'X',
            defaultFrom: '2024-01-01',
            history: [{ provider: 'a' }],
          },
        ],
      },
    ],
    [
      'an invalid date',
      {
        instruments: [
          {
            symbol: 'X',
            defaultFrom: '2024-02-30',
            history: [{ provider: 'a', settleSeconds: 0 }],
          },
        ],
      },
    ],
    [
      'a default start before the first source',
      {
        instruments: [
          {
            symbol: 'X',
            defaultFrom: '2024-01-01',
            history: [{ provider: 'a', from: '2024-06-01', settleSeconds: 0 }],
          },
        ],
      },
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => parseFeedPlan(input)).toThrow(FeedPlanError);
  });

  it('names the symbol it does not cover', () => {
    expect(() => feedsFor(parseFeedPlan(switching), 'ETHUSD')).toThrow(/ETHUSD/);
  });
});

describe('sources by day', () => {
  const btc = feedsFor(parseFeedPlan(switching), 'BTCUSD');
  const nvda = feedsFor(parseFeedPlan(switching), 'NVDA');

  it('switches provider on the dated day, and keeps older days on the old one', () => {
    expect(historySourceOn(btc, '2015-01-01')?.provider).toBe('coinbase');
    expect(historySourceOn(btc, '2026-12-31')?.provider).toBe('coinbase');
    expect(historySourceOn(btc, '2027-01-01')?.provider).toBe('other');
    expect(liveSourceOn(btc, '2026-12-31')?.provider).toBe('coinbase');
    expect(liveSourceOn(btc, '2027-01-02')?.provider).toBe('other');
  });

  it('has no source before the first one starts, and no live source when none is planned', () => {
    expect(historySourceOn(nvda, '2024-11-10')).toBeUndefined();
    expect(liveSourceOn(nvda, '2026-11-10')).toBeUndefined();
  });

  it('starts at the default, or moves a too-early start forward', () => {
    expect(historyStart(nvda, undefined)).toEqual({
      start: '2024-11-11',
      moved: false,
    });
    expect(historyStart(nvda, '1999-01-22')).toEqual({
      start: '2024-11-11',
      moved: true,
    });
    expect(historyStart(btc, '2014-01-01')).toEqual({
      start: '2014-01-01',
      moved: false,
    });
  });

  it('splits a range across a switch, each run on one source', () => {
    const runs = historySegments(btc, '2026-12-30', '2027-01-02');
    expect(runs.map((r) => [r.source.provider, r.from, r.until])).toEqual([
      ['coinbase', '2026-12-30', '2026-12-31'],
      ['other', '2027-01-01', '2027-01-02'],
    ]);
  });

  it('leaves the last run open when there is no end, and drops runs outside the range', () => {
    expect(historySegments(btc, '2027-02-01', undefined).map((r) => [r.source.provider, r.from, r.until])).toEqual([
      ['other', '2027-02-01', undefined],
    ]);
    expect(historySegments(btc, '2024-11-01', undefined).map((r) => [r.source.provider, r.until])).toEqual([
      ['coinbase', '2026-12-31'],
      ['other', undefined],
    ]);
    expect(historySegments(btc, '2024-11-01', '2024-11-30').map((r) => r.source.provider)).toEqual(['coinbase']);
  });
});
