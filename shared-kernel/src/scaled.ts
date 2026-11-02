// Prices and volumes as scaled whole numbers, so parity can be exact.
//
// docs/bar-rules.md, "Comparing against the exports": parity has no tolerance.
// Prices are copied from 1-minute bars, so they match exactly. Volume is
// *summed* over up to a month of minutes, and adding decimal floats drifts
// (0.1 + 0.2 is 0.30000000000000004). Summing whole units instead is exact,
// which is what lets the comparison stay exact rather than needing a margin.
//
// A scale is a number of decimal places: price scale 2 means cents, volume
// scale 8 means hundred-millionths of a coin. The scale comes from the
// instrument, which takes it from the precision the export carries.

declare const priceBrand: unique symbol;
declare const volumeBrand: unique symbol;

/** A price as a whole number of ticks (10^-scale of the quote currency). */
export type Price = number & { readonly [priceBrand]: true };

/** A volume as a whole number of the instrument's smallest traded unit. */
export type Volume = number & { readonly [volumeBrand]: true };

export class ScaledNumberError extends Error {}

/**
 * Largest exact integer in a float64. Scaled sums must stay below it or
 * precision is lost silently, which would break parity in the one place it is
 * least visible. `sumVolume` enforces it.
 */
const MAX_EXACT = Number.MAX_SAFE_INTEGER;

function assertWholeAndExact(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new ScaledNumberError(`${what} must be a whole number of scaled units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ScaledNumberError(
      `${what} ${value} exceeds the exact-integer range, so it can no longer be compared exactly`,
    );
  }
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) {
    throw new ScaledNumberError(`Scale must be a whole number of decimal places in 0..12, got ${scale}`);
  }
}

export function price(scaledUnits: number): Price {
  assertWholeAndExact(scaledUnits, 'Price');
  return scaledUnits as Price;
}

export function volume(scaledUnits: number): Volume {
  assertWholeAndExact(scaledUnits, 'Volume');
  if (scaledUnits < 0) throw new ScaledNumberError(`Volume cannot be negative, got ${scaledUnits}`);
  return scaledUnits as Volume;
}

/**
 * Parse a decimal string exactly, with no floating-point step.
 *
 * `parseScaled('191.20', 2)` is 19120. Done by string surgery rather than
 * `Number(text) * 10 ** scale`, because that multiplication is itself lossy:
 * `1.005 * 100` is 100.49999999999999. The exports are read with this, so a
 * value that cannot be represented at the instrument's scale is an error
 * rather than a silent rounding.
 */
export function parseScaled(text: string, scale: number): number {
  assertScale(scale);
  const trimmed = text.trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) {
    throw new ScaledNumberError(`Not a decimal number: ${JSON.stringify(text)}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > scale) {
    const significant = fraction.slice(scale).replace(/0+$/, '');
    if (significant !== '') {
      throw new ScaledNumberError(
        `${trimmed} has more precision than scale ${scale} can hold; rounding here would break exact parity`,
      );
    }
  }
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const digits = whole + padded;
  const value = sign * Number(digits);
  assertWholeAndExact(value, 'Scaled value');
  return value;
}

/** Render a scaled whole number as a decimal string with exactly `scale` places. */
export function formatScaled(scaledUnits: number, scale: number): string {
  assertScale(scale);
  assertWholeAndExact(scaledUnits, 'Scaled value');
  const negative = scaledUnits < 0;
  const digits = Math.abs(scaledUnits).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Add volumes exactly, failing loudly if the total leaves the exact-integer
 * range rather than quietly losing the low digits.
 */
export function sumVolume(values: readonly Volume[]): Volume {
  let total = 0;
  for (const value of values) {
    total += value;
    if (total > MAX_EXACT) {
      throw new ScaledNumberError(
        'Volume sum left the exact-integer range; reduce the instrument volume scale',
      );
    }
  }
  return volume(total);
}
