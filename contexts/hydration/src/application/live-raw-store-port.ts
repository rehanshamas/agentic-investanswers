// Live minutes in the raw store (M1-05).
//
// A raw day is written once, after it has settled, so today cannot go into
// it. Instead each closed live minute is its own write-once object beside the
// day, and each disconnect window is a write-once gap record. Once the
// settled day file exists, it is what readers use: live minutes are a stand-in
// for days not yet backfilled, superseded but never edited or deleted.

import type { Bar } from '@aia/shared-kernel';

import type { LiveGap } from '../domain/live-minutes.js';
import type { RawDayRef } from './raw-bar-store-port.js';
import { RawStoreError } from './raw-bar-store-port.js';

/** Raised when a live minute is already stored. Raw is write-once. */
export class LiveMinuteAlreadyStoredError extends RawStoreError {}

export interface LiveRawStorePort {
  /** Store one closed minute, once. Throws `LiveMinuteAlreadyStoredError` if it exists. */
  putLiveMinute(ref: RawDayRef, bar: Bar): Promise<void>;
  /** Every live minute stored for the day, ascending; `[]` if none. */
  getLiveMinutes(ref: RawDayRef): Promise<Bar[]>;
  /** Record minutes the live stream missed, within one UTC day. Write-once. */
  putLiveGap(ref: RawDayRef, gap: LiveGap): Promise<void>;
  /** Every gap recorded for the day, ascending. */
  getLiveGaps(ref: RawDayRef): Promise<LiveGap[]>;
}
