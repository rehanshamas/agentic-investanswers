// The app's own sign-in routes (M2-08; decision record T-01). No rules here:
// they are SignIn's (@aia/access). Mounted only when sign-in is configured
// (not in AIA_DEV_AUTH mode).
//
//   POST /auth/sign-up   { email, password }  201 { token, account } · 400 · 409
//   POST /auth/sign-in   { email, password }  200 { token, account } · 401
//   POST /auth/sign-out  Authorization: Bearer <token>  204
//   GET  /auth/me        Authorization: Bearer <token>  200 { id, email } · 401
//
// The token then goes on every request as `Authorization: Bearer <token>`,
// or as `?token=` on GET /live (browsers cannot set WebSocket headers).

import type { SignIn, SignUpError } from '@aia/access';
import type { FastifyInstance } from 'fastify';

const error = (code: string, message: string) => ({ error: { code, message } });

const SIGN_UP_STATUS: Readonly<Record<SignUpError, number>> = {
  invalid_email: 400,
  weak_password: 400,
  email_taken: 409,
};

/** Email and password from a JSON body, or undefined if either is missing or not text. */
function emailAndPassword(body: unknown): { email: string; password: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { email, password } = body as Record<string, unknown>;
  return typeof email === 'string' && typeof password === 'string' ? { email, password } : undefined;
}

const BAD_BODY = error('bad_request', 'send JSON with "email" and "password"');
/** Small bodies only: an email and a password. */
const bodyLimit = 4_096;

export function mountAuthRoutes(app: FastifyInstance, signIn: SignIn): void {
  app.post('/auth/sign-up', { bodyLimit }, async (request, reply) => {
    const fields = emailAndPassword(request.body);
    if (fields === undefined) return reply.code(400).send(BAD_BODY);
    const result = await signIn.signUp(fields.email, fields.password);
    if (!result.ok) return reply.code(SIGN_UP_STATUS[result.code]).send(error(result.code, result.message));
    return reply.code(201).send({ token: result.token, account: result.account });
  });

  app.post('/auth/sign-in', { bodyLimit }, async (request, reply) => {
    const fields = emailAndPassword(request.body);
    if (fields === undefined) return reply.code(400).send(BAD_BODY);
    const result = await signIn.signIn(fields.email, fields.password);
    if (!result.ok) return reply.code(401).send(error(result.code, result.message));
    return { token: result.token, account: result.account };
  });

  app.post('/auth/sign-out', async (request, reply) => {
    await signIn.signOut({ authorization: request.headers.authorization });
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const account = await signIn.account({ authorization: request.headers.authorization });
    if (account === undefined) return reply.code(401).send(error('unauthorized', 'sign in first'));
    return account;
  });
}
