// The feed plan: which provider serves each instrument, for history and live,
// from which day. Pure: imports only @aia/shared-kernel, no I/O, no clock.
//
// Client requirement (CLAUDE.md rule 7): the source of any feed must be
// replaceable at any time with no hard dependency on a provider. So nothing
// else picks a provider. Backfill, gap repair, the live stream and the
// 1-minute reader all ask this plan. Switching an instrument to another
// provider is a new dated entry, never a code change.
//
// Sources are effective-dated rather than a single name per instrument,
// because raw keys carry the provider: if BTCUSD moves from `coinbase` to
// `coinapi` on 2027-01-01, the days before that are still stored under
// `coinbase`, and the reader must keep finding them there.

import { addDays, parseDateKey } from '@aia/shared-kernel';

export class FeedPlanError extends Error {}

/** One provider serving one instrument from a given UTC day. */
export interface FeedSource {
  /** The adapter's registered name, and the `provider` part of raw keys. */
  readonly provider: string;
  /**
   * First UTC day (`YYYY-MM-DD`) this source serves the instrument. Only the
   * first source may omit it, meaning "as far back as the provider has".
   */
  readonly from?: string;
}

export interface HistorySource extends FeedSource {
  /**
   * How long a day must have ended before it is stored. Raw is write-once,
   * so a day must be final first, and how long that takes is the provider's
   * trait (Massive's newest day can still change), not the instrument's.
   */
  readonly settleSeconds: number;
}

export interface InstrumentFeeds {
  /** Our instrument symbol, for example `BTCUSD`. Never the provider's. */
  readonly symbol: string;
  /** Where a backfill with no `--from` starts. */
  readonly defaultFrom: string;
  /** Ascending by `from`; at least one. */
  readonly history: readonly HistorySource[];
  /** Ascending by `from`; empty when the instrument has no live feed yet. */
  readonly live: readonly FeedSource[];
}

export interface FeedPlan {
  readonly instruments: readonly InstrumentFeeds[];
}

/** One run of days served by a single history source. */
export interface HistorySegment {
  readonly source: HistorySource;
  readonly from: string;
  /** Inclusive; `undefined` means up to the last settled day. */
  readonly until: string | undefined;
}

// Provider names become S3 key segments, so keep them to a safe alphabet.
const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dateKey(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new FeedPlanError(`${what} must be a YYYY-MM-DD string`);
  let valid: boolean;
  try {
    parseDateKey(value);
    // parseDateKey checks only the shape; a real date survives a round trip.
    valid = addDays(value, 0) === value;
  } catch {
    valid = false;
  }
  if (!valid) throw new FeedPlanError(`${what} must be a valid YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  return value;
}

function parseSource(value: unknown, what: string, first: boolean): FeedSource {
  if (!isRecord(value)) throw new FeedPlanError(`${what} must be an object`);
  const { provider, from } = value;
  if (typeof provider !== 'string' || !PROVIDER_NAME.test(provider)) {
    throw new FeedPlanError(
      `${what}.provider must be a lower-case adapter name such as "acme-data", got ${JSON.stringify(provider)}`,
    );
  }
  if (from === undefined) {
    if (!first) throw new FeedPlanError(`${what}.from is required: only the first source may omit it`);
    return { provider };
  }
  return { provider, from: dateKey(from, `${what}.from`) };
}

function parseSources<T extends FeedSource>(
  value: unknown,
  what: string,
  each: (item: unknown, where: string, first: boolean) => T,
): T[] {
  if (!Array.isArray(value)) throw new FeedPlanError(`${what} must be an array`);
  const sources = value.map((item, i) => each(item, `${what}[${i}]`, i === 0));
  for (let i = 1; i < sources.length; i++) {
    const previous = sources[i - 1]?.from;
    const current = sources[i]?.from;
    if (previous !== undefined && current !== undefined && current <= previous) {
      throw new FeedPlanError(`${what} must be in ascending order of "from": ${current} follows ${previous}`);
    }
  }
  return sources;
}

function parseHistorySource(value: unknown, what: string, first: boolean): HistorySource {
  const source = parseSource(value, what, first);
  const settleSeconds = isRecord(value) ? value['settleSeconds'] : undefined;
  if (typeof settleSeconds !== 'number' || !Number.isSafeInteger(settleSeconds) || settleSeconds < 0) {
    throw new FeedPlanError(`${what}.settleSeconds must be a whole number of seconds, 0 or more`);
  }
  return { ...source, settleSeconds };
}

/**
 * Validate a feed plan read from configuration. Throws `FeedPlanError` naming
 * the first problem, so a bad plan stops a command before it touches a
 * provider or the store.
 */
export function parseFeedPlan(input: unknown): FeedPlan {
  if (!isRecord(input) || !Array.isArray(input['instruments'])) {
    throw new FeedPlanError('A feed plan must be an object with an "instruments" array');
  }
  const seen = new Set<string>();
  const instruments = input['instruments'].map((entry: unknown, i: number): InstrumentFeeds => {
    const what = `instruments[${i}]`;
    if (!isRecord(entry)) throw new FeedPlanError(`${what} must be an object`);
    const { symbol } = entry;
    if (typeof symbol !== 'string' || symbol === '')
      throw new FeedPlanError(`${what}.symbol must be a symbol such as "BTCUSD"`);
    if (seen.has(symbol)) throw new FeedPlanError(`${symbol} appears twice in the feed plan`);
    seen.add(symbol);

    const history = parseSources(entry['history'], `${symbol}.history`, parseHistorySource);
    if (history.length === 0) throw new FeedPlanError(`${symbol}.history needs at least one source`);
    const live = parseSources(entry['live'] ?? [], `${symbol}.live`, parseSource);
    const defaultFrom = dateKey(entry['defaultFrom'], `${symbol}.defaultFrom`);
    const earliest = history[0]?.from;
    if (earliest !== undefined && defaultFrom < earliest) {
      throw new FeedPlanError(`${symbol}.defaultFrom ${defaultFrom} is before its first history source (${earliest})`);
    }
    return { symbol, defaultFrom, history, live };
  });
  return { instruments };
}

/** The feeds of one instrument; throws if the plan does not cover it. */
export function feedsFor(plan: FeedPlan, symbol: string): InstrumentFeeds {
  const feeds = plan.instruments.find((entry) => entry.symbol === symbol);
  if (feeds === undefined) throw new FeedPlanError(`The feed plan has no entry for ${symbol}`);
  return feeds;
}

/** The source in effect on `date`, or `undefined` before the first one starts. */
function sourceOn<T extends FeedSource>(sources: readonly T[], date: string): T | undefined {
  let current: T | undefined;
  for (const source of sources) {
    if (source.from === undefined || source.from <= date) current = source;
    else break;
  }
  return current;
}

/** Which history source serves `date`, or `undefined` if none does. */
export function historySourceOn(feeds: InstrumentFeeds, date: string): HistorySource | undefined {
  return sourceOn(feeds.history, date);
}

/** Which live source serves `date`, or `undefined` if none does. */
export function liveSourceOn(feeds: InstrumentFeeds, date: string): FeedSource | undefined {
  return sourceOn(feeds.live, date);
}

/**
 * Where a history run starts: `from`, or the plan's default, but never
 * before the first source serves anything. `moved` says the start was moved
 * forward, so a command can say why.
 */
export function historyStart(feeds: InstrumentFeeds, from: string | undefined): { start: string; moved: boolean } {
  if (from === undefined) return { start: feeds.defaultFrom, moved: false };
  const earliest = feeds.history[0]?.from;
  if (earliest !== undefined && from < earliest) return { start: earliest, moved: true };
  return { start: from, moved: false };
}

/**
 * Split `[from, until]` into runs served by one history source each, in
 * order. A run that a later source starts before `until` ends the day before.
 */
export function historySegments(feeds: InstrumentFeeds, from: string, until: string | undefined): HistorySegment[] {
  const segments: HistorySegment[] = [];
  feeds.history.forEach((source, i) => {
    const next = feeds.history[i + 1]?.from;
    const start = source.from !== undefined && source.from > from ? source.from : from;
    const lastOfSource = next === undefined ? undefined : addDays(next, -1);
    let end = until;
    if (lastOfSource !== undefined && (end === undefined || lastOfSource < end)) end = lastOfSource;
    if (end !== undefined && end < start) return;
    segments.push({ source, from: start, until: end });
  });
  return segments;
}
