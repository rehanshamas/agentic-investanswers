// The same cases for every agent key store: memory always, and DynamoDB when
// the local one from `docker compose up -d` is reachable (CI runs it).

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentKeyStorePort } from '../application/agent-key-store-port.js';
import type { AgentKey } from '../domain/agent-key.js';
import { DynamoAgentKeyStore } from './dynamodb-agent-key-store.js';
import { dynamoClient, ensureUsersTable } from './dynamodb-sign-in-stores.js';
import { MemoryAgentKeyStore } from './memory-agent-key-store.js';

const TABLE = 'aia-users-test';

async function dynamoOrUndefined() {
  const client = dynamoClient({
    endpoint: process.env['AIA_DYNAMODB_TEST_URL'] ?? 'http://127.0.0.1:8000',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    table: TABLE,
  });
  try {
    await ensureUsersTable(client, TABLE);
    return client;
  } catch {
    client.destroy();
    return undefined;
  }
}

const dynamo = await dynamoOrUndefined();
if (dynamo === undefined) console.warn('DynamoDB unreachable: skipping the DynamoDB agent key tests (run: docker compose up -d)');
afterAll(() => dynamo?.destroy());

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const stores: Array<[string, () => AgentKeyStorePort | undefined]> = [
  ['memory', () => new MemoryAgentKeyStore()],
  ['dynamodb', () => (dynamo ? new DynamoAgentKeyStore(dynamo, TABLE) : undefined)],
];

describe.each(stores)('%s agent key store', (name, make) => {
  const store = make();
  const key = (tag: string, accountId: string, createdAt: number): AgentKey => ({
    id: `key-${tag}-${name}-${run}`,
    accountId,
    name: `agent ${tag}`,
    scope: 'read',
    keyHash: `hash-${tag}-${name}-${run}`,
    createdAt,
  });

  it.skipIf(store === undefined)('finds a key by its hash, and lists an account’s keys oldest first', async () => {
    const account = `acc-1-${name}-${run}`;
    const [a, b, other] = [key('a', account, 2_000), key('b', account, 1_000), key('c', `acc-2-${name}-${run}`, 500)];
    for (const k of [a, b, other]) await store?.put(k);
    expect(await store?.findByHash(a.keyHash)).toEqual(a);
    expect(await store?.findByHash(`hash-none-${run}`)).toBeUndefined();
    expect(await store?.listByAccount(account)).toEqual([b, a]);
    expect(await store?.listByAccount(`acc-none-${run}`)).toEqual([]);
  });

  it.skipIf(store === undefined)('deletes a key from both the lookup and the list, only for its own account', async () => {
    const account = `acc-3-${name}-${run}`;
    const k = key('d', account, 1);
    await store?.put(k);
    expect(await store?.delete(`acc-other-${run}`, k.id)).toBe('not_found');
    expect(await store?.findByHash(k.keyHash)).toEqual(k);
    expect(await store?.delete(account, k.id)).toBe('deleted');
    expect(await store?.findByHash(k.keyHash)).toBeUndefined();
    expect(await store?.listByAccount(account)).toEqual([]);
    expect(await store?.delete(account, k.id)).toBe('not_found');
  });

  it.skipIf(store === undefined)('refuses to overwrite a key with the same hash', async () => {
    const k = key('e', `acc-4-${name}-${run}`, 1);
    await store?.put(k);
    await expect(store?.put({ ...k, id: `${k.id}-2` })).rejects.toThrow(/collision/);
  });
});
