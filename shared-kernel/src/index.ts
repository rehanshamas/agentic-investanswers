// Shared kernel: Instrument, Timeframe, Bar, BarTime and market-session helpers.
// Built in task M0-04. Imports nothing from the rest of the repo.
//
// Every helper takes time in as an argument; nothing here reads the clock.

export type { BarTime } from './bar-time.js';
export {
  BarTimeError,
  addMinutes,
  addSeconds,
  barTime,
  barTimeFromMillis,
  barTimeFromUtcParts,
  floorToSeconds,
  toEpochMillis,
  toEpochSeconds,
} from './bar-time.js';

export type { Timeframe, TimeframeKind } from './timeframe.js';
export {
  TIMEFRAMES,
  isIntraday,
  isTimeframe,
  timeframeKind,
  timeframeMinutes,
  timeframeSeconds,
} from './timeframe.js';

export type { Instrument, MarketKind } from './instrument.js';
export { hasSessions, isCrypto, tickSize } from './instrument.js';

export type { Price, Volume } from './scaled.js';
export {
  ScaledNumberError,
  formatScaled,
  parseScaled,
  price,
  sumVolume,
  volume,
} from './scaled.js';

export type { Bar } from './bar.js';
export { BarError, assertCoherent } from './bar.js';

export type { LocalTime, ZonedParts } from './time-zone.js';
export {
  TimeZoneError,
  addDays,
  dateKey,
  dayOfWeek,
  epochSecondsFromZonedParts,
  parseDateKey,
  zoneOffsetSeconds,
  zonedDateKey,
  zonedParts,
} from './time-zone.js';

export type { MarketCalendar } from './calendar.js';
export {
  CalendarError,
  closeTimeOn,
  firstTradingDayOfMonth,
  firstTradingDayOfWeek,
  isTradingDay,
  nyseCalendar,
  tradingDayOnOrAfter,
  tradingDayOnOrBefore,
} from './calendar.js';

export type { Session } from './session.js';
export { SessionError, sessionContaining, sessionMinutes, sessionOn } from './session.js';

export { AlignmentError, alignToTimeframe } from './align.js';
