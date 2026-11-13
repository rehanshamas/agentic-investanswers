import { describe, expect, it } from 'vitest';

import { MemoryAccountStore } from '../adapters/memory-sign-in-stores.js';
import { parsePlanBook } from '../domain/plans.js';
import { PlanPolicy } from './plan-policy.js';

const book = parsePlanBook({
  upgradeUrl: 'https://example.com/upgrade',
  defaultPlan: 'free',
  plans: [
    { id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] },
    { id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' },
  ],
  assignments: { 'pro@example.com': 'pro' },
});

async function policy() {
  const accounts = new MemoryAccountStore();
  for (const [id, email] of [['a-free', 'free@example.com'], ['a-pro', 'pro@example.com']] as const) {
    await accounts.create({ id, email, passwordHash: 'x', createdAt: 0 });
  }
  return new PlanPolicy(book, accounts);
}

describe('PlanPolicy', () => {
  it("checks a human's bars against the plan of their account's email", async () => {
    const p = await policy();
    expect(await p.canReadBars({ kind: 'human', id: 'a-free' }, 'BTCUSD', '1h')).toBe(true);
    expect(await p.canReadBars({ kind: 'human', id: 'a-free' }, 'ETHUSD', '1h')).toBe(false);
    expect(await p.canReadBars({ kind: 'human', id: 'a-pro' }, 'ETHUSD', '1m')).toBe(true);
  });

  it('gives an unknown account and an agent the default plan', async () => {
    const p = await policy();
    expect((await p.entitlements({ kind: 'human', id: 'gone' })).plan.id).toBe('free');
    expect((await p.entitlements({ kind: 'agent', id: 'key-1' })).plan.id).toBe('free');
  });

  it('describes the plan and where to upgrade', async () => {
    expect(await (await policy()).entitlements({ kind: 'human', id: 'a-free' })).toEqual({
      plan: { id: 'free', name: 'Free' },
      instruments: ['BTCUSD'],
      timeframes: ['1h'],
      upgradeUrl: 'https://example.com/upgrade',
    });
  });
});
