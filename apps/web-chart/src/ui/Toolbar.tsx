// Instrument and timeframe pickers. What is offered comes from GET
// /instruments: timeframes not served are left out, and ones the caller's
// plan does not include are shown locked.

import type { InstrumentInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

export interface ToolbarProps {
  readonly instruments: readonly InstrumentInfo[];
  readonly instrument: InstrumentInfo;
  readonly timeframe: Timeframe;
  readonly onInstrument: (symbol: string) => void;
  readonly onTimeframe: (tf: Timeframe) => void;
}

export function Toolbar({ instruments, instrument, timeframe, onInstrument, onTimeframe }: ToolbarProps) {
  return (
    <div className="toolbar">
      <select aria-label="Instrument" data-testid="instrument" value={instrument.symbol} onChange={(e) => onInstrument(e.target.value)}>
        {instruments.map((i) => (
          <option key={i.symbol} value={i.symbol} disabled={i.included.length === 0}>
            {i.symbol}
            {i.timeframes.length === 0 ? ' (not served yet)' : i.included.length === 0 ? ' (locked)' : ''}
          </option>
        ))}
      </select>
      <div className="timeframes" role="group" aria-label="Timeframe">
        {instrument.timeframes.map((tf) => {
          const locked = !instrument.included.includes(tf);
          return (
            <button
              key={tf}
              type="button"
              data-testid={`tf-${tf}`}
              aria-pressed={tf === timeframe}
              disabled={locked}
              title={locked ? 'Not included in your plan' : undefined}
              onClick={() => onTimeframe(tf)}
            >
              {tf}
            </button>
          );
        })}
      </div>
    </div>
  );
}
