import { describe, expect, it } from 'vitest';

import { LOCAL_DEV_PRINCIPAL, accessFromEnv } from './local-dev-access.js';

describe('accessFromEnv', () => {
  it('recognises nobody without AIA_DEV_AUTH, so every request is refused', async () => {
    const access = accessFromEnv({});
    expect(await access.principals.resolve({ authorization: 'Bearer anything' })).toBeUndefined();
  });

  it('only "1" turns dev access on', async () => {
    expect(await accessFromEnv({ AIA_DEV_AUTH: 'true' }).principals.resolve({})).toBeUndefined();
    expect(await accessFromEnv({ AIA_DEV_AUTH: '1' }).principals.resolve({})).toEqual(LOCAL_DEV_PRINCIPAL);
  });

  it('lets the local developer read every pair', async () => {
    const access = accessFromEnv({ AIA_DEV_AUTH: '1' });
    expect(await access.policy.canReadBars(LOCAL_DEV_PRINCIPAL, 'BTCUSD', '1m')).toBe(true);
  });
});

describe('accessFromEnv with sign-in', () => {
  it('checks plans from config/plans.json: a new account is on the default plan', async () => {
    const access = accessFromEnv({});
    const signedUp = await access.signIn!.signUp('new@example.com', 'a long enough password');
    if (!signedUp.ok) throw new Error('sign-up failed');
    const principal = { kind: 'human' as const, id: signedUp.account.id };
    expect((await access.policy.entitlements(principal)).plan.id).toBe('free');
  });

  it('dev access is on no real plan and offers no upgrade', async () => {
    const access = accessFromEnv({ AIA_DEV_AUTH: '1' });
    expect(await access.policy.entitlements(LOCAL_DEV_PRINCIPAL)).toMatchObject({ plan: { id: 'dev' }, upgradeUrl: undefined });
  });
});
