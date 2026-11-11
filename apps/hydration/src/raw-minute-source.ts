// Wire hydration's raw store into market-data's OneMinuteBarSourcePort.
//
// market-data declares the port so it never depends on hydration, and this
// app connects the two (CLAUDE.md rule 1: apps/ only wire things together).
// The parity harness reads 1m through it; M1-10's rebuild check can too.
//
// A settled day file always wins. A day without one (today, or a day not yet
// backfilled) is read from the live stream's minutes (M1-05), so cooked stays
// rebuildable from raw alone, live minutes included.

import type { LiveRawStorePort, RawBarStorePort } from '@aia/hydration';
import type { OneMinuteBarSourcePort } from '@aia/market-data';
import type { Bar, BarTime } from '@aia/shared-kernel';
import { addDays, zonedDateKey } from '@aia/shared-kernel';

/**
 * Which provider's raw files hold an instrument's 1-minute bars on a UTC day,
 * or `undefined` if no provider serves that day. Per day, because the feed
 * plan can switch provider (CLAUDE.md rule 7) and older days stay where they
 * were stored.
 */
export type ProviderOf = (symbol: string, date: string) => string | undefined;

export class RawMinuteSource implements OneMinuteBarSourcePort {
  constructor(
    private readonly raw: Pick<RawBarStorePort, 'getDay'> & Partial<Pick<LiveRawStorePort, 'getLiveMinutes'>>,
    private readonly providerOf: ProviderOf,
    /** Which provider's live minutes stand in for a day with no day file. */
    private readonly liveProviderOf?: ProviderOf,
  ) {}

  /**
   * One GET per UTC day in the range; a day with neither a day file nor live
   * minutes, or served by no provider, is a gap.
   */
  async read(symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    if (until < from) return [];
    const last = zonedDateKey(until, 'UTC');
    const bars: Bar[] = [];
    for (let date = zonedDateKey(from, 'UTC'); date <= last; date = addDays(date, 1)) {
      const provider = this.providerOf(symbol, date);
      const day = (provider === undefined ? undefined : await this.raw.getDay({ provider, symbol, date })) ??
        (await this.liveMinutes(symbol, date));
      if (day === undefined) continue;
      for (const bar of day) {
        if (bar.time >= from && bar.time <= until) bars.push(bar);
      }
    }
    return bars;
  }

  private async liveMinutes(symbol: string, date: string): Promise<Bar[] | undefined> {
    const provider = this.liveProviderOf?.(symbol, date);
    if (provider === undefined || this.raw.getLiveMinutes === undefined) return undefined;
    return this.raw.getLiveMinutes({ provider, symbol, date });
  }
}
