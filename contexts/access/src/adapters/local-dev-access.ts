// Access until real sign-in exists (M2-08, waiting on OI-21). Decided by Sham,
// 2026-11-11: with AIA_DEV_AUTH=1 every request is a local human principal
// that may see everything; without it there is no sign-in, so every request
// is refused. Never enable it outside a developer's machine.

import type { AccessPolicyPort } from '../application/access-policy-port.js';
import type { PrincipalResolverPort } from '../application/principal-resolver-port.js';
import type { Principal } from '../domain/principal.js';

export const LOCAL_DEV_PRINCIPAL: Principal = { kind: 'human', id: 'local-dev' };

export class LocalDevPrincipalResolver implements PrincipalResolverPort {
  resolve(): Promise<Principal | undefined> {
    return Promise.resolve(LOCAL_DEV_PRINCIPAL);
  }
}

/** No sign-in configured: nobody is recognised. */
export class NoSignInResolver implements PrincipalResolverPort {
  resolve(): Promise<Principal | undefined> {
    return Promise.resolve(undefined);
  }
}

export class AllowEverythingPolicy implements AccessPolicyPort {
  canReadBars(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export interface Access {
  readonly principals: PrincipalResolverPort;
  readonly policy: AccessPolicyPort;
  /** Said once at start-up, so nobody runs with dev access by accident. */
  readonly description: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The access the platform runs with, from the environment. */
export function accessFromEnv(env: Env): Access {
  if (env['AIA_DEV_AUTH'] === '1') {
    return {
      principals: new LocalDevPrincipalResolver(),
      policy: new AllowEverythingPolicy(),
      description: 'AIA_DEV_AUTH=1: every request is the local developer, with access to everything. Local use only.',
    };
  }
  return {
    principals: new NoSignInResolver(),
    policy: new AllowEverythingPolicy(),
    description: 'No sign-in configured yet (M2-08), so every request is refused with 401. Set AIA_DEV_AUTH=1 to develop locally.',
  };
}
