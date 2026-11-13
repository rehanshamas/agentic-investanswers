// Where agent keys are kept (M4-01). Adapters: memory (tests, local runs) and
// DynamoDB (agent data, docs/architecture.md).

import type { AgentKey } from '../domain/agent-key.js';

export interface AgentKeyStorePort {
  put(key: AgentKey): Promise<void>;
  findByHash(keyHash: string): Promise<AgentKey | undefined>;
  /** Oldest first. */
  listByAccount(accountId: string): Promise<readonly AgentKey[]>;
  /** 'not_found' when the account has no key with that id. */
  delete(accountId: string, keyId: string): Promise<'deleted' | 'not_found'>;
}
