// The platform's HTTP server (M2-03): routes mapped onto the contexts' use
// cases. No business rules here: parameters and the cap are HistoryQuery's
// and who follows what live is LiveGateway's (@aia/serving, over the data
// layer @aia/data, M1-16); who is asking and what they may see are the access
// context's.
//
//   GET /health
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000
//   GET /live   upgraded to a WebSocket; the protocol is in @aia/client-contract (live-protocol.ts)
//   GET /plan   what the caller's plan includes, and where to upgrade (M2-09)
//   GET /instruments   every instrument, its timeframes served and included, and display precision (M2-05)
//   POST /mcp   read-only MCP tools for agents (M4-02); see mcp-route.ts
//   /auth/*     the app's own sign-in (M2-08) and agent keys (M4-01), when configured;
//               see auth-routes.ts and agent-key-routes.ts
//
// Errors are `{ error: { code, message } }`. A plan refusal (403 forbidden)
// adds `upgradeUrl`. A refused live subscription is a `forbidden` message on
// the socket; the chart takes the upgrade link from GET /plan.

import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import type { Access, Principal } from '@aia/access';
import type { DataAccess } from '@aia/data';
import type { HistoryQuery, LiveGateway } from '@aia/serving';
import { LIVE_MAX_CLIENT_MESSAGE } from '@aia/serving';
import type { BarTime } from '@aia/shared-kernel';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyLoggerOptions, FastifyRequest } from 'fastify';

import { mountAgentKeyRoutes } from './agent-key-routes.js';
import { mountAuthRoutes } from './auth-routes.js';
import { mountMcpRoute } from './mcp-route.js';
import type { Limits } from './rate-limit.js';
import { refusedForRate } from './rate-limit.js';
import { ReadQueries } from './read-queries.js';

export interface ServerDeps {
  readonly history: Pick<HistoryQuery, 'parse' | 'run'>;
  readonly access: Pick<Access, 'principals' | 'policy' | 'signIn' | 'agentKeys'>;
  /** The current time, as a bar time. */
  readonly now: () => BarTime;
  /** Mounts GET /live when given (M2-04). */
  readonly live?: Pick<LiveGateway, 'open'>;
  /** How often idle WebSockets are pinged; one that missed the last ping is closed. Default 30 s. */
  readonly pingMs?: number;
  /** The instruments and what is served, for GET /instruments and the MCP listing (M4-02): the data layer's. */
  readonly catalog?: Pick<DataAccess, 'instruments' | 'whyNotServed'>;
  /** Per-user rate limits (M2-10); none when left out. */
  readonly limits?: Limits;
  /** Request logging; `{ stream }` sends it to a stream (tests). Session tokens are masked either way. */
  readonly logger?: boolean | { readonly stream: NodeJS.WritableStream };
}

const error = (code: string, message: string) => ({ error: { code, message } });

/**
 * What a request presents. Browsers cannot set headers on a WebSocket, so
 * /live also takes `?token=`, passed on as a bearer token. The app's own
 * sign-in (M2-08) uses both: the header on REST, the query on /live.
 */
function credentials(request: FastifyRequest) {
  const token = (request.query as Record<string, unknown> | undefined)?.['token'];
  const authorization = request.headers.authorization ?? (typeof token === 'string' && token !== '' ? `Bearer ${token}` : undefined);
  return { authorization };
}

/** A URL with any `token=` value masked, so session tokens never reach the logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

function loggerOptions(logger: ServerDeps['logger']): FastifyLoggerOptions | false {
  if (logger === undefined || logger === false) return false;
  return {
    ...(logger === true ? {} : { stream: logger.stream }),
    // /live carries the session token in its query (browsers cannot set
    // WebSocket headers); the Authorization header is never logged by default.
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: redactUrl(request.url),
        hostname: request.hostname,
        remoteAddress: request.ip,
      }),
    },
  };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions(deps.logger) });
  await app.register(compress, { global: true });
  // Client messages are tiny (live-protocol.ts); anything larger is refused by ws itself.
  await app.register(websocket, { options: { maxPayload: LIVE_MAX_CLIENT_MESSAGE * 4 } });

  app.get('/health', () => ({ ok: true }));

  const limits = deps.limits;
  const reads = new ReadQueries({ history: deps.history, policy: deps.access.policy, now: deps.now, catalog: deps.catalog });
  if (deps.access.signIn !== undefined) mountAuthRoutes(app, deps.access.signIn, limits);
  if (deps.access.agentKeys !== undefined) mountAgentKeyRoutes(app, deps.access.agentKeys, deps.access.principals, limits);

  app.get('/bars', async (request, reply) => {
    // Every request carries a principal (CLAUDE.md rule 4), checked first.
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to read bars'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;

    const outcome = await reads.bars(principal, request.query as Record<string, unknown>);
    return outcome.ok ? outcome.value : reply.code(outcome.status).send({ error: outcome.error });
  });

  app.get('/plan', async (request, reply) => {
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to see your plan'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    const outcome = await reads.plan(principal);
    return outcome.ok ? outcome.value : reply.code(outcome.status).send({ error: outcome.error });
  });

  app.get('/instruments', async (request, reply) => {
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to list instruments'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    const outcome = await reads.instrumentsForChart(principal);
    return outcome.ok ? outcome.value : reply.code(outcome.status).send({ error: outcome.error });
  });

  mountMcpRoute(app, reads, deps.access.principals, limits);

  const live = deps.live;
  if (live !== undefined) {
    const principals = new WeakMap<FastifyRequest, Principal>();
    const pingMs = deps.pingMs ?? 30_000;
    app.get(
      '/live',
      {
        websocket: true,
        // Every connection carries a principal (CLAUDE.md rule 4), checked before the upgrade.
        preValidation: async (request, reply) => {
          const principal = await deps.access.principals.resolve(credentials(request));
          if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to follow live bars'));
          // A connection counts as one read; updates on it do not.
          if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
          principals.set(request, principal);
          return undefined;
        },
      },
      (socket, request) => {
        const principal = principals.get(request) as Principal;
        const session = live.open(
          {
            send: (text) => socket.send(text),
            bufferedBytes: () => socket.bufferedAmount,
            close: (code, reason) => socket.close(code, reason),
          },
          // Plan checks on every subscription.
          (symbol, timeframe) => deps.access.policy.canReadBars(principal, symbol, timeframe),
        );
        // A browser that vanished without closing is noticed within two pings.
        let alive = true;
        socket.on('pong', () => (alive = true));
        const ping = setInterval(() => {
          if (!alive) {
            socket.terminate();
            return;
          }
          alive = false;
          socket.ping();
        }, pingMs);
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            socket.close(1003, 'text messages only');
            return;
          }
          session.receive(String(data)).catch((failure: unknown) => {
            request.log.error(failure);
            socket.close(1011, 'something went wrong; reconnect');
          });
        });
        socket.on('close', () => {
          clearInterval(ping);
          session.close();
        });
      },
    );
  }

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(error('not_found', `no route ${request.method} ${request.url.split('?')[0] ?? ''}`)),
  );
  app.setErrorHandler((failure, request, reply) => {
    // Fastify's own refusals of a bad request (unreadable JSON, an oversized
    // or unsupported body) keep their 4xx status rather than becoming a 500.
    const status = (failure as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send(error('bad_request', 'the request body could not be read'));
    }
    request.log.error(failure);
    return reply.code(500).send(error('internal', 'something went wrong; try again'));
  });

  return app;
}
