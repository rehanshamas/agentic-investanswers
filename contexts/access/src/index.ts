// Public entry of the access context. Other packages import only from here.

export type { Principal, PrincipalKind } from './domain/principal.js';
export { mayWrite } from './domain/principal.js';
export type { AgentKey, AgentKeyView, AgentScope } from './domain/agent-key.js';
export { AGENT_KEY_PREFIX, MAX_AGENT_KEYS, isAgentKey } from './domain/agent-key.js';
export type { AgentKeyStorePort } from './application/agent-key-store-port.js';
export type { AgentKeysDeps, CreateAgentKeyResult } from './application/agent-keys.js';
export { AgentKeys, AnyOfResolver } from './application/agent-keys.js';
export { MemoryAgentKeyStore } from './adapters/memory-agent-key-store.js';
export { DynamoAgentKeyStore } from './adapters/dynamodb-agent-key-store.js';
export type { PrincipalResolverPort, RequestCredentials } from './application/principal-resolver-port.js';
export type { AccessPolicyPort, Entitlements } from './application/access-policy-port.js';
export type { Includes, Plan, PlanBook } from './domain/plans.js';
export { PlanConfigError, parsePlanBook, planFor, planIncludes } from './domain/plans.js';
export { PlanPolicy } from './application/plan-policy.js';
export { loadPlanBook } from './adapters/plan-file.js';
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

export type { RateBucket, RateLimits, RateRule } from './domain/safeguards.js';
export { RATE_BUCKETS, SafeguardsConfigError, parseRateLimits, windowOf } from './domain/safeguards.js';
export type { RateCounterPort, RateDecision, RateLimiterDeps } from './application/rate-limiter.js';
export { RateLimiter } from './application/rate-limiter.js';
export { MemoryRateCounter } from './adapters/memory-rate-counter.js';
export type { RedisRateCounterOptions } from './adapters/redis-rate-counter.js';
export { RedisRateCounter } from './adapters/redis-rate-counter.js';
export { loadRateLimits } from './adapters/safeguards-file.js';
