// Turn a provider's JSON number into a scaled whole number, refusing precision
// the scale cannot hold. Shared by the provider adapters.

import { parseScaled } from '@aia/shared-kernel';

/**
 * Largest excess beyond the scale treated as float noise, relative to the
 * value. A float64 holds about 16 significant digits, so noise is near 1e-16
 * of the value; 1e-12 leaves room for that while still catching a real ninth
 * decimal on a volume near 1, which an absolute 1e-9 would let through. Raw is
 * write-once, so anything bigger throws rather than being rounded in.
 */
const RELATIVE_NOISE = 1e-12;

export function scaledNumber(
  value: unknown,
  scale: number,
  what: string,
  fail: (message: string) => Error,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fail(`${what} is not a number: ${JSON.stringify(value)}`);
  }
  const rounded = value.toFixed(scale);
  if (Math.abs(value - Number(rounded)) > Math.max(Math.abs(value), 1) * RELATIVE_NOISE) {
    throw fail(
      `${what} ${value} needs more than ${scale} decimal places; fix the instrument scale ` +
        `rather than rounding it into raw`,
    );
  }
  return parseScaled(rounded, scale);
}
