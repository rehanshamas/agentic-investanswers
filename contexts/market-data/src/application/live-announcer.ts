// Announcing live bar updates from the hydration process (M2-04). Each
// announcement carries the next sequence number, so listeners can tell when
// one went missing. A failed announcement still uses up its number, so the
// next one shows the hole and listeners resync.

import type { LiveBarUpdate } from '../domain/live-update.js';
import type { LiveBarsBusPort } from './live-bars-bus-port.js';

export class LiveAnnouncer {
  private seq = 0;

  constructor(
    private readonly bus: Pick<LiveBarsBusPort, 'publish'>,
    /** Unique per process run, so a restart is seen as a break in the sequence. */
    readonly publisher: string,
  ) {}

  /** Calls are announced in the order made. */
  publish(updates: readonly LiveBarUpdate[]): Promise<void> {
    if (updates.length === 0) return Promise.resolve();
    return this.bus.publish({ publisher: this.publisher, seq: ++this.seq, updates });
  }

  /** Tell listeners charts may differ from the store and must reload. */
  resync(): Promise<void> {
    return this.bus.publish({ publisher: this.publisher, seq: ++this.seq, updates: [], resync: true });
  }
}
