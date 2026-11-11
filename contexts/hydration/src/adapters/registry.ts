// The provider adapters, by the name the feed plan uses (CLAUDE.md rule 7).
//
// This is the only place that turns a provider name into an adapter. Adding a
// provider means writing its adapter folder and one entry here; moving an
// instrument onto it is then a feed plan change only. Each entry says which
// feeds it can serve and which settings it reads from the environment, so a
// plan naming a provider that cannot serve what it is asked for fails at
// startup rather than mid-run.

import type { HistoryProviderPort } from '../application/history-provider-port.js';
import type { LiveFeedOptions, LiveTradesPort } from '../application/live-trades-port.js';
import type { FeedPlan } from '../domain/feed-plan.js';
import { CoinbaseCandles } from './coinbase/coinbase-candles.js';
import { CoinbaseTrades } from './coinbase/coinbase-trades.js';
import { MassiveAggregates } from './massive/massive-aggregates.js';

export class FeedSetupError extends Error {}

export type Env = Readonly<Record<string, string | undefined>>;

export interface AdapterEntry {
  /** Environment variables the adapter needs, for example an API key. */
  readonly env: readonly string[];
  readonly history?: (env: Env) => HistoryProviderPort;
  readonly live?: (env: Env, options: LiveFeedOptions) => LiveTradesPort;
}

export const ADAPTERS: Readonly<Record<string, AdapterEntry>> = {
  // Coinbase Exchange public API and feed: free, keyless (M1-04, M1-05).
  coinbase: {
    env: [],
    history: () => new CoinbaseCandles(),
    live: (_env, options) => new CoinbaseTrades(options),
  },
  // Massive aggregates for US stocks (M1-07).
  massive: {
    env: ['MASSIVE_API_KEY'],
    history: (env) => new MassiveAggregates({ apiKey: env['MASSIVE_API_KEY'] ?? '' }),
  },
};

/**
 * Builds adapters for a feed plan, once each, and checks the plan only names
 * providers that exist and can serve what it asks of them.
 */
export class FeedAdapters {
  private readonly history = new Map<string, HistoryProviderPort>();

  constructor(
    private readonly env: Env,
    private readonly registry: Readonly<Record<string, AdapterEntry>> = ADAPTERS,
  ) {}

  /**
   * Every problem with running `plan` here: unknown providers, providers
   * asked for a feed they do not offer. Missing settings are reported only
   * for the instruments in `symbols`, so a crypto run needs no stock API key.
   */
  problems(plan: FeedPlan, symbols?: readonly string[]): string[] {
    const found = new Set<string>();
    for (const feeds of plan.instruments) {
      const used = symbols === undefined || symbols.includes(feeds.symbol);
      for (const source of feeds.history) {
        const entry = this.registry[source.provider];
        if (entry === undefined) found.add(`${feeds.symbol}: unknown provider "${source.provider}"`);
        else if (entry.history === undefined) found.add(`${feeds.symbol}: "${source.provider}" does not serve history`);
        else if (used)
          for (const key of this.missingEnv(entry)) found.add(`${source.provider} needs ${key} (put it in .env)`);
      }
      for (const source of feeds.live) {
        const entry = this.registry[source.provider];
        if (entry === undefined) found.add(`${feeds.symbol}: unknown live provider "${source.provider}"`);
        else if (entry.live === undefined) found.add(`${feeds.symbol}: "${source.provider}" does not serve live`);
        else if (used)
          for (const key of this.missingEnv(entry)) found.add(`${source.provider} needs ${key} (put it in .env)`);
      }
    }
    return [...found];
  }

  /** The history adapter registered as `provider`. */
  historyProvider(provider: string): HistoryProviderPort {
    const built = this.history.get(provider);
    if (built !== undefined) return built;
    const entry = this.entry(provider);
    if (entry.history === undefined) throw new FeedSetupError(`"${provider}" does not serve history`);
    const adapter = entry.history(this.env);
    if (adapter.name !== provider) {
      // The adapter's name is the raw key's provider; a mismatch would file its
      // bars under a different provider than the plan reads them from.
      throw new FeedSetupError(`Adapter registered as "${provider}" calls itself "${adapter.name}"`);
    }
    this.history.set(provider, adapter);
    return adapter;
  }

  /** A new live adapter registered as `provider`; one per stream, since options differ. */
  liveFeed(provider: string, options: LiveFeedOptions = {}): LiveTradesPort {
    const entry = this.entry(provider);
    if (entry.live === undefined) throw new FeedSetupError(`"${provider}" does not serve live`);
    const adapter = entry.live(this.env, options);
    if (adapter.name !== provider) {
      throw new FeedSetupError(`Adapter registered as "${provider}" calls itself "${adapter.name}"`);
    }
    return adapter;
  }

  private entry(provider: string): AdapterEntry {
    const entry = this.registry[provider];
    if (entry === undefined) throw new FeedSetupError(`No adapter is registered as "${provider}"`);
    const missing = this.missingEnv(entry);
    if (missing.length > 0) throw new FeedSetupError(`${provider} needs ${missing.join(', ')} (put it in .env)`);
    return entry;
  }

  private missingEnv(entry: AdapterEntry): string[] {
    return entry.env.filter((key) => (this.env[key] ?? '') === '');
  }
}
