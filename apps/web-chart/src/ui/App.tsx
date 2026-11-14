// The chart app: pickers, the chart, and a status line (connection state and
// any message from the server, with the upgrade link for a locked choice).
// Indicator settings (M3-02) are checked by the server and kept here until
// the chart draws indicators (M3-05).

import type { IndicatorSettingsDialog, IndicatorsResponse, InstrumentInfo, SettingsAccepted } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { SeriesStatus } from '../data/bar-series.js';
import type { ConnectionState, LiveConnection } from '../data/live-connection.js';
import type { PlatformClient } from '../data/platform-client.js';
import { ChartView } from './ChartView.js';
import { SettingsDialog } from './SettingsDialog.js';
import { Toolbar } from './Toolbar.js';

/** The live connection's state, for useSyncExternalStore. */
export interface StateSource {
  get(): ConnectionState;
  subscribe(listener: () => void): () => void;
}

export interface AppProps {
  readonly client: PlatformClient;
  readonly live: LiveConnection;
  readonly connection: StateSource;
}

const CONNECTION_TEXT: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Closed',
};

/** The first choice open to the caller: 1m if included, else the shortest included timeframe. */
function defaultTimeframe(instrument: InstrumentInfo): Timeframe | undefined {
  return instrument.included.includes('1m') ? '1m' : instrument.included[0];
}

export function App({ client, live, connection }: AppProps) {
  const [instruments, setInstruments] = useState<readonly InstrumentInfo[]>();
  const [failure, setFailure] = useState<string>();
  const [symbol, setSymbol] = useState<string>();
  const [timeframe, setTimeframe] = useState<Timeframe>();
  const [status, setStatus] = useState<SeriesStatus>({ state: 'loading' });
  const state = useSyncExternalStore(connection.subscribe, connection.get);
  const [indicators, setIndicators] = useState<IndicatorsResponse['indicators']>([]);
  const [applied, setApplied] = useState<Readonly<Record<string, SettingsAccepted>>>({});
  const [editing, setEditing] = useState<IndicatorSettingsDialog>();

  useEffect(() => {
    let current = true;
    // Without the list the chart still works, just with no indicator picker.
    client.indicators().then(
      ({ indicators: list }) => current && setIndicators(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client]);

  useEffect(() => {
    let current = true;
    client.instruments().then(
      ({ instruments: list }) => {
        if (!current) return;
        setInstruments(list);
        const first = list.find((i) => i.included.length > 0);
        if (first !== undefined) {
          setSymbol(first.symbol);
          setTimeframe(defaultTimeframe(first));
        }
      },
      (error: unknown) => current && setFailure(error instanceof Error ? error.message : 'could not reach the server'),
    );
    return () => {
      current = false;
    };
  }, [client]);

  const instrument = instruments?.find((i) => i.symbol === symbol);

  const chooseInstrument = (next: string) => {
    const chosen = instruments?.find((i) => i.symbol === next);
    if (chosen === undefined) return;
    setSymbol(next);
    if (timeframe === undefined || !chosen.included.includes(timeframe)) setTimeframe(defaultTimeframe(chosen));
  };

  const openIndicator = (id: string) => setEditing(applied[id]?.dialog ?? indicators.find((i) => i.id === id)?.dialog);

  const applySettings = async (dialog: IndicatorSettingsDialog, settings: Record<string, unknown>) => {
    const outcome = await client.checkSettings(dialog.indicatorId, settings);
    if (!outcome.ok) return outcome.fields;
    setApplied({ ...applied, [dialog.indicatorId]: outcome.accepted });
    setEditing(undefined);
    return undefined;
  };

  if (failure !== undefined) return <p className="message" role="alert">{failure}</p>;
  if (instruments === undefined) return <p className="message">Loading…</p>;
  if (instrument === undefined || timeframe === undefined) return <p className="message">No instrument is available on your plan.</p>;

  return (
    <div className="app">
      <Toolbar
        instruments={instruments}
        instrument={instrument}
        timeframe={timeframe}
        onInstrument={chooseInstrument}
        onTimeframe={setTimeframe}
        indicators={indicators}
        onIndicator={openIndicator}
      />
      <ChartView client={client} live={live} instrument={instrument} timeframe={timeframe} onStatus={setStatus} />
      <div className="status" data-testid="status" data-connection={state} data-series={status.state}>
        <span>{CONNECTION_TEXT[state]}</span>
        {status.state === 'loading' && <span>Loading bars…</span>}
        {status.state === 'error' && (
          <span role="alert">
            {status.message}
            {status.upgradeUrl !== undefined && (
              <>
                {' '}
                <a href={status.upgradeUrl}>Upgrade</a>
              </>
            )}
          </span>
        )}
      </div>
      {editing !== undefined && (
        <SettingsDialog
          key={editing.indicatorId}
          dialog={editing}
          onApply={(settings) => applySettings(editing, settings)}
          onClose={() => setEditing(undefined)}
        />
      )}
      <output hidden data-testid="applied-settings">
        {JSON.stringify(Object.fromEntries(Object.entries(applied).map(([id, a]) => [id, a.settings])))}
      </output>
    </div>
  );
}
