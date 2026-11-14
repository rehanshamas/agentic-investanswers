import { describe, expect, it } from 'vitest';

import { MemoryAgentKeyStore } from '../adapters/memory-agent-key-store.js';
import { MemoryAccountStore } from '../adapters/memory-sign-in-stores.js';
import { NodeCryptoTokens } from '../adapters/node-crypto-sign-in.js';
import { AGENT_KEY_PREFIX, MAX_AGENT_KEYS } from '../domain/agent-key.js';
import { parsePlanBook } from '../domain/plans.js';
import { mayWrite } from '../domain/principal.js';
import { AgentKeys, AnyOfResolver } from './agent-keys.js';
import { PlanPolicy } from './plan-policy.js';

const NOW = 1_763_000_000_000;

function agentKeys(store = new MemoryAgentKeyStore()) {
  return { store, keys: new AgentKeys({ store, tokens: new NodeCryptoTokens(), now: () => NOW }) };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('AgentKeys', () => {
  it('creates a key shown once; the key authenticates as a read-only agent acting for its owner', async () => {
    const { keys } = agentKeys();
    const created = await keys.create('acc-1', '  research agent ');
    if (!created.ok) throw new Error(created.message);
    expect(created.key.startsWith(AGENT_KEY_PREFIX)).toBe(true);
    expect(created.agentKey).toEqual({ id: expect.any(String), name: 'research agent', scope: 'read', createdAt: NOW });

    const principal = await keys.resolve(bearer(created.key));
    expect(principal).toEqual({ kind: 'agent', id: created.agentKey.id, owner: 'acc-1' });
    expect(mayWrite(principal!)).toBe(false);
  });

  it('stores only a hash of the key', async () => {
    const { keys, store } = agentKeys();
    const created = await keys.create('acc-1', 'a');
    if (!created.ok) throw new Error(created.message);
    const [stored] = await store.listByAccount('acc-1');
    expect(JSON.stringify(stored)).not.toContain(created.key.slice(AGENT_KEY_PREFIX.length));
  });

  it('recognises no other token: wrong keys, session-looking tokens, no header', async () => {
    const { keys } = agentKeys();
    await keys.create('acc-1', 'a');
    expect(await keys.resolve(bearer(`${AGENT_KEY_PREFIX}not-a-real-key`))).toBeUndefined();
    expect(await keys.resolve(bearer('a-session-token'))).toBeUndefined();
    expect(await keys.resolve({})).toBeUndefined();
  });

  it('lists and revokes; a revoked key stops working at once, and only its owner can revoke it', async () => {
    const { keys } = agentKeys();
    const created = await keys.create('acc-1', 'a');
    if (!created.ok) throw new Error(created.message);
    expect(await keys.list('acc-1')).toEqual([created.agentKey]);
    expect(await keys.revoke('acc-2', created.agentKey.id)).toBe('not_found');
    expect(await keys.revoke('acc-1', created.agentKey.id)).toBe('deleted');
    expect(await keys.resolve(bearer(created.key))).toBeUndefined();
    expect(await keys.list('acc-1')).toEqual([]);
  });

  it('refuses a blank or overlong name, and more than the maximum number of keys', async () => {
    const { keys } = agentKeys();
    expect(await keys.create('acc-1', '   ')).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(await keys.create('acc-1', 'x'.repeat(65))).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(await keys.create('acc-1', 'tab\there')).toMatchObject({ ok: false, code: 'invalid_name' });
    for (let i = 0; i < MAX_AGENT_KEYS; i += 1) expect((await keys.create('acc-1', `k${i}`)).ok).toBe(true);
    expect(await keys.create('acc-1', 'one more')).toMatchObject({ ok: false, code: 'too_many_keys' });
    expect((await keys.create('acc-2', 'other account')).ok).toBe(true);
  });
});

describe('AnyOfResolver', () => {
  it('takes the first principal any resolver finds', async () => {
    const none = { resolve: () => Promise.resolve(undefined) };
    const human = { resolve: () => Promise.resolve({ kind: 'human' as const, id: 'h' }) };
    expect(await new AnyOfResolver(none, human).resolve({})).toEqual({ kind: 'human', id: 'h' });
    expect(await new AnyOfResolver(none).resolve({})).toBeUndefined();
  });
});

describe("an agent's plan", () => {
  it("is its owner's plan", async () => {
    const accounts = new MemoryAccountStore();
    await accounts.create({ id: 'acc-pro', email: 'pro@example.com', passwordHash: 'x', createdAt: 0 });
    const book = parsePlanBook({
      upgradeUrl: 'https://example.com/upgrade',
      defaultPlan: 'free',
      plans: [
        { id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] },
        { id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' },
      ],
      assignments: { 'pro@example.com': 'pro' },
    });
    const policy = new PlanPolicy(book, accounts);
    expect(await policy.canReadBars({ kind: 'agent', id: 'k', owner: 'acc-pro' }, 'ETHUSD', '1m')).toBe(true);
    expect(await policy.canReadBars({ kind: 'agent', id: 'k' }, 'ETHUSD', '1m')).toBe(false);
  });
});
