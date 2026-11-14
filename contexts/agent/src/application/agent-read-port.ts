// What an agent may read (M4-02), already scoped to the agent making the
// request: the platform implements it with the same queries, plan checks and
// rate limits as its REST routes, so the tools add no logic of their own
// (contexts/agent/AGENTS.md). Values are what the API returns: display
// units, drawn outputs only, never indicator internals (CLAUDE.md rule 5).

export type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly upgradeUrl?: string };

export interface BarsArgs {
  readonly instrument: string;
  readonly tf: string;
  readonly limit?: number | undefined;
  readonly before?: number | undefined;
}

export interface AgentReadPort {
  /** One page of bars, newest last, as GET /bars returns it. */
  bars(args: BarsArgs): Promise<ReadResult<unknown>>;
  /** The instruments, the timeframes served for each, and which the caller's plan includes. */
  instruments(): Promise<ReadResult<unknown>>;
  /** What the caller's plan includes, as GET /plan returns it. */
  plan(): Promise<ReadResult<unknown>>;
}
