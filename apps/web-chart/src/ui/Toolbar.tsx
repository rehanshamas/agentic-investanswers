// Instrument and timeframe pickers. What is offered comes from GET
// /instruments: timeframes not served are left out, and ones the caller's
// plan does not include are shown locked. The indicator picker (M3-02) lists
// GET /indicators and is left out while there are none.

import type { InstrumentInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

export interface ToolbarProps {
  readonly instruments: readonly InstrumentInfo[];
  readonly instrument: InstrumentInfo;
  readonly timeframe: Timeframe;
  readonly onInstrument: (symbol: string) => void;
  readonly onTimeframe: (tf: Timeframe) => void;
  readonly indicators?: readonly { readonly id: string; readonly name: string }[];
  /** Opens the settings dialog of the chosen indicator. */
  readonly onIndicator?: (id: string) => void;
}

export function Toolbar({ instruments, instrument, timeframe, onInstrument, onTimeframe, indicators = [], onIndicator }: ToolbarProps) {
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
      {indicators.length > 0 && onIndicator !== undefined && (
        // Always shows its prompt: choosing an indicator opens its dialog.
        <select aria-label="Indicators" data-testid="indicators" value="" onChange={(e) => e.target.value !== '' && onIndicator(e.target.value)}>
          <option value="">Indicators…</option>
          {indicators.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
