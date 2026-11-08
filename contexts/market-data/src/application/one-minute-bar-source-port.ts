// Where the 1-minute bars to cook from come from.
//
// docs/architecture.md says cooked bars are "built only from raw 1-minute
// bars", and CLAUDE.md rule 3 says cooked must always be rebuildable from raw
// — but the raw store belongs to `contexts/hydration`, and cooking belongs
// here. Rather than importing that context, this context declares the shape of
// what it needs and the app wires hydration's raw store into it
// (CLAUDE.md rule 1: `apps/` only wire things together).
//
// Two things fall out of that. M1-10's rebuild check can point the same port
// at raw to prove a re-cook, and these rollups can be tested against an
// in-memory source with no S3 at all.

import type { Bar, BarTime } from '@aia/shared-kernel';

export interface OneMinuteBarSourcePort {
  /**
   * Every stored 1-minute bar in `[from, until]`, inclusive, ascending.
   *
   * Gaps are normal and are not an error: a minute with no trades has no bar
   * (`docs/bar-rules.md`), and a backfill may not have reached a range yet.
   */
  read(symbol: string, from: BarTime, until: BarTime): Promise<Bar[]>;
}
