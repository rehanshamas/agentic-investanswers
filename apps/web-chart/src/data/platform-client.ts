// The platform's REST routes as the chart uses them (GET /bars, GET
// /instruments), and the /live URL. Same origin: the Vite dev server proxies
// to the platform locally, and staging serves both behind one host (M2-01).
//
// A session token, when there is one, goes on every request: the
// Authorization header on REST, `?token=` on /live (browsers cannot set
// WebSocket headers). Locally there is none and the platform runs with
// AIA_DEV_AUTH=1 (decision record T-07).

import type { ApiErrorBody, HistoryResponse, InstrumentsResponse } from '@aia/client-contract';
import { HISTORY_DEFAULT_LIMIT } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

/** A refused request, with the server's own message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly upgradeUrl?: string,
  ) {
    super(message);
  }
}

export interface PlatformClientOptions {
  /** The session token, if signed in. */
  readonly token: () => string | undefined;
  /** Page origin, for example `https://charts.example.com`. */
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

export class PlatformClient {
  constructor(private readonly options: PlatformClientOptions) {}

  /** The newest page of bars, or the page before `before`. */
  history(instrument: string, tf: Timeframe, limit = HISTORY_DEFAULT_LIMIT): Promise<HistoryResponse> {
    const query = new URLSearchParams({ instrument, tf, limit: String(limit) });
    return this.get<HistoryResponse>(`/bars?${query.toString()}`);
  }

  instruments(): Promise<InstrumentsResponse> {
    return this.get<InstrumentsResponse>('/instruments');
  }

  liveUrl(): string {
    const url = new URL('/live', this.options.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = this.options.token();
    if (token !== undefined) url.searchParams.set('token', token);
    return url.toString();
  }

  private async get<T>(path: string): Promise<T> {
    const token = this.options.token();
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.origin), {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    if (response.ok) return (await response.json()) as T;
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // not JSON: fall back to the status alone
    }
    const error = body.error;
    throw new ApiError(response.status, error?.code ?? 'http_error', error?.message ?? `the server answered ${response.status}`, error?.upgradeUrl);
  }
}

/** The stored session token, if any (none until a sign-in screen exists, T-07). */
export function storedToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem('aia.session') ?? undefined;
  } catch {
    return undefined;
  }
}
