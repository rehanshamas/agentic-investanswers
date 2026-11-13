// The same cases for every account and session store: memory always, and
// DynamoDB when the local one from `docker compose up -d` is reachable.

import { afterAll, describe, expect, it } from 'vitest';

import type { AccountStorePort, SessionStorePort } from '../application/sign-in-ports.js';
import { DynamoAccountStore, DynamoSessionStore, dynamoClient, ensureUsersTable } from './dynamodb-sign-in-stores.js';
import { MemoryAccountStore, MemorySessionStore } from './memory-sign-in-stores.js';

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
if (dynamo === undefined) console.warn('DynamoDB unreachable: skipping the DynamoDB store tests (run: docker compose up -d)');
afterAll(() => dynamo?.destroy());

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const stores: Array<[string, () => { accounts: AccountStorePort; sessions: SessionStorePort } | undefined]> = [
  ['memory', () => ({ accounts: new MemoryAccountStore(), sessions: new MemorySessionStore() })],
  ['dynamodb', () => (dynamo ? { accounts: new DynamoAccountStore(dynamo, TABLE), sessions: new DynamoSessionStore(dynamo, TABLE) } : undefined)],
];

describe.each(stores)('%s sign-in stores', (name, make) => {
  const made = make();
  const email = (tag: string) => `${tag}-${name}-${run}@example.com`;

  it.skipIf(made === undefined)('creates an account and finds it by email and by id', async () => {
    const account = { id: `id-${name}-${run}-1`, email: email('a'), passwordHash: 'scrypt$1$2$3$x$y', createdAt: 1_763_000_000_123 };
    expect(await made?.accounts.create(account)).toBe('created');
    expect(await made?.accounts.findByEmail(account.email)).toEqual(account);
    expect(await made?.accounts.findById(account.id)).toEqual(account);
    expect(await made?.accounts.findByEmail(email('nobody'))).toBeUndefined();
  });

  it.skipIf(made === undefined)('refuses a second account with the same email, keeping the first', async () => {
    const first = { id: `id-${name}-${run}-2`, email: email('b'), passwordHash: 'h1', createdAt: 1 };
    const second = { ...first, id: `id-${name}-${run}-3`, passwordHash: 'h2' };
    expect(await made?.accounts.create(first)).toBe('created');
    expect(await made?.accounts.create(second)).toBe('email_taken');
    expect(await made?.accounts.findByEmail(first.email)).toEqual(first);
    expect(await made?.accounts.findById(second.id)).toBeUndefined();
  });

  it.skipIf(made === undefined)('puts, gets and deletes a session', async () => {
    const session = { tokenHash: `hash-${name}-${run}`, accountId: 'acc', createdAt: 1_000, expiresAt: 2_592_001_000 };
    await made?.sessions.put(session);
    expect(await made?.sessions.get(session.tokenHash)).toEqual(session);
    await made?.sessions.delete(session.tokenHash);
    expect(await made?.sessions.get(session.tokenHash)).toBeUndefined();
  });
});
