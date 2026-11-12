// Principal: who is making a request (docs/glossary.md). Every request
// carries one, human or agent, and plan checks apply to both (CLAUDE.md rule 4).
// Pure.

export type PrincipalKind = 'human' | 'agent';

export interface Principal {
  readonly kind: PrincipalKind;
  /** Stable id: the InvestAnswers user id for a human (M2-08), the agent's key id for an agent (M4-01). */
  readonly id: string;
}
