// M4-01: agent identity through the real server and access wiring. A user
// creates a read-only agent key; the agent reads bars and follows live bars
// on its owner's plan, and is refused anything that changes an account.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_KEY_PREFIX, accessFromEnv } from '@aia/access';
import type { LiveServerMessage } from '@aia/serving';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const PASSWORD = 'correct horse battery';

const dir = mkdtempSync(join(tmpdir(), 'aia-agents-'));
const PLANS = join(dir, 'plans.json');
writeFileSync(
  PLANS,
  JSON.stringify({
    upgradeUrl: 'https://example.com/upgrade',
    defaultPlan: 'free',
    plans: [
      { id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] },
      { id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' },
    ],
    assignments: { 'pro@example.com': 'pro' },
  }),
);

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

async function start() {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], earliest: barTime(T0) });
  const history = new HistoryQuery({ data });
  gateway = new LiveGateway({ data, every: () => () => undefined });
  app = await buildServer({ history, access: accessFromEnv({ AIA_PLANS: PLANS }), live: gateway, now: () => barTime(T0) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  return { a: app, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUp(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

async function newKey(a: FastifyInstance, session: string, name = 'research agent') {
  const res = await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(session), payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json() as { key: string; agentKey: { id: string; name: string; scope: string; createdAt: number } };
}

async function firstLiveAnswer(port: number, token: string, instrument: string, tf: string): Promise<LiveServerMessage> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${encodeURIComponent(token)}`);
  try {
    const first = new Promise<LiveServerMessage>((resolve) =>
      ws.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as LiveServerMessage), { once: true }),
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('could not connect')));
    });
    ws.send(JSON.stringify({ op: 'subscribe', instrument, tf }));
    return await first;
  } finally {
    ws.close();
  }
}

describe('agent keys', () => {
  it('a signed-in user creates a key, sees it once, lists it and revokes it', async () => {
    const { a } = await start();
    const session = await signUp(a, 'sam@example.com');
    const { key, agentKey } = await newKey(a, session);
    expect(key.startsWith(AGENT_KEY_PREFIX)).toBe(true);
    expect(agentKey).toMatchObject({ name: 'research agent', scope: 'read' });

    const listed = await a.inject({ method: 'GET', url: '/auth/agent-keys', headers: auth(session) });
    expect(listed.json()).toEqual([agentKey]);
    expect(listed.body).not.toContain(key);

    expect((await a.inject({ method: 'DELETE', url: `/auth/agent-keys/${agentKey.id}`, headers: auth(session) })).statusCode).toBe(204);
    expect((await a.inject({ method: 'DELETE', url: `/auth/agent-keys/${agentKey.id}`, headers: auth(session) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(key) })).statusCode).toBe(401);
  });

  it('refuses key management without sign-in, and a bad name', async () => {
    const { a } = await start();
    expect((await a.inject({ method: 'GET', url: '/auth/agent-keys' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'POST', url: '/auth/agent-keys', payload: { name: 'x' } })).statusCode).toBe(401);
    const session = await signUp(a, 'sam@example.com');
    const blank = await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(session), payload: { name: ' ' } });
    expect([blank.statusCode, blank.json().error.code]).toEqual([400, 'invalid_name']);
    expect((await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(session), payload: {} })).statusCode).toBe(400);
  });

  it('one user cannot revoke or see another user’s key', async () => {
    const { a } = await start();
    const { key, agentKey } = await newKey(a, await signUp(a, 'sam@example.com'));
    const other = await signUp(a, 'kim@example.com');
    expect((await a.inject({ method: 'GET', url: '/auth/agent-keys', headers: auth(other) })).json()).toEqual([]);
    expect((await a.inject({ method: 'DELETE', url: `/auth/agent-keys/${agentKey.id}`, headers: auth(other) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(key) })).statusCode).toBe(200);
  });
});

describe('an agent token', () => {
  it('authenticates on /bars, /plan and /live, on its owner’s plan', async () => {
    const { a, port } = await start();
    const { key: freeKey } = await newKey(a, await signUp(a, 'sam@example.com'));
    const { key: proKey } = await newKey(a, await signUp(a, 'pro@example.com'));

    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(freeKey) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=ETHUSD&tf=5m', headers: auth(freeKey) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=ETHUSD&tf=5m', headers: auth(proKey) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(proKey) })).json()).toMatchObject({ plan: { id: 'pro' } });

    expect(await firstLiveAnswer(port, freeKey, 'BTCUSD', '1h')).toMatchObject({ type: 'subscribed' });
    expect(await firstLiveAnswer(port, freeKey, 'ETHUSD', '1h')).toMatchObject({ type: 'error', code: 'forbidden' });
  });

  it('is read-only: it cannot manage keys, see the account, or sign its owner out', async () => {
    const { a } = await start();
    const session = await signUp(a, 'sam@example.com');
    const { key, agentKey } = await newKey(a, session);

    for (const [method, url] of [
      ['GET', '/auth/agent-keys'],
      ['POST', '/auth/agent-keys'],
      ['DELETE', `/auth/agent-keys/${agentKey.id}`],
    ] as const) {
      const res = await a.inject({ method, url, headers: auth(key), ...(method === 'POST' ? { payload: { name: 'sneaky' } } : {}) });
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'read_only']);
    }
    expect((await a.inject({ method: 'GET', url: '/auth/me', headers: auth(key) })).statusCode).toBe(401);
    expect((await a.inject({ method: 'POST', url: '/auth/sign-out', headers: auth(key) })).statusCode).toBe(204);
    // The owner's session and the key both still work: nothing was changed.
    expect((await a.inject({ method: 'GET', url: '/auth/me', headers: auth(session) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/auth/agent-keys', headers: auth(session) })).json()).toHaveLength(1);
  });
});
