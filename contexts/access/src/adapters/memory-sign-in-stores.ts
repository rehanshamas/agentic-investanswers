// In-memory account and session stores, for tests and local runs without
// DynamoDB. Everything is lost on restart.

import type { AccountStorePort, SessionStorePort } from '../application/sign-in-ports.js';
import type { Account } from '../domain/account.js';
import type { Session } from '../domain/session.js';

export class MemoryAccountStore implements AccountStorePort {
  private readonly byId = new Map<string, Account>();
  private readonly idByEmail = new Map<string, string>();

  create(account: Account): Promise<'created' | 'email_taken'> {
    if (this.idByEmail.has(account.email)) return Promise.resolve('email_taken');
    this.byId.set(account.id, account);
    this.idByEmail.set(account.email, account.id);
    return Promise.resolve('created');
  }

  findByEmail(email: string): Promise<Account | undefined> {
    const id = this.idByEmail.get(email);
    return Promise.resolve(id === undefined ? undefined : this.byId.get(id));
  }

  findById(id: string): Promise<Account | undefined> {
    return Promise.resolve(this.byId.get(id));
  }
}

export class MemorySessionStore implements SessionStorePort {
  private readonly sessions = new Map<string, Session>();

  put(session: Session): Promise<void> {
    this.sessions.set(session.tokenHash, session);
    return Promise.resolve();
  }

  get(tokenHash: string): Promise<Session | undefined> {
    return Promise.resolve(this.sessions.get(tokenHash));
  }

  delete(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
    return Promise.resolve();
  }

  get size(): number {
    return this.sessions.size;
  }
}
