// Agent keys (M4-01; decision record F-04). No rules here: they are
// AgentKeys' (@aia/access). Only a signed-in human manages keys; an agent's
// own key is read-only, so it is refused here (403 read_only).
//
//   POST   /auth/agent-keys       { name }  201 { key, agentKey } · 400 · 409 (too many)
//   GET    /auth/agent-keys                 200 [agentKey, ...]
//   DELETE /auth/agent-keys/:id             204 · 404
//
// The agent then sends the key like a session token: `Authorization: Bearer
// <key>` on REST, `?token=<key>` on GET /live, and reads on its owner's plan.

import type { AgentKeys, Principal, PrincipalResolverPort } from '@aia/access';
import { mayWrite } from '@aia/access';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyInstance } from 'fastify';

const error = (code: string, message: string) => ({ error: { code, message } });

const bodyLimit = 4_096;

export function mountAgentKeyRoutes(app: FastifyInstance, agentKeys: AgentKeys, principals: PrincipalResolverPort): void {
  /** The signed-in human, or a reply already sent. */
  const human = async (request: FastifyRequest, reply: FastifyReply): Promise<Principal | undefined> => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) {
      await reply.code(401).send(error('unauthorized', 'sign in to manage agent keys'));
      return undefined;
    }
    if (!mayWrite(principal)) {
      await reply.code(403).send(error('read_only', 'agent keys are read-only; sign in as the user to manage keys'));
      return undefined;
    }
    return principal;
  };

  app.post('/auth/agent-keys', { bodyLimit }, async (request, reply) => {
    const principal = await human(request, reply);
    if (principal === undefined) return reply;
    const name = (request.body as Record<string, unknown> | null | undefined)?.['name'];
    if (typeof name !== 'string') return reply.code(400).send(error('bad_request', 'send JSON with a "name" for the key'));
    const result = await agentKeys.create(principal.id, name);
    if (!result.ok) return reply.code(result.code === 'too_many_keys' ? 409 : 400).send(error(result.code, result.message));
    return reply.code(201).send({ key: result.key, agentKey: result.agentKey });
  });

  app.get('/auth/agent-keys', async (request, reply) => {
    const principal = await human(request, reply);
    if (principal === undefined) return reply;
    return agentKeys.list(principal.id);
  });

  app.delete<{ Params: { id: string } }>('/auth/agent-keys/:id', async (request, reply) => {
    const principal = await human(request, reply);
    if (principal === undefined) return reply;
    if ((await agentKeys.revoke(principal.id, request.params.id)) === 'not_found') {
      return reply.code(404).send(error('not_found', 'no agent key with that id on your account'));
    }
    return reply.code(204).send();
  });
}
