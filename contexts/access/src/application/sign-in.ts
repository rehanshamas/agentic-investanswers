// The app's own sign-up, sign-in and sign-out (M2-08; decision record T-01),
// and the principal resolver built on it. Time is passed in.
//
// Built behind PrincipalResolverPort, so InvestAnswers sign-in can replace it
// later with no route changes.

import type { AccountView } from '../domain/account.js';
import { accountView, isValidEmail, normaliseEmail, passwordProblem } from '../domain/account.js';
import type { Principal } from '../domain/principal.js';
import { bearerToken, isLive, newSession } from '../domain/session.js';
import type { PrincipalResolverPort, RequestCredentials } from './principal-resolver-port.js';
import type { AccountStorePort, PasswordHasherPort, SessionStorePort, TokenPort } from './sign-in-ports.js';

export interface SignInDeps {
  readonly accounts: AccountStorePort;
  readonly sessions: SessionStorePort;
  readonly hasher: PasswordHasherPort;
  readonly tokens: TokenPort;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

export type SignUpError = 'invalid_email' | 'weak_password' | 'email_taken';

export type SignUpResult =
  | { readonly ok: true; readonly token: string; readonly account: AccountView }
  | { readonly ok: false; readonly code: SignUpError; readonly message: string };

export type SignInResult =
  | { readonly ok: true; readonly token: string; readonly account: AccountView }
  | { readonly ok: false; readonly code: 'invalid_credentials'; readonly message: string };

const INVALID_CREDENTIALS = 'Email or password is wrong';

export class SignIn implements PrincipalResolverPort {
  /** Hashed once, so a sign-in for an unknown email costs as much as a real one. */
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly deps: SignInDeps) {}

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const normalised = normaliseEmail(email);
    if (!isValidEmail(normalised)) return { ok: false, code: 'invalid_email', message: 'Enter a valid email address' };
    const problem = passwordProblem(password);
    if (problem !== undefined) return { ok: false, code: 'weak_password', message: problem };

    const account = {
      id: this.deps.tokens.newId(),
      email: normalised,
      passwordHash: await this.deps.hasher.hash(password),
      createdAt: this.deps.now(),
    };
    if ((await this.deps.accounts.create(account)) === 'email_taken') {
      return { ok: false, code: 'email_taken', message: 'An account with this email already exists; sign in instead' };
    }
    return { ok: true, token: await this.startSession(account.id), account: accountView(account) };
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    const account = await this.deps.accounts.findByEmail(normaliseEmail(email));
    if (account === undefined) {
      // Same work as a real check, so response time does not reveal which emails exist.
      this.dummyHash ??= this.deps.hasher.hash('not-a-real-password-0000');
      await this.deps.hasher.verify(password, await this.dummyHash);
      return { ok: false, code: 'invalid_credentials', message: INVALID_CREDENTIALS };
    }
    if (!(await this.deps.hasher.verify(password, account.passwordHash))) {
      return { ok: false, code: 'invalid_credentials', message: INVALID_CREDENTIALS };
    }
    return { ok: true, token: await this.startSession(account.id), account: accountView(account) };
  }

  /** Ends the session the credentials carry; nothing happens if there is none. */
  async signOut(credentials: RequestCredentials): Promise<void> {
    const token = bearerToken(credentials.authorization);
    if (token !== undefined) await this.deps.sessions.delete(this.deps.tokens.hashToken(token));
  }

  /** The signed-in account, or undefined. */
  async account(credentials: RequestCredentials): Promise<AccountView | undefined> {
    const accountId = await this.liveAccountId(credentials);
    if (accountId === undefined) return undefined;
    const account = await this.deps.accounts.findById(accountId);
    return account === undefined ? undefined : accountView(account);
  }

  /** PrincipalResolverPort: a live session's account is a human principal. */
  async resolve(credentials: RequestCredentials): Promise<Principal | undefined> {
    const accountId = await this.liveAccountId(credentials);
    return accountId === undefined ? undefined : { kind: 'human', id: accountId };
  }

  private async liveAccountId(credentials: RequestCredentials): Promise<string | undefined> {
    const token = bearerToken(credentials.authorization);
    if (token === undefined) return undefined;
    const tokenHash = this.deps.tokens.hashToken(token);
    const session = await this.deps.sessions.get(tokenHash);
    if (session === undefined) return undefined;
    if (!isLive(session, this.deps.now())) {
      await this.deps.sessions.delete(tokenHash);
      return undefined;
    }
    return session.accountId;
  }

  private async startSession(accountId: string): Promise<string> {
    const token = this.deps.tokens.newToken();
    await this.deps.sessions.put(newSession(this.deps.tokens.hashToken(token), accountId, this.deps.now()));
    return token;
  }
}
