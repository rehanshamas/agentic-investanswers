// GET JSON from a provider: paced, retried on 429, 5xx and network errors
// with `Retry-After` honoured, and never retried on other client errors.
// Shared by the provider adapters.

export interface PacedJsonOptions {
  readonly fetch?: typeof fetch;
  /** Injected so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between requests, to stay under the provider's rate limit. */
  readonly minIntervalMs: number;
  readonly maxAttempts?: number;
  /** Backoff when the provider gives no `Retry-After`: base, doubled per attempt, capped. */
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** Builds the adapter's own error type. */
  readonly fail: (message: string) => Error;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PacedJson {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(private readonly options: PacedJsonOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * GET `url` and parse JSON. `label` names the request in errors; pass one
   * without secrets, since errors are logged. Headers may carry credentials.
   */
  async get(url: string, headers: Record<string, string>, label: string = url): Promise<unknown> {
    const maxAttempts = this.options.maxAttempts ?? 6;
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.pace();
      let response: Response;
      try {
        response = await this.fetchFn(url, { headers });
      } catch (error) {
        lastError = `network error: ${error instanceof Error ? error.message : String(error)}`;
        await this.sleep(this.backoffMs(attempt, undefined));
        continue;
      }
      if (response.ok) return response.json() as Promise<unknown>;

      const text = (await response.text()).slice(0, 200);
      lastError = `HTTP ${response.status}: ${text}`;
      if (response.status !== 429 && response.status < 500) {
        throw this.options.fail(`${label} failed: ${lastError}`);
      }
      await this.sleep(this.backoffMs(attempt, response.headers.get('retry-after')));
    }
    throw this.options.fail(`${label} failed after ${maxAttempts} attempts: ${lastError}`);
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.options.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** `Retry-After` seconds when given, else base, 2×base, 4×base ... capped. */
  private backoffMs(attempt: number, retryAfter: string | null | undefined): number {
    const seconds = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const base = this.options.backoffBaseMs ?? 1000;
    return Math.min(this.options.backoffCapMs ?? 30_000, base * 2 ** (attempt - 1));
  }
}
