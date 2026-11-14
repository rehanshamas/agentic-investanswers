// Agent identity (M4-01; decision record F-04): a signed-in user's read-only
// agent keys, and the principal resolver that turns a key into an agent
// principal linked to its owner. Time is passed in.

import type { AgentKeyView } from '../domain/agent-key.js';
import { AGENT_KEY_PREFIX, MAX_AGENT_KEYS, agentKeyNameProblem, agentKeyView, isAgentKey } from '../domain/agent-key.js';
import type { Principal } from '../domain/principal.js';
import { bearerToken } from '../domain/session.js';
import type { AgentKeyStorePort } from './agent-key-store-port.js';
import type { PrincipalResolverPort, RequestCredentials } from './principal-resolver-port.js';
import type { TokenPort } from './sign-in-ports.js';

export interface AgentKeysDeps {
  readonly store: AgentKeyStorePort;
  readonly tokens: TokenPort;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

export type CreateAgentKeyResult =
  | { readonly ok: true; readonly key: string; readonly agentKey: AgentKeyView }
  | { readonly ok: false; readonly code: 'invalid_name' | 'too_many_keys'; readonly message: string };

export class AgentKeys implements PrincipalResolverPort {
  constructor(private readonly deps: AgentKeysDeps) {}

  /** A new key for the account's agent. The key itself is returned once and never stored. */
  async create(accountId: string, name: string): Promise<CreateAgentKeyResult> {
    const problem = agentKeyNameProblem(name);
    if (problem !== undefined) return { ok: false, code: 'invalid_name', message: problem };
    if ((await this.deps.store.listByAccount(accountId)).length >= MAX_AGENT_KEYS) {
      return { ok: false, code: 'too_many_keys', message: `At most ${MAX_AGENT_KEYS} agent keys per account; revoke one first` };
    }
    const key = AGENT_KEY_PREFIX + this.deps.tokens.newToken();
    const agentKey = {
      id: this.deps.tokens.newId(),
      accountId,
      name: name.trim(),
      scope: 'read' as const,
      keyHash: this.deps.tokens.hashToken(key),
      createdAt: this.deps.now(),
    };
    await this.deps.store.put(agentKey);
    return { ok: true, key, agentKey: agentKeyView(agentKey) };
  }

  async list(accountId: string): Promise<readonly AgentKeyView[]> {
    return (await this.deps.store.listByAccount(accountId)).map(agentKeyView);
  }

  /** The key stops working at once. */
  revoke(accountId: string, keyId: string): Promise<'deleted' | 'not_found'> {
    return this.deps.store.delete(accountId, keyId);
  }

  /** PrincipalResolverPort: a known agent key is an agent principal acting for its owner. */
  async resolve(credentials: RequestCredentials): Promise<Principal | undefined> {
    const token = bearerToken(credentials.authorization);
    if (token === undefined || !isAgentKey(token)) return undefined;
    const key = await this.deps.store.findByHash(this.deps.tokens.hashToken(token));
    return key === undefined ? undefined : { kind: 'agent', id: key.id, owner: key.accountId };
  }
}

/** Tries each resolver in turn; the first principal found wins. */
export class AnyOfResolver implements PrincipalResolverPort {
  private readonly resolvers: readonly PrincipalResolverPort[];

  constructor(...resolvers: PrincipalResolverPort[]) {
    this.resolvers = resolvers;
  }

  async resolve(credentials: RequestCredentials): Promise<Principal | undefined> {
    for (const resolver of this.resolvers) {
      const principal = await resolver.resolve(credentials);
      if (principal !== undefined) return principal;
    }
    return undefined;
  }
}
