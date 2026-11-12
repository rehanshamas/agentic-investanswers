// Public entry of the access context. Other packages import only from here.

export type { Principal, PrincipalKind } from './domain/principal.js';
export type { PrincipalResolverPort, RequestCredentials } from './application/principal-resolver-port.js';
export type { AccessPolicyPort } from './application/access-policy-port.js';
export type { Access } from './adapters/local-dev-access.js';
export {
  AllowEverythingPolicy,
  LOCAL_DEV_PRINCIPAL,
  LocalDevPrincipalResolver,
  NoSignInResolver,
  accessFromEnv,
} from './adapters/local-dev-access.js';
