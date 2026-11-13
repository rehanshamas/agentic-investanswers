// The 429 reply for a request over its rate limit (M2-10). The limits and the
// counting are the access context's (RateLimiter).

import type { RateDecision, RateLimiter } from '@aia/access';
import type { FastifyReply } from 'fastify';

export type Limits = Pick<RateLimiter, 'check' | 'checkReads'>;

/** Sends 429 with Retry-After and returns true when the decision refuses; otherwise false. */
export async function refusedForRate(reply: FastifyReply, decision: RateDecision): Promise<boolean> {
  if (decision.ok) return false;
  await reply
    .code(429)
    .header('retry-after', String(decision.retryAfterSeconds))
    .send({
      error: {
        code: 'rate_limited',
        message: `too many requests: at most ${decision.limit} in this period; try again in ${decision.retryAfterSeconds} s`,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    });
  return true;
}
