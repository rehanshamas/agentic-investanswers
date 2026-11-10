// Where a backfill's 1-minute history comes from.
//
// One provider per raw store prefix: `name` is the `provider` part of every
// raw key it writes (`raw/<provider>/<symbol>/...`), so bars from two sources
// can never mix in one file.

import type { Bar, Instrument } from '@aia/shared-kernel';

export interface HistoryProviderPort {
  /** For example `coinbase`. Used as the raw store's provider key. */
  readonly name: string;

  /**
   * Every 1-minute bar the provider has for one UTC day, ascending.
   *
   * A minute with no trades has no bar (docs/bar-rules.md), so fewer than
   * 1,440 is normal. Throws if the day cannot be fetched completely: a
   * partial day must never reach the write-once raw store.
   */
  fetchDay(instrument: Instrument, date: string): Promise<Bar[]>;

  /**
   * Optional: several UTC days in one request, for providers whose rate limit
   * makes one request per day too slow (Massive: about 5 a minute). Returns
   * each requested date's bars, ascending; a date with no bars maps to `[]`.
   * Throws if any of them cannot be fetched completely, failing them all.
   */
  fetchDays?(instrument: Instrument, dates: readonly string[]): Promise<Map<string, Bar[]>>;

  /** How many dates `fetchDays` takes at once. */
  readonly daysPerRequest?: number;
}
