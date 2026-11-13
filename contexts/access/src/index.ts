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

export type { Account, AccountView } from './domain/account.js';
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, isValidEmail, normaliseEmail, passwordProblem } from './domain/account.js';
export type { Session } from './domain/session.js';
export { SESSION_LIFETIME_MS, bearerToken } from './domain/session.js';
export type { AccountStorePort, PasswordHasherPort, SessionStorePort, TokenPort } from './application/sign-in-ports.js';
export type { SignInDeps, SignInResult, SignUpError, SignUpResult } from './application/sign-in.js';
export { SignIn } from './application/sign-in.js';
export type { SignInStores } from './adapters/local-dev-access.js';
export { ownSignIn } from './adapters/local-dev-access.js';
export { MemoryAccountStore, MemorySessionStore } from './adapters/memory-sign-in-stores.js';
export { NodeCryptoTokens, ScryptPasswordHasher } from './adapters/node-crypto-sign-in.js';
export type { DynamoConfig } from './adapters/dynamodb-sign-in-stores.js';
export { DynamoAccountStore, DynamoSessionStore, dynamoClient, ensureUsersTable } from './adapters/dynamodb-sign-in-stores.js';
