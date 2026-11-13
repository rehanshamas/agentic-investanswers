// Cooked watermarks in memory, for tests.

import type { BarTime } from '@aia/shared-kernel';

import type { CookedWatermarkPort } from '../application/cooked-watermark-port.js';

export class MemoryCookedWatermarks implements CookedWatermarkPort {
  private readonly marks = new Map<string, BarTime>();

  getWatermark(symbol: string): Promise<BarTime | undefined> {
    return Promise.resolve(this.marks.get(symbol));
  }

  setWatermark(symbol: string, through: BarTime): Promise<void> {
    this.marks.set(symbol, through);
    return Promise.resolve();
  }
}
