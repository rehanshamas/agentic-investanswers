// Agent keys (M4-01; decision record F-04): our own read-only keys that let a
// user's agent read what the user's plan includes. A signed-in user creates
// one, sees it once, and can revoke it. Only a hash of the key is stored, as
// with session tokens. InvestAnswers-issued agent tokens (OI-25), if they
// come, plug in behind the same principal resolver. Pure.

/** Every agent key starts with this, so it is never mistaken for a session token, and is easy to spot if leaked. */
export const AGENT_KEY_PREFIX = 'aia_agent_';

/** At most this many live keys per account. */
export const MAX_AGENT_KEYS = 10;

export const AGENT_KEY_NAME_MAX = 64;

/** What an agent key may do. Only reading exists for the MVP. */
export type AgentScope = 'read';

export interface AgentKey {
  /** The agent principal's id. */
  readonly id: string;
  /** The account the agent acts for. */
  readonly accountId: string;
  /** The user's label for it, for example "my research agent". */
  readonly name: string;
  readonly scope: AgentScope;
  /** Hash of the key the agent holds. */
  readonly keyHash: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** What the user sees of a key after creating it: never the key or its hash. */
export interface AgentKeyView {
  readonly id: string;
  readonly name: string;
  readonly scope: AgentScope;
  readonly createdAt: number;
}

export function agentKeyView(key: AgentKey): AgentKeyView {
  return { id: key.id, name: key.name, scope: key.scope, createdAt: key.createdAt };
}

export function isAgentKey(token: string): boolean {
  return token.startsWith(AGENT_KEY_PREFIX);
}

/** Why a key name is refused, or undefined if it is fine. */
export function agentKeyNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Give the key a name, so you can tell your keys apart';
  if (trimmed.length > AGENT_KEY_NAME_MAX) return `Key names are at most ${AGENT_KEY_NAME_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'Key names cannot contain control characters';
  return undefined;
}
