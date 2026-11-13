// In-memory agent keys (M4-01), for tests and local runs without DynamoDB.

import type { AgentKeyStorePort } from '../application/agent-key-store-port.js';
import type { AgentKey } from '../domain/agent-key.js';

export class MemoryAgentKeyStore implements AgentKeyStorePort {
  private readonly byHash = new Map<string, AgentKey>();

  put(key: AgentKey): Promise<void> {
    if (this.byHash.has(key.keyHash)) return Promise.reject(new Error('Agent key collision; refusing to overwrite'));
    this.byHash.set(key.keyHash, key);
    return Promise.resolve();
  }

  findByHash(keyHash: string): Promise<AgentKey | undefined> {
    return Promise.resolve(this.byHash.get(keyHash));
  }

  listByAccount(accountId: string): Promise<readonly AgentKey[]> {
    const keys = [...this.byHash.values()].filter((key) => key.accountId === accountId);
    return Promise.resolve(keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
  }

  delete(accountId: string, keyId: string): Promise<'deleted' | 'not_found'> {
    for (const [hash, key] of this.byHash) {
      if (key.accountId === accountId && key.id === keyId) {
        this.byHash.delete(hash);
        return Promise.resolve('deleted');
      }
    }
    return Promise.resolve('not_found');
  }
}
