// Ports for the app's own sign-in (M2-08). Adapters: memory (tests, local
// runs) and DynamoDB (user data, docs/architecture.md); scrypt and node:crypto
// for hashing and tokens.

import type { Account } from '../domain/account.js';
import type { Session } from '../domain/session.js';

export interface AccountStorePort {
  /** Store a new account; 'email_taken' if one with that email exists (checked atomically). */
  create(account: Account): Promise<'created' | 'email_taken'>;
  findByEmail(email: string): Promise<Account | undefined>;
  findById(id: string): Promise<Account | undefined>;
}

export interface SessionStorePort {
  put(session: Session): Promise<void>;
  get(tokenHash: string): Promise<Session | undefined>;
  delete(tokenHash: string): Promise<void>;
}

export interface PasswordHasherPort {
  hash(password: string): Promise<string>;
  /** Constant-time comparison. */
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenPort {
  /** A new session token: long, random, safe in a URL. */
  newToken(): string;
  /** The hash stored for a token. */
  hashToken(token: string): string;
  /** A new account id. */
  newId(): string;
}
