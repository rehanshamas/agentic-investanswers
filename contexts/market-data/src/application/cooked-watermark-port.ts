// How far each instrument's cooked store is settled (M1-15): every bar built
// from minutes before the watermark is stored. Readers roll up the rest from
// raw (CookedReader); the compactor moves it forward a day at a time.

import type { BarTime } from '@aia/shared-kernel';

export interface CookedWatermarkPort {
  /** `undefined` until the compactor first ran for the instrument. */
  getWatermark(symbol: string): Promise<BarTime | undefined>;
  setWatermark(symbol: string, through: BarTime): Promise<void>;
}
