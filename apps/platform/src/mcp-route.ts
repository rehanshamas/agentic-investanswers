// Read-only MCP tools for agents (M4-02) at POST /mcp, over Streamable HTTP
// (stateless: one MCP server per request, no session). The tools are the
// agent context's (@aia/agent); what they return comes from ReadQueries, the
// same reads, plan checks and rate limits as the REST routes.
//
// An agent sends its key as `Authorization: Bearer aia_agent_...`; a signed-in
// user's session token works too. Every request carries a principal.

import type { Principal, PrincipalResolverPort } from '@aia/access';
import type { AgentReadPort, ReadResult } from '@aia/agent';
import { createMcpServer } from '@aia/agent';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';

import type { Limits } from './rate-limit.js';
import { refusedForRate } from './rate-limit.js';
import type { ReadOutcome, ReadQueries } from './read-queries.js';

const error = (code: string, message: string) => ({ error: { code, message } });

function asResult<T>(outcome: ReadOutcome<T>): ReadResult<T> {
  return outcome.ok ? outcome : { ok: false, ...outcome.error };
}

/** The agent's reads, bound to its principal. */
function readsFor(queries: ReadQueries, principal: Principal): AgentReadPort {
  return {
    bars: async ({ instrument, tf, limit, before }) =>
      asResult(
        await queries.bars(principal, {
          instrument,
          tf,
          ...(limit === undefined ? {} : { limit: String(limit) }),
          ...(before === undefined ? {} : { before: String(before) }),
        }),
      ),
    instruments: async () => asResult(await queries.instruments(principal)),
    plan: async () => asResult(await queries.plan(principal)),
  };
}

export function mountMcpRoute(app: FastifyInstance, queries: ReadQueries, principals: PrincipalResolverPort, limits?: Limits): void {
  app.post('/mcp', { bodyLimit: 65_536 }, async (request, reply) => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'send an agent key as Authorization: Bearer <key>'));
    // One request is one message, so it counts as one read, as on the REST
    // routes. JSON-RPC batches (dropped from MCP in 2025-06) would let one
    // request carry many tool calls for the price of one, so they are refused.
    if (Array.isArray(request.body)) {
      return reply.code(400).send(error('batch_not_supported', 'send one JSON-RPC message per request'));
    }
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;

    const server = createMcpServer(readsFor(queries, principal));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no sessionIdGenerator: stateless
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  // Stateless: no server-initiated stream and no session to end.
  const notAllowed = (_request: unknown, reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } } }) =>
    reply.code(405).header('allow', 'POST').send(error('method_not_allowed', 'MCP here is stateless: POST only'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
