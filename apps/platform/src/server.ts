// The platform's HTTP server (M2-03): routes mapped onto the contexts' use
// cases. No business rules here: parameters and the cap are HistoryQuery's
// and who follows what live is LiveGateway's (@aia/serving, over the data
// layer @aia/data, M1-16); who is asking and what they may see are the access
// context's.
//
//   GET /health
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000
//   GET /live   upgraded to a WebSocket; the protocol is in @aia/serving (live-protocol.ts)
//   GET /plan   what the caller's plan includes, and where to upgrade (M2-09)
//   /auth/*     the app's own sign-in (M2-08) and agent keys (M4-01), when configured;
//               see auth-routes.ts and agent-key-routes.ts
//
// Errors are `{ error: { code, message } }`. A plan refusal (403 forbidden)
// adds `upgradeUrl`. A refused live subscription is a `forbidden` message on
// the socket; the chart takes the upgrade link from GET /plan.

import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import type { Access, Principal } from '@aia/access';
import type { HistoryErrorCode, HistoryQuery, LiveGateway } from '@aia/serving';
import { LIVE_MAX_CLIENT_MESSAGE } from '@aia/serving';
import type { BarTime } from '@aia/shared-kernel';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyLoggerOptions, FastifyRequest } from 'fastify';

import { mountAgentKeyRoutes } from './agent-key-routes.js';
import { mountAuthRoutes } from './auth-routes.js';
import type { Limits } from './rate-limit.js';
import { refusedForRate } from './rate-limit.js';

export interface ServerDeps {
  readonly history: Pick<HistoryQuery, 'parse' | 'run'>;
  readonly access: Pick<Access, 'principals' | 'policy' | 'signIn' | 'agentKeys'>;
  /** The current time, as a bar time. */
  readonly now: () => BarTime;
  /** Mounts GET /live when given (M2-04). */
  readonly live?: Pick<LiveGateway, 'open'>;
  /** How often idle WebSockets are pinged; one that missed the last ping is closed. Default 30 s. */
  readonly pingMs?: number;
  /** Per-user rate limits (M2-10); none when left out. */
  readonly limits?: Limits;
  /** Request logging; `{ stream }` sends it to a stream (tests). Session tokens are masked either way. */
  readonly logger?: boolean | { readonly stream: NodeJS.WritableStream };
}

const STATUS: Readonly<Record<HistoryErrorCode, number>> = {
  bad_parameter: 400,
  limit_too_large: 400,
  unknown_instrument: 404,
  timeframe_not_served: 409,
};

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
  if (deps.access.signIn !== undefined) mountAuthRoutes(app, deps.access.signIn, limits);
  if (deps.access.agentKeys !== undefined) mountAgentKeyRoutes(app, deps.access.agentKeys, deps.access.principals, limits);

  app.get('/bars', async (request, reply) => {
    // Every request carries a principal (CLAUDE.md rule 4), checked first.
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to read bars'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;

    const parsed = deps.history.parse(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(STATUS[parsed.error.code]).send({ error: parsed.error });

    const { instrument, timeframe } = parsed.request;
    if (!(await deps.access.policy.canReadBars(principal, instrument.symbol, timeframe))) {
      const { upgradeUrl } = await deps.access.policy.entitlements(principal);
      const refusal = error('forbidden', `your plan does not include ${instrument.symbol} ${timeframe}`);
      return reply.code(403).send({ error: { ...refusal.error, ...(upgradeUrl === undefined ? {} : { upgradeUrl }) } });
    }
    return deps.history.run(parsed.request, deps.now());
  });

  app.get('/plan', async (request, reply) => {
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to see your plan'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    return deps.access.policy.entitlements(principal);
  });

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
