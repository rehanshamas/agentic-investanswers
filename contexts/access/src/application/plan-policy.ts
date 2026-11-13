// Plan-based access on placeholder plans (M2-09; decision record T-02). A
// human's plan comes from their account's email; an agent's from its owner's
// account (M4-01). The plan book is configuration
// (config/plans.json), so changing plans changes no code.

import type { Timeframe } from '@aia/shared-kernel';

import type { Plan, PlanBook } from '../domain/plans.js';
import { planFor, planIncludes } from '../domain/plans.js';
import type { Principal } from '../domain/principal.js';
import type { AccessPolicyPort, Entitlements } from './access-policy-port.js';
import type { AccountStorePort } from './sign-in-ports.js';

export class PlanPolicy implements AccessPolicyPort {
  constructor(
    private readonly book: PlanBook,
    private readonly accounts: Pick<AccountStorePort, 'findById'>,
  ) {}

  async canReadBars(principal: Principal, symbol: string, timeframe: Timeframe): Promise<boolean> {
    return planIncludes(await this.planOf(principal), symbol, timeframe);
  }

  async entitlements(principal: Principal): Promise<Entitlements> {
    const plan = await this.planOf(principal);
    return {
      plan: { id: plan.id, name: plan.name },
      instruments: plan.instruments,
      timeframes: plan.timeframes,
      upgradeUrl: this.book.upgradeUrl,
    };
  }

  private async planOf(principal: Principal): Promise<Plan> {
    // An agent reads on its owner's plan (M4-01); one with no owner gets the default plan.
    const accountId = principal.kind === 'human' ? principal.id : principal.owner;
    if (accountId === undefined) return planFor(this.book, undefined);
    const account = await this.accounts.findById(accountId);
    return planFor(this.book, account?.email);
  }
}
