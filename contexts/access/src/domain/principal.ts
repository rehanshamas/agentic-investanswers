// Principal: who is making a request (docs/glossary.md). Every request
// carries one, human or agent, and plan checks apply to both (CLAUDE.md rule 4).
// Pure.

export type PrincipalKind = 'human' | 'agent';

export interface Principal {
  readonly kind: PrincipalKind;
  /** Stable id: the account id for a human (M2-08), the agent's key id for an agent (M4-01). */
  readonly id: string;
  /** For an agent, the account it acts for: its plan applies (M4-01). */
  readonly owner?: string;
}

/**
 * Agents are read-only (M4-01): they may read bars and indicator outputs,
 * never change an account, its keys or anything else.
 */
export function mayWrite(principal: Principal): boolean {
  return principal.kind === 'human';
}
