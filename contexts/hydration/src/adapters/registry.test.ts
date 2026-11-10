import type { Bar } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { HistoryProviderPort } from '../application/history-provider-port.js';
import { parseFeedPlan } from '../domain/feed-plan.js';
import type { AdapterEntry } from './registry.js';
import { ADAPTERS, FeedAdapters, FeedSetupError } from './registry.js';

function fake(name: string): HistoryProviderPort {
  return { name, fetchDay: (): Promise<Bar[]> => Promise.resolve([]) };
}

const registry: Record<string, AdapterEntry> = {
  free: { env: [], history: () => fake('free') },
  keyed: { env: ['KEYED_KEY'], history: () => fake('keyed') },
  liveOnly: { env: [] },
  liar: { env: [], history: () => fake('someone-else') },
};

const plan = parseFeedPlan({
  instruments: [
    {
      symbol: 'AAA',
      defaultFrom: '2024-01-01',
      history: [{ provider: 'free', settleSeconds: 0 }],
    },
    {
      symbol: 'BBB',
      defaultFrom: '2024-01-01',
      history: [{ provider: 'keyed', settleSeconds: 0 }],
    },
  ],
});

describe('FeedAdapters', () => {
  it('builds each adapter once', () => {
    const adapters = new FeedAdapters({}, registry);
    expect(adapters.historyProvider('free')).toBe(adapters.historyProvider('free'));
  });

  it('asks for a key only for the instruments being run', () => {
    const adapters = new FeedAdapters({}, registry);
    expect(adapters.problems(plan, ['AAA'])).toEqual([]);
    expect(adapters.problems(plan)).toEqual(['keyed needs KEYED_KEY (put it in .env)']);
    expect(new FeedAdapters({ KEYED_KEY: 'k' }, registry).problems(plan)).toEqual([]);
  });

  it('reports unknown providers and providers without the asked-for feed', () => {
    const bad = parseFeedPlan({
      instruments: [
        {
          symbol: 'AAA',
          defaultFrom: '2024-01-01',
          history: [
            { provider: 'nobody', settleSeconds: 0 },
            { provider: 'live-only', from: '2025-01-01', settleSeconds: 0 },
          ],
          live: [{ provider: 'ghost' }],
        },
      ],
    });
    const problems = new FeedAdapters({}, { ...registry, 'live-only': { env: [] } }).problems(bad);
    expect(problems).toEqual([
      'AAA: unknown provider "nobody"',
      'AAA: "live-only" does not serve history',
      'AAA: unknown live provider "ghost"',
    ]);
  });

  it('refuses an adapter whose name differs from its registration, since raw keys use the name', () => {
    expect(() => new FeedAdapters({}, registry).historyProvider('liar')).toThrow(FeedSetupError);
  });

  it('refuses to build an adapter whose settings are missing', () => {
    expect(() => new FeedAdapters({}, registry).historyProvider('keyed')).toThrow(/KEYED_KEY/);
  });

  it('registers the real adapters under the names they file raw bars under', () => {
    const adapters = new FeedAdapters({ MASSIVE_API_KEY: 'test' });
    for (const name of Object.keys(ADAPTERS)) expect(adapters.historyProvider(name).name).toBe(name);
  });

  it('reports a live source whose provider serves no live feed', () => {
    const live = parseFeedPlan({
      instruments: [
        { symbol: 'AAA', defaultFrom: '2024-01-01', history: [{ provider: 'free', settleSeconds: 0 }], live: [{ provider: 'free' }] },
      ],
    });
    expect(new FeedAdapters({}, registry).problems(live)).toEqual(['AAA: "free" does not serve live']);
    expect(() => new FeedAdapters({}, registry).liveFeed('free')).toThrow(/does not serve live/);
  });

  it('registers the real live adapters under the names they file raw minutes under', () => {
    const adapters = new FeedAdapters({ MASSIVE_API_KEY: 'test' });
    for (const [name, entry] of Object.entries(ADAPTERS)) {
      if (entry.live !== undefined) expect(adapters.liveFeed(name).name).toBe(name);
    }
  });
});
