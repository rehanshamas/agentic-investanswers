// Hour files for live minutes (M1-15b).
//
// A closed live minute is its own write-once object, so reading a whole day
// of them is up to 1,440 GETs. Once an hour has ended, its minutes are also
// written as one write-once hour file beside them; readers then take the hour
// file instead of that hour's minute objects. Nothing is edited or deleted:
// the minute objects stay, and the settled day file still supersedes both.
//
// A separate port from LiveRawStorePort, so the live stream, which only puts
// and gets minutes, does not depend on it.

import type { Bar, BarTime } from '@aia/shared-kernel';

import type { RawDayRef } from './raw-bar-store-port.js';

export interface LiveHourStorePort {
  /** The times of the live minute objects stored for one hour (0 to 23) of the day, ascending. One LIST. */
  liveMinuteTimes(ref: RawDayRef, hour: number): Promise<BarTime[]>;
  /** The live minute objects of one hour, read one by one. */
  getLiveMinutesOfHour(ref: RawDayRef, hour: number): Promise<Bar[]>;
  /** Write the hour file once. `false` if it already exists. */
  putLiveHour(ref: RawDayRef, hour: number, bars: readonly Bar[]): Promise<boolean>;
}
