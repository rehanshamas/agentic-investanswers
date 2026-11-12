// The live bars bus in one process, for tests and the load test (M2-04).
// Delivers synchronously, in publish order.

import type { LiveBarsBusPort, LiveBarsListener } from '../application/live-bars-bus-port.js';
import type { LiveBatch } from '../domain/live-update.js';

export class MemoryLiveBarsBus implements LiveBarsBusPort {
  private readonly listeners = new Set<LiveBarsListener>();

  publish(batch: LiveBatch): Promise<void> {
    for (const listener of this.listeners) listener.batch(batch);
    return Promise.resolve();
  }

  subscribe(listener: LiveBarsListener): Promise<void> {
    this.listeners.add(listener);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }
}
