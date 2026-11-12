// How live bar updates travel from the hydration process to the platform
// process (M2-04): Redis pub/sub in staging and locally, memory in tests.
// A transport only: sequencing is LiveAnnouncer's, gap handling the gateway's.

import type { LiveBatch } from '../domain/live-update.js';

export interface LiveBarsListener {
  /** Announcements, in the order they were published. */
  batch(batch: LiveBatch): void;
  /** Announcements may have been missed (for example, the connection dropped). */
  lost(reason: string): void;
}

export interface LiveBarsBusPort {
  /** Rejects if the announcement could not be sent. */
  publish(batch: LiveBatch): Promise<void>;
  subscribe(listener: LiveBarsListener): Promise<void>;
  close(): Promise<void>;
}

export class LiveBarsBusError extends Error {}
