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
export type SealOutcome = 'sealed' | 'already-sealed' | 'empty';

export class LiveHourSealer {
  constructor(private readonly store: LiveHourStorePort) {}

  async seal(ref: RawDayRef, hour: number, known: readonly Bar[]): Promise<SealOutcome> {
    const stored = await this.store.liveMinuteTimes(ref, hour);
    if (stored.length === 0) return 'empty';
    const from = dayStart(ref.date) + hour * 3_600;
    const mine = known.filter((b) => b.time >= from && b.time < from + 3_600).sort((a, b) => a.time - b.time);
    const same = mine.length === stored.length && mine.every((b, i) => b.time === stored[i]);
    const bars = same ? mine : await this.store.getLiveMinutesOfHour(ref, hour);
    return (await this.store.putLiveHour(ref, hour, bars)) ? 'sealed' : 'already-sealed';
  }
}
