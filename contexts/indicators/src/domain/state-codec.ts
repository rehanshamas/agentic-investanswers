// Indicator state to text and back, for the output cache. Pure. Task M3-04.
//
// State must be plain data: numbers, strings, booleans, null, arrays and plain
// objects. JSON alone would turn NaN (TradingView's `na`, common in ported
// indicators) and infinities into null and silently change the next value, so
// those are tagged on the way out and restored on the way in.

const TAG = '\u0000num:';

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return `${TAG}${String(value)}`;
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(TAG)) return Number(value.slice(TAG.length));
  return value;
}

export function encodeState(state: unknown): string {
  return JSON.stringify(state, replacer);
}

export function decodeState(text: string): unknown {
  return JSON.parse(text, reviver) as unknown;
}
