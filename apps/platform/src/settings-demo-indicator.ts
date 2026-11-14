// A stand-in indicator for the settings tests and the e2e server (M3-02):
// not a real indicator and never registered by main.ts. Real indicator
// source lives in agentic-investanswers-indicators (CLAUDE.md rule 5).
//
// It declares one input of each kind so the settings dialog and the server
// check can be exercised end to end; it draws nothing.

import type { IndicatorDefinition } from '@aia/indicators';

export const settingsDemo: IndicatorDefinition<null> = {
  id: 'settingsDemo',
  version: '1',
  name: 'Settings demo (tests only)',
  inputs: [
    { kind: 'int', key: 'length', label: 'Length', help: 'Bars in the window', default: 20, min: 1, max: 500 },
    { kind: 'float', key: 'offset', label: 'Offset', default: 0, min: 0, max: 10, step: 0.5 },
    { kind: 'bool', key: 'showSignals', label: 'Show signals', default: true },
    { kind: 'choice', key: 'style', label: 'Style', options: ['line', 'steps'], default: 'line' },
    { kind: 'source', key: 'source', label: 'Source', default: 'close' },
  ],
  outputs: [{ kind: 'line', key: 'value', label: 'Value' }],
  init: () => null,
  step: (state) => ({ state, outputs: { value: null } }),
};
