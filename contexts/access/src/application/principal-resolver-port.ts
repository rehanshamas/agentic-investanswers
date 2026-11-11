// Who is asking, from what a request presents. Real sign-in (InvestAnswers
// token validation) arrives with M2-08 and agent keys with M4-01; both plug in
// here, so no route changes when they do.

import type { Principal } from '../domain/principal.js';

/** What a request presents, already pulled out of the transport (HTTP header, WebSocket handshake). */
export interface RequestCredentials {
  /** The `Authorization` header, if any. */
  readonly authorization?: string | undefined;
}

export interface PrincipalResolverPort {
  /** The principal, or `undefined` if the request presents none that is valid. */
  resolve(credentials: RequestCredentials): Promise<Principal | undefined>;
}
