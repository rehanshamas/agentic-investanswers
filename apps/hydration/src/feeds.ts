// Build the feed plan's adapters. Shared by every hydration command, so none
// of them names a provider (CLAUDE.md rule 7). Loading the plan itself is
// `loadFeedPlan` in @aia/hydration.

import type { Env, FeedPlan } from '@aia/hydration';
import { FeedAdapters, FeedSetupError, feedsFor } from '@aia/hydration';

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
