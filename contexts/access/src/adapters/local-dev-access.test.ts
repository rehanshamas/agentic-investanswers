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
