// Safeguards (M2-10): per-user rate limits, as configuration
// (config/safeguards.json). The bars-per-request cap is the History API's
// (HISTORY_MAX_LIMIT, @aia/market-data); edge rules (WAF) come with the AWS
// stack (M2-01). Pure.

/** What is limited, and per what. */
export const RATE_BUCKETS = {
  /** Bars, plan and live connections, per signed-in user. */
  humanReads: 'per user',
  /** The same, per agent key. */
  agentReads: 'per agent key',
  /** Sign-in attempts, per client address (slows password guessing). */
  signIn: 'per client address',
  /** New accounts, per client address. */
  signUp: 'per client address',
  /** Agent keys created or revoked, per account. */
  agentKeyChanges: 'per account',
} as const;

export type RateBucket = keyof typeof RATE_BUCKETS;

export interface RateRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export type RateLimits = { readonly [B in RateBucket]: RateRule };

export class SafeguardsConfigError extends Error {}

/** The fixed window `nowSeconds` falls in, and the seconds until the next one. */
export function windowOf(nowSeconds: number, windowSeconds: number): { readonly start: number; readonly retryAfter: number } {
  const start = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  return { start, retryAfter: Math.max(1, Math.ceil(start + windowSeconds - nowSeconds)) };
}

/** Check the limits read from JSON; every bucket must be present, with whole positive numbers. */
export function parseRateLimits(input: unknown): RateLimits {
  const fail = (message: string): never => {
    throw new SafeguardsConfigError(message);
  };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('The safeguards config must be an object');
  const limits = (input as Record<string, unknown>)['rateLimits'];
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return fail('rateLimits must be an object');
  const raw = limits as Record<string, unknown>;
  for (const name of Object.keys(raw)) {
    if (!(name in RATE_BUCKETS)) fail(`rateLimits: unknown limit "${name}"; known: ${Object.keys(RATE_BUCKETS).join(', ')}`);
  }
  const rule = (name: RateBucket): RateRule => {
    const value = raw[name];
    if (typeof value !== 'object' || value === null) return fail(`rateLimits.${name} is missing`);
    const { limit, windowSeconds } = value as Record<string, unknown>;
    if (!Number.isInteger(limit) || (limit as number) < 1) fail(`rateLimits.${name}.limit must be a whole number above 0`);
    if (!Number.isInteger(windowSeconds) || (windowSeconds as number) < 1 || (windowSeconds as number) > 86_400) {
      fail(`rateLimits.${name}.windowSeconds must be a whole number from 1 to 86400`);
    }
    return { limit: limit as number, windowSeconds: windowSeconds as number };
  };
  return {
    humanReads: rule('humanReads'),
    agentReads: rule('agentReads'),
    signIn: rule('signIn'),
    signUp: rule('signUp'),
    agentKeyChanges: rule('agentKeyChanges'),
  };
}
