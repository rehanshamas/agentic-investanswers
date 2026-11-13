// Accounts for the app's own sign-in (M2-08; decision record T-01). Pure.
//
// Temporary until InvestAnswers sign-in arrives (OI-21): it then replaces the
// principal resolver, and nothing else changes.

export interface Account {
  /** Stable id; the human principal's id. */
  readonly id: string;
  /** Lower-cased and trimmed, so one person cannot sign up twice by case. */
  readonly email: string;
  /** Produced by a PasswordHasherPort; never the password itself. */
  readonly passwordHash: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** What a client may see about an account. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
}

export const PASSWORD_MIN_LENGTH = 10;
/** Long enough for any passphrase; short enough that hashing cannot be used to tie up the server. */
export const PASSWORD_MAX_LENGTH = 200;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately loose: one @, something either side, a dot in the domain, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

/** Why a password is refused, in words for the user, or undefined if it is acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters`;
  if (password.trim() === '') return 'The password cannot be only spaces';
  return undefined;
}

export function accountView(account: Account): AccountView {
  return { id: account.id, email: account.email };
}
