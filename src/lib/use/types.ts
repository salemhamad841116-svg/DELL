// Universal Strategy Engine — shared types (browser-safe, no server imports)

export type Candle = {
  ts: number; // epoch ms, open time of the candle
  /** Resolved underlying contract (continuous futures) — for roll auditing. */
  instrumentId?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type DirectionState =
  | "STRONG_BULLISH"
  | "BULLISH"
  | "NEUTRAL"
  | "BEARISH"
  | "STRONG_BEARISH";

export type DataQuality = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type MarketRegime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGE"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "BREAKOUT"
  | "UNCERTAIN";

export type EvidenceItem = {
  label: string;
  contribution: number; // signed, in logit points scaled to +/- 100
  supports: "BULLISH" | "BEARISH";
  value: number;
};

export type ModelMetrics = {
  samples: number;
  accuracy: number;
  logLoss: number;
  brier: number;
  auc: number;
  hitRateUp: number;
  hitRateDown: number;
};

export type HorizonForecast = {
  timeframe: string;
  supported: boolean;
  state: DirectionState;
  directionProbability: number;
  bullishProbability: number;
  bearishProbability: number;
  neutralProbability: number;
  confidence: number;
  signalStrength: number;
  dataQuality: DataQuality;
  sampleSize: number;
  historicalHitRate: number;
  candlesAvailable: number;
  note?: string;
};

export type NextCandleForecast = {
  symbol: string;
  timeframe: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  bullishProbability: number;
  bearishProbability: number;
  neutralProbability: number;
  confidence: number;
  expectedReturn: number;
  expectedLow: number;
  expectedHigh: number;
  expectedVolatility: number;
  referenceClose: number;
  sampleSize: number;
  modelVersion: string;
  dataTimestamp: string;
  dataQuality: DataQuality;
  evidence: EvidenceItem[];
  metrics: {
    train: ModelMetrics;
    validation: ModelMetrics;
    outOfSample: ModelMetrics;
    baseline: ModelMetrics;
    walkForward: ModelMetrics[];
  };
  overfittingRisk: boolean;
  regime: MarketRegime;
  regimeStats: RegimeStats;
};

export type RegimeStats = {
  regime: MarketRegime;
  samples: number;
  successRate: number;
  averageReturn: number;
};

export type HistoricalStats = {
  observations: number;
  trades: number;
  winRate: number;
  lossRate: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  averageReturn: number;
  averageFavorableExcursion: number;
  averageAdverseExcursion: number;
  averageTimeToTarget: number;
  averageTimeToFailure: number;
  longWinRate: number;
  shortWinRate: number;
  longTrades: number;
  shortTrades: number;
};

export type Bucket = {
  key: string;
  samples: number;
  winRate: number;
  averageReturn: number;
};

export type HistoricalReport = {
  symbol: string;
  timeframe: string;
  periodStart: string | null;
  periodEnd: string | null;
  stats: HistoricalStats;
  byHour: Bucket[];
  byWeekday: Bucket[];
  byMonth: Bucket[];
  byRegime: Bucket[];
  byVolatility: Bucket[];
  aggregates: Bucket[]; // second -> minute -> hour -> day -> week -> month -> year coverage
  featureCombinations: Bucket[];
};

export type StrategyRepresentation = {
  metadata: {
    name: string;
    language: string;
    version: string;
    detectedFrom: string;
    lines: number;
  };
  parameters: { name: string; value: number | string | boolean; type: string }[];
  indicators: { name: string; source: string; length: number | null }[];
  features: string[];
  entryRules: { side: "BUY" | "SELL"; expression: string }[];
  exitRules: { kind: string; expression: string }[];
  riskRules: { kind: "TP" | "SL" | "TRAIL" | "SIZE"; expression: string }[];
  timeframeRules: { timeframe: string; context: string }[];
  sessionFilters: string[];
  dependencies: string[];
  lookbackBars: number;
};

export type SecurityValidation = {
  safe: boolean;
  language: string;
  findings: { severity: "info" | "warning" | "critical"; rule: string; detail: string }[];
  sandboxRequired: boolean;
  scriptType?: "STRATEGY" | "INDICATOR" | "LIBRARY" | "UNKNOWN";
  validity?: "VALID_STRATEGY" | "VALID_INDICATOR" | "VALID_LIBRARY" | "INVALID_CODE";
  scriptStatus?: string;
  backtestExecutable?: boolean;
  notExecutableReason?: string | null;
  diagnostics?: { code: string; construct: string; line: number; col: number }[];
};
