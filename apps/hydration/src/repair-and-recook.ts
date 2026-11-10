// Gap repair, then re-cooking the months it changed (M1-09). Composition only:
// GapRepair lives in @aia/hydration and CookIntraday in @aia/market-data; this
// connects them, since neither context may depend on the other for this.

import type { GapRange, GapRepairDeps, GapReport } from '@aia/hydration';
import { GapRepair } from '@aia/hydration';
import type { CookedBarStorePort, OneMinuteBarSourcePort } from '@aia/market-data';
import { CookIntraday } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';

export interface RepairAndRecookDeps extends GapRepairDeps {
  /** The raw store seen as market-data's 1m source, for re-cooking. */
  readonly minutes: OneMinuteBarSourcePort;
  readonly cooked: CookedBarStorePort;
}

export interface RepairAndRecookResult {
  readonly report: GapReport;
  /** Months re-cooked; empty for stocks until M1-08 cooks them. */
  readonly recooked: readonly string[];
}

export async function repairAndRecook(
  deps: RepairAndRecookDeps,
  instrument: Instrument,
  range: GapRange,
): Promise<RepairAndRecookResult> {
  const report = await new GapRepair(deps).run(instrument, range);
  // Raw stock bars keep Massive's precision; cooking stocks is M1-08.
  if (deps.dryRun === true || instrument.kind === 'stock') return { report, recooked: [] };
  const cook = new CookIntraday({ source: deps.minutes, store: deps.cooked, calendar: deps.calendar });
  for (const month of report.monthsTouched) await cook.cookPartition(instrument, month);
  return { report, recooked: report.monthsTouched };
}
