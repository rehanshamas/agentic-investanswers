// M2-04: GET /live through the real Fastify server on a real port, with
// Node's own WebSocket client, the real LiveGateway and the in-memory bus.

import { request as httpRequest } from 'node:http';

import type { PrincipalResolverPort } from '@aia/access';
import { accessFromEnv } from '@aia/access';
import type { LiveServerMessage } from '@aia/market-data';
import { BTCUSD, ETHUSD, HistoryQuery, LiveAnnouncer, LiveGateway, MemoryLiveBarsBus, MemoryRecentBarsCache, RecentBars } from '@aia/market-data';
import { barTime, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const empty = { getRange: () => Promise.resolve([]), read: () => Promise.resolve([]) };

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

async function start(options: { principals?: PrincipalResolverPort; allow?: boolean; pingMs?: number } = {}) {
  const dev = accessFromEnv({ AIA_DEV_AUTH: '1' });
  const history = new HistoryQuery({
    recentBars: new RecentBars({ cache: new MemoryRecentBarsCache(), store: empty, minutes: empty }),
    instruments: [BTCUSD, ETHUSD],
    earliest: () => barTime(T0),
  });
  gateway = new LiveGateway({
    instruments: [BTCUSD, ETHUSD],
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
    options: { batchMs: 20 },
  });
  const bus = new MemoryLiveBarsBus();
  await bus.subscribe(gateway);
  app = await buildServer({
    history,
    access: {
      principals: options.principals ?? dev.principals,
      policy: options.allow === false ? { canReadBars: () => Promise.resolve(false) } : dev.policy,
    },
    live: gateway,
    now: () => barTime(T0),
    ...(options.pingMs === undefined ? {} : { pingMs: options.pingMs }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, announcer: new LiveAnnouncer(bus, 'test') };
}

/** A connected client that collects every message. */
async function client(port: number, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live${query}`);
  const messages: LiveServerMessage[] = [];
  let closed: { code: number; reason: string } | undefined;
  ws.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data)) as LiveServerMessage));
  ws.addEventListener('close', (event) => (closed = { code: event.code, reason: event.reason }));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('could not connect')));
  });
  const send = (op: string, instrument: string, tf: string) => ws.send(JSON.stringify({ op, instrument, tf }));
  return { ws, messages, send, closed: () => closed };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The status the server answers a WebSocket upgrade with, without upgrading. */
function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      port,
      host: '127.0.0.1',
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /live', () => {
  it('refuses the upgrade with 401 when no principal is presented', async () => {
    const { port } = await start({ principals: accessFromEnv({}).principals });
    expect(await upgradeStatus(port, '/live')).toBe(401);
  });

  it('takes a token from the query, since browsers cannot set headers on a WebSocket', async () => {
    const principals: PrincipalResolverPort = {
      resolve: ({ authorization }) => Promise.resolve(authorization === 'Bearer good' ? { kind: 'human', id: 'u1' } : undefined),
    };
    const { port } = await start({ principals });
    expect(await upgradeStatus(port, '/live?token=bad')).toBe(401);
    expect(await upgradeStatus(port, '/live?token=good')).toBe(101);
  });

  it('subscribes, then delivers batched updates in display units', async () => {
    const { port, announcer } = await start();
    const c = await client(port);
    c.send('subscribe', 'BTCUSD', '5m');
    await until(() => c.messages.length === 1);
    const bar = { time: barTime(T0), open: price(7_000_000), high: price(7_000_025), low: price(6_999_975), close: price(7_000_001), volume: volume(123_456_789) };
    await announcer.publish([
      { symbol: 'BTCUSD', timeframe: '5m', bar, forming: true },
      { symbol: 'ETHUSD', timeframe: '5m', bar, forming: false },
    ]);
    await until(() => c.messages.length === 2);
    expect(c.messages).toEqual([
      { type: 'subscribed', instrument: 'BTCUSD', timeframe: '5m' },
      {
        type: 'bars',
        updates: [
          { instrument: 'BTCUSD', timeframe: '5m', forming: true, bar: { time: T0, open: 70_000, high: 70_000.25, low: 69_999.75, close: 70_000.01, volume: 1.23456789 } },
        ],
      },
    ]);
    c.ws.close();
  });

  it('checks the plan on every subscription (403 becomes a forbidden error on the socket)', async () => {
    const { port } = await start({ allow: false });
    const c = await client(port);
    c.send('subscribe', 'BTCUSD', '5m');
    await until(() => c.messages.length === 1);
    expect(c.messages[0]).toMatchObject({ type: 'error', code: 'forbidden' });
    c.ws.close();
  });

  it('closes on a binary message or one too large', async () => {
    const { port } = await start();
    const binary = await client(port);
    binary.ws.send(new Uint8Array([1, 2, 3]));
    await until(() => binary.closed() !== undefined);
    expect(binary.closed()?.code).toBe(1003);

    const large = await client(port);
    large.ws.send('x'.repeat(10_000));
    await until(() => large.closed() !== undefined);
    expect(large.closed()?.code).toBe(1009);
  });

  it('forgets a connection once it closes', async () => {
    const { port } = await start();
    const c = await client(port);
    c.send('subscribe', 'BTCUSD', '1m');
    await until(() => c.messages.length === 1);
    expect(gateway?.stats).toEqual({ sessions: 1, subscriptions: 1 });
    c.ws.close();
    await until(() => gateway?.stats.sessions === 0);
  });

  it('keeps answering GET /bars alongside', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/bars?instrument=BTCUSD&tf=5m`);
    expect(res.status).toBe(200);
  });
});
