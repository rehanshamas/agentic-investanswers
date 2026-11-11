// What a principal may see. Plan-based entitlements arrive with M2-09; every
// REST route and WebSocket subscription asks here first (docs/architecture.md,
// "Security").

import type { Timeframe } from '@aia/shared-kernel';

import type { Principal } from '../domain/principal.js';

export interface AccessPolicyPort {
  canReadBars(principal: Principal, symbol: string, timeframe: Timeframe): Promise<boolean>;
}
