// Load the feed plan (config/feeds.json) and build its adapters. Shared by
// every hydration command, so none of them names a provider (CLAUDE.md rule 7).
//
// AIA_FEED_PLAN points at another plan file, for staging or a trial switch.

import { readFileSync } from 'node:fs';

import type { Env, FeedPlan } from '@aia/hydration';
import { FeedAdapters, FeedSetupError, feedsFor, historySourceOn, parseFeedPlan } from '@aia/hydration';

import type { ProviderOf } from './raw-minute-source.js';

const DEFAULT_PLAN = new URL('../../../config/feeds.json', import.meta.url);

export function loadFeedPlan(env: Env = process.env): FeedPlan {
  const path = env['AIA_FEED_PLAN'] ?? DEFAULT_PLAN;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new FeedSetupError(`Could not read the feed plan at ${String(path)}: ${String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FeedSetupError(`The feed plan at ${String(path)} is not valid JSON: ${String(error)}`);
  }
  return parseFeedPlan(json);
}

/**
 * The plan's adapters, after checking the plan can run here for `symbols`:
 * every provider registered, every needed setting present.
 */
export function feedAdapters(plan: FeedPlan, symbols: readonly string[], env: Env = process.env): FeedAdapters {
  for (const symbol of symbols) feedsFor(plan, symbol);
  const adapters = new FeedAdapters(env);
  const problems = adapters.problems(plan, symbols);
  if (problems.length > 0) throw new FeedSetupError(`The feed plan cannot run: ${problems.join('; ')}`);
  return adapters;
}

/** Which provider's raw files hold an instrument's bars for a day, per the plan. */
export function rawProviderOf(plan: FeedPlan): ProviderOf {
  return (symbol, date) => historySourceOn(feedsFor(plan, symbol), date)?.provider;
}
