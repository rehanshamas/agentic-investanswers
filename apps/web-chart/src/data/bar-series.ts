// The bars of one instrument and timeframe on screen, kept current.
// Framework-free; the chart adapter binds to it.
//
// Follows the live gateway's client contract (live-protocol.ts): subscribe,
// then load the newest page from GET /bars, then apply updates by bar time.
// Updates that arrive before the page are held and applied on top of it. On
// `resync` (or a reconnect), the newest page is loaded again.
//
// Applying an update: a newer bar is appended, the same time replaces the
// newest bar, and an older time replaces that bar in place: the protocol
// revises the previous bar every minute (its stored value replacing the
// forming one), so a revision is normal, not an error.

import type { DisplayBar, HistoryResponse, LiveErrorCode, LiveWireUpdate } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

import type { LiveListener } from './live-connection.js';
import { ApiError } from './platform-client.js';

export type SeriesEvent =
  /** The whole series was replaced: the first load, or a reload after resync. */
  | { readonly type: 'reset'; readonly bars: readonly DisplayBar[] }
  /** One bar added or replaced; `newest` when it is the newest bar. */
  | { readonly type: 'bar'; readonly bar: DisplayBar; readonly index: number; readonly newest: boolean };

export type SeriesStatus =
  | { readonly state: 'loading' }
  | { readonly state: 'ready' }
  | { readonly state: 'error'; readonly code: string; readonly message: string; readonly upgradeUrl?: string };

export interface BarSeriesDeps {
  readonly live: { subscribe(instrument: string, tf: Timeframe, listener: LiveListener): () => void };
  readonly history: (instrument: string, tf: Timeframe) => Promise<HistoryResponse>;
  readonly onEvent: (event: SeriesEvent) => void;
  readonly onStatus?: (status: SeriesStatus) => void;
}

export class BarSeries {
  private bars: DisplayBar[] = [];
  /** Updates held while a page loads; undefined once it is in. */
  private held: LiveWireUpdate[] | undefined = [];
  /** Bumped by every load and by stop, so a stale page is dropped. */
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(
    readonly instrument: string,
    readonly timeframe: Timeframe,
    private readonly deps: BarSeriesDeps,
  ) {}

  /** The bars loaded so far, oldest first. */
  get current(): readonly DisplayBar[] {
    return this.bars;
  }

  /** True once the first page is in and no reload is under way. */
  get loaded(): boolean {
    return this.held === undefined;
  }

  start(): void {
    this.unsubscribe = this.deps.live.subscribe(this.instrument, this.timeframe, {
      updates: (updates) => this.receive(updates),
      resync: () => void this.load(),
      error: (code: LiveErrorCode, message: string) => this.status({ state: 'error', code, message }),
    });
    void this.load();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async load(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.held ??= [];
    this.status({ state: 'loading' });
    let page: HistoryResponse;
    try {
      page = await this.deps.history(this.instrument, this.timeframe);
    } catch (failure) {
      if (generation !== this.generation) return;
      this.status(
        failure instanceof ApiError
          ? { state: 'error', code: failure.code, message: failure.message, ...(failure.upgradeUrl === undefined ? {} : { upgradeUrl: failure.upgradeUrl }) }
          : { state: 'error', code: 'network', message: 'could not reach the server; try again' },
      );
      return;
    }
    if (generation !== this.generation) return;
    this.bars = [...page.bars];
    const held = this.held ?? [];
    this.held = undefined;
    for (const update of held) this.apply(update.bar, false);
    this.deps.onEvent({ type: 'reset', bars: this.bars });
    this.status({ state: 'ready' });
  }

  private receive(updates: readonly LiveWireUpdate[]): void {
    if (this.stopped) return;
    if (this.held !== undefined) {
      this.held.push(...updates);
      return;
    }
    for (const update of updates) this.apply(update.bar, true);
  }

  private apply(bar: DisplayBar, emit: boolean): void {
    const bars = this.bars;
    const last = bars[bars.length - 1];
    if (last === undefined || bar.time > last.time) {
      bars.push(bar);
      if (emit) this.deps.onEvent({ type: 'bar', bar, index: bars.length - 1, newest: true });
      return;
    }
    if (bar.time === last.time) {
      bars[bars.length - 1] = bar;
      if (emit) this.deps.onEvent({ type: 'bar', bar, index: bars.length - 1, newest: true });
      return;
    }
    const index = indexOfTime(bars, bar.time);
    if (index >= 0) {
      bars[index] = bar;
      if (emit) this.deps.onEvent({ type: 'bar', bar, index, newest: false });
      return;
    }
    // Older than everything loaded: not on screen, nothing to do.
    if (bar.time < (bars[0]?.time ?? 0)) return;
    // A bar inside the loaded range that was missing: insert it and redraw.
    bars.splice(-index - 1, 0, bar);
    if (emit) this.deps.onEvent({ type: 'reset', bars });
  }

  private status(status: SeriesStatus): void {
    if (!this.stopped) this.deps.onStatus?.(status);
  }
}

/** Index of the bar with this time, or `-(insertion point) - 1` when there is none. */
function indexOfTime(bars: readonly DisplayBar[], time: number): number {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const t = (bars[mid] as DisplayBar).time;
    if (t === time) return mid;
    if (t < time) low = mid + 1;
    else high = mid - 1;
  }
  return -low - 1;
}
