// The platform's HTTP server (M2-03): routes mapped onto the contexts' use
// cases. No business rules here: parameters, the cap and what is served are
// HistoryQuery's (@aia/market-data); who is asking and what they may see are
// the access context's; who follows what live is LiveGateway's (M2-04).
//
//   GET /health
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000
//   GET /live   upgraded to a WebSocket; the protocol is in @aia/market-data (live-protocol.ts)
//
// Errors are `{ error: { code, message } }`.

import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import type { Access, Principal } from '@aia/access';
import type { HistoryErrorCode, HistoryQuery, LiveGateway } from '@aia/market-data';
import { LIVE_MAX_CLIENT_MESSAGE } from '@aia/market-data';
import type { BarTime } from '@aia/shared-kernel';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface ServerDeps {
  readonly history: Pick<HistoryQuery, 'parse' | 'run'>;
  readonly access: Pick<Access, 'principals' | 'policy'>;
  /** The current time, as a bar time. */
  readonly now: () => BarTime;
  /** Mounts GET /live when given (M2-04). */
  readonly live?: Pick<LiveGateway, 'open'>;
  /** How often idle WebSockets are pinged; one that missed the last ping is closed. Default 30 s. */
  readonly pingMs?: number;
  readonly logger?: boolean;
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
 * /live also takes `?token=`, passed on as a bearer token; M2-08 decides
 * which form real sign-in uses.
 */
function credentials(request: FastifyRequest) {
  const token = (request.query as Record<string, unknown> | undefined)?.['token'];
  const authorization = request.headers.authorization ?? (typeof token === 'string' && token !== '' ? `Bearer ${token}` : undefined);
  return { authorization };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(compress, { global: true });
  // Client messages are tiny (live-protocol.ts); anything larger is refused by ws itself.
  await app.register(websocket, { options: { maxPayload: LIVE_MAX_CLIENT_MESSAGE * 4 } });

  app.get('/health', () => ({ ok: true }));

  app.get('/bars', async (request, reply) => {
    // Every request carries a principal (CLAUDE.md rule 4), checked first.
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to read bars'));

    const parsed = deps.history.parse(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(STATUS[parsed.error.code]).send({ error: parsed.error });

    const { instrument, timeframe } = parsed.request;
    if (!(await deps.access.policy.canReadBars(principal, instrument.symbol, timeframe))) {
      return reply.code(403).send(error('forbidden', `your plan does not include ${instrument.symbol} ${timeframe}`));
    }
    return deps.history.run(parsed.request, deps.now());
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
    request.log.error(failure);
    return reply.code(500).send(error('internal', 'something went wrong; try again'));
  });

  return app;
}
