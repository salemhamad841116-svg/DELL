// Timeframe registry. Provider resolutions come from the market data feed;
// anything not natively served is aggregated from a smaller base resolution.
// Sub-minute horizons are marked unsupported for this feed instead of being faked.

export type TimeframeSpec = {
  id: string;
  label: string;
  seconds: number;
  /** Finnhub resolution when natively available. */
  providerResolution: string | null;
  /** Base timeframe to aggregate from when not natively available. */
  aggregateFrom: string | null;
  supported: boolean;
};

export const TIMEFRAMES: TimeframeSpec[] = [
  { id: "5s", label: "5s", seconds: 5, providerResolution: null, aggregateFrom: null, supported: false },
  { id: "10s", label: "10s", seconds: 10, providerResolution: null, aggregateFrom: null, supported: false },
  { id: "30s", label: "30s", seconds: 30, providerResolution: null, aggregateFrom: null, supported: false },
  { id: "45s", label: "45s", seconds: 45, providerResolution: null, aggregateFrom: null, supported: false },
  { id: "1m", label: "1m", seconds: 60, providerResolution: "1", aggregateFrom: null, supported: true },
  { id: "5m", label: "5m", seconds: 300, providerResolution: "5", aggregateFrom: null, supported: true },
  { id: "10m", label: "10m", seconds: 600, providerResolution: null, aggregateFrom: "5m", supported: true },
  { id: "15m", label: "15m", seconds: 900, providerResolution: "15", aggregateFrom: null, supported: true },
  { id: "30m", label: "30m", seconds: 1800, providerResolution: "30", aggregateFrom: null, supported: true },
  { id: "45m", label: "45m", seconds: 2700, providerResolution: null, aggregateFrom: "15m", supported: true },
  { id: "1h", label: "1h", seconds: 3600, providerResolution: "60", aggregateFrom: null, supported: true },
  { id: "4h", label: "4h", seconds: 14400, providerResolution: null, aggregateFrom: "1h", supported: true },
  { id: "6h", label: "6h", seconds: 21600, providerResolution: null, aggregateFrom: "1h", supported: true },
  { id: "8h", label: "8h", seconds: 28800, providerResolution: null, aggregateFrom: "1h", supported: true },
  { id: "1D", label: "1D", seconds: 86400, providerResolution: "D", aggregateFrom: null, supported: true },
  { id: "1W", label: "1W", seconds: 604800, providerResolution: "W", aggregateFrom: null, supported: true },
  { id: "1M", label: "1M", seconds: 2592000, providerResolution: "M", aggregateFrom: null, supported: true },
];

export const MATRIX_TIMEFRAMES = [
  "5s",
  "30s",
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1D",
  "1W",
  "1M",
];

export const ANALYSIS_TIMEFRAMES = TIMEFRAMES.filter((t) => t.supported).map((t) => t.id);

export function getTimeframe(id: string): TimeframeSpec | undefined {
  return TIMEFRAMES.find((t) => t.id === id);
}

export function timeframeSeconds(id: string): number {
  return getTimeframe(id)?.seconds ?? 300;
}
