// What a principal may see: plan-based entitlements (M2-09). Every REST route
// and WebSocket subscription asks here first (docs/architecture.md,
// "Security").

import type { Timeframe } from '@aia/shared-kernel';

import type { Includes } from '../domain/plans.js';
import type { Principal } from '../domain/principal.js';

/** What a principal's plan includes, for the chart to show what is locked before anyone asks. */
export interface Entitlements {
  readonly plan: { readonly id: string; readonly name: string };
  readonly instruments: Includes<string>;
  readonly timeframes: Includes<Timeframe>;
  /** Where to upgrade; undefined when there is nothing to upgrade to (dev access). */
  readonly upgradeUrl: string | undefined;
}

export interface AccessPolicyPort {
  canReadBars(principal: Principal, symbol: string, timeframe: Timeframe): Promise<boolean>;
  entitlements(principal: Principal): Promise<Entitlements>;
}
