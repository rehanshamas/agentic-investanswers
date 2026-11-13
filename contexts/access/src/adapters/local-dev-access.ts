// The access the platform runs with. Decided by Sham, 2026-11-11 and
// 2026-11-13 (decision record T-01, T-03):
// - AIA_DEV_AUTH=1: every request is a local human principal that may see
//   everything. Never outside a developer's machine.
// - Otherwise: the app's own sign-in (M2-08). A request is recognised only
//   with a live session token from sign-up or sign-in.

import type { AccessPolicyPort } from '../application/access-policy-port.js';
import type { PrincipalResolverPort } from '../application/principal-resolver-port.js';
import type { AccountStorePort, SessionStorePort } from '../application/sign-in-ports.js';
import { SignIn } from '../application/sign-in.js';
import type { Principal } from '../domain/principal.js';
import { MemoryAccountStore, MemorySessionStore } from './memory-sign-in-stores.js';
import { NodeCryptoTokens, ScryptPasswordHasher } from './node-crypto-sign-in.js';

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
  /** Sign-up, sign-in and sign-out; absent in dev access mode, where nobody signs in. */
  readonly signIn?: SignIn;
  /** Said once at start-up, so nobody runs with dev access by accident. */
  readonly description: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export interface SignInStores {
  readonly accounts: AccountStorePort;
  readonly sessions: SessionStorePort;
}

/** The app's own sign-in over the given stores, with scrypt passwords and random session tokens. */
export function ownSignIn(stores: SignInStores, now: () => number = () => Date.now()): SignIn {
  return new SignIn({ ...stores, hasher: new ScryptPasswordHasher(), tokens: new NodeCryptoTokens(), now });
}

/**
 * The access the platform runs with, from the environment. Without stores,
 * sign-in keeps accounts in memory (lost on restart).
 */
export function accessFromEnv(env: Env, stores?: SignInStores): Access {
  if (env['AIA_DEV_AUTH'] === '1') {
    return {
      principals: new LocalDevPrincipalResolver(),
      policy: new AllowEverythingPolicy(),
      description: 'AIA_DEV_AUTH=1: every request is the local developer, with access to everything. Local use only.',
    };
  }
  const signIn = ownSignIn(stores ?? { accounts: new MemoryAccountStore(), sessions: new MemorySessionStore() });
  return {
    principals: signIn,
    policy: new AllowEverythingPolicy(),
    signIn,
    description:
      stores === undefined
        ? "The app's own sign-in, with accounts kept in memory: they are lost on restart. Set AIA_DEV_AUTH=1 to skip sign-in locally."
        : "The app's own sign-in.",
  };
}
