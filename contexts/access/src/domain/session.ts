// Sessions for the app's own sign-in (M2-08). Pure.
//
// A session token is a long random string the client holds and sends as
// `Authorization: Bearer <token>` (or `?token=` on the WebSocket). The store
// keeps only a hash of it, so a leaked table cannot be replayed as sessions.

export interface Session {
  /** Hash of the token the client holds. */
  readonly tokenHash: string;
  readonly accountId: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Sessions last 30 days, then the user signs in again. */
export const SESSION_LIFETIME_MS = 30 * 86_400_000;

export function newSession(tokenHash: string, accountId: string, now: number): Session {
  return { tokenHash, accountId, createdAt: now, expiresAt: now + SESSION_LIFETIME_MS };
}

export function isLive(session: Session, now: number): boolean {
  return now < session.expiresAt;
}

/** The token from an `Authorization` header, if it is a bearer token. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match?.[1];
}
