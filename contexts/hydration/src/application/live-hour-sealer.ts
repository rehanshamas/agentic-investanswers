// Sealing an ended hour of live minutes into one hour file (M1-15b).
//
// The live process already holds the minutes it stored, so it writes the hour
// file from those, after one LIST confirms they are exactly the minute objects
// stored for that hour (a minute is added to what it holds only once its write
// succeeded, so equal times mean equal minutes). If they differ (another run
// stored some of the hour, or a write went missing), it reads the stored
// objects instead. Either way the hour file holds what raw holds.

import type { Bar } from '@aia/shared-kernel';
import { dayStart } from '../domain/raw-day.js';
import type { LiveHourStorePort } from './live-hour-store-port.js';
import type { RawDayRef } from './raw-bar-store-port.js';

/** `empty`: no minute was stored in that hour, so there is nothing to seal. */
/** Per hour asked about. `empty`: no minute was stored in it, so there is nothing to seal. */
export type SealOutcome = 'sealed' | 'already-sealed' | 'empty';

export class LiveHourSealer {
  constructor(private readonly store: LiveHourStorePort) {}

  /** Seal the given ended hours of one day, from one index of what is stored. */
  async seal(ref: RawDayRef, hours: readonly number[], known: readonly Bar[]): Promise<Map<number, SealOutcome>> {
    const { minuteTimes, sealedHours } = await this.store.liveDayIndex(ref);
    const start = dayStart(ref.date);
    const outcomes = new Map<number, SealOutcome>();
    await Promise.all(
      hours.map(async (hour) => {
        if (sealedHours.has(hour)) return outcomes.set(hour, 'already-sealed');
        const from = start + hour * 3_600;
        const inHour = (t: number) => t >= from && t < from + 3_600;
        const stored = minuteTimes.filter(inHour);
        if (stored.length === 0) return outcomes.set(hour, 'empty');
        const mine = known.filter((b) => inHour(b.time)).sort((a, b) => a.time - b.time);
        const same = mine.length === stored.length && mine.every((b, i) => b.time === stored[i]);
        const bars = same ? mine : await this.store.getLiveMinutesOfHour(ref, hour);
        return outcomes.set(hour, (await this.store.putLiveHour(ref, hour, bars)) ? 'sealed' : 'already-sealed');
      }),
    );
    return outcomes;
  }
}
