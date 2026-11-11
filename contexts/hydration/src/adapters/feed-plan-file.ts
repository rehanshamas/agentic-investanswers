// Load the feed plan (config/feeds.json), the one place that says which
// provider serves each instrument (CLAUDE.md rule 7). Moved from
// apps/hydration in M2-03, so the platform process reads the same plan.
//
// AIA_FEED_PLAN points at another plan file, for staging or a trial switch.

import { readFileSync } from 'node:fs';

import type { FeedPlan } from '../domain/feed-plan.js';
import { parseFeedPlan } from '../domain/feed-plan.js';
import type { Env } from './registry.js';
import { FeedSetupError } from './registry.js';

const DEFAULT_PLAN = new URL('../../../../config/feeds.json', import.meta.url);

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
