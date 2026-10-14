// Market Calendar Engine — exchange-specific sessions. Never a generic calendar.
// Times are evaluated in each venue's own timezone (DST handled by Intl).

export type MarketType = "crypto" | "forex" | "metal" | "futures" | "stock";
export type Exchange = "CRYPTO" | "FX" | "CME" | "COMEX" | "NYMEX" | "EUREX" | "NYSE" | "NASDAQ";

type Parts = { y: number; m: number; d: number; h: number; min: number; wd: number; key: string };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string): Parts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const p = f.formatToParts(new Date(ts));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const y = +g("year"), m = +g("month"), d = +g("day");
  return { y, m, d, h: +g("hour") % 24, min: +g("minute"), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")), key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

// Official holiday lists (full closures). Early closes listed separately (close time in local minutes).
const US_EQ_HOLIDAYS = new Set([
  "2024-01-01","2024-01-15","2024-02-19","2024-03-29","2024-05-27","2024-06-19","2024-07-04","2024-09-02","2024-11-28","2024-12-25",
  "2025-01-01","2025-01-09","2025-01-20","2025-02-17","2025-04-18","2025-05-26","2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
]);
const US_EQ_EARLY: Record<string, number> = { "2024-07-03": 780, "2024-11-29": 780, "2024-12-24": 780, "2025-07-03": 780, "2025-11-28": 780, "2025-12-24": 780, "2026-11-27": 780, "2026-12-24": 780 };
// CME Globex full-day closures (no session opens): New Year, Good Friday, Christmas.
const CME_CLOSED = new Set(["2024-01-01","2024-03-29","2024-12-25","2025-01-01","2025-04-18","2025-12-25","2026-01-01","2026-04-03","2026-12-25"]);
// CME holiday early halt on US holidays that are not full closures (local CT minutes):
// equity/rates 12:00 CT; metals (COMEX) & energy (NYMEX) 13:30 CT — confirmed on Labor Day 2026 GC data.
const CME_EARLY_HALT: Record<string, number> = { CME: 720, COMEX: 810, NYMEX: 810 };
const CME_EARLY = new Set(["2024-01-15","2024-02-19","2024-05-27","2024-06-19","2024-07-04","2024-09-02","2024-11-28","2025-01-20","2025-02-17","2025-05-26","2025-06-19","2025-07-04","2025-09-01","2025-11-27","2026-01-19","2026-02-16","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-11-26"]);
const EUREX_HOLIDAYS = new Set(["2024-01-01","2024-03-29","2024-04-01","2024-05-01","2024-12-24","2024-12-25","2024-12-26","2024-12-31","2025-01-01","2025-04-18","2025-04-21","2025-05-01","2025-12-24","2025-12-25","2025-12-26","2025-12-31","2026-01-01","2026-04-03","2026-04-06","2026-05-01","2026-12-24","2026-12-25","2026-12-26","2026-12-31"]);
// FX: interbank closes on 25 Dec and 1 Jan.
const FX_HOLIDAYS = new Set(["12-25", "01-01"]);

export function exchangeFor(market: MarketType, providerSymbol: string): Exchange {
  if (market === "crypto") return "CRYPTO";
  if (market === "forex") return "FX";
  if (market === "metal") return /^(GC|SI|HG|PL|PA)/.test(providerSymbol) || providerSymbol.endsWith("=F") ? "COMEX" : "FX";
  if (market === "futures") {
    if (/^(CL|NG|RB|HO)/.test(providerSymbol)) return "NYMEX";
    if (/^(FDAX|FESX|FGBL|FGBM|FGBS)/.test(providerSymbol)) return "EUREX";
    if (/^(GC|SI|HG)/.test(providerSymbol)) return "COMEX";
    return "CME";
  }
  return /^(AAPL|MSFT|NVDA|AMZN|META|GOOGL?|TSLA|NFLX)$/.test(providerSymbol) ? "NASDAQ" : "NYSE";
}

/** True when the venue is trading at `ts` (ms, UTC). */
export function isOpen(ex: Exchange, ts: number): boolean {
  switch (ex) {
    case "CRYPTO":
      return true;
    case "FX": {
      // Sun 17:00 → Fri 17:00 New York time (DST-aware).
      const p = parts(ts, "America/New_York");
      const mins = p.h * 60 + p.min;
      if (FX_HOLIDAYS.has(p.key.slice(5))) return false;
      if (p.wd === 6) return false;
      if (p.wd === 5 && mins >= 1020) return false;
      if (p.wd === 0 && mins < 1020) return false;
      return true;
    }
    case "CME":
    case "COMEX":
    case "NYMEX": {
      // Globex: Sun 17:00 CT → Fri 16:00 CT, daily halt 16:00–17:00 CT.
      const p = parts(ts, "America/Chicago");
      const mins = p.h * 60 + p.min;
      if (p.wd === 6) return false;
      if (p.wd === 5 && mins >= 960) return false;
      if (p.wd === 0 && mins < 1020) return false;
      if (mins >= 960 && mins < 1020) return false;
      // trading day belongs to the next calendar date after 17:00 CT
      const tradeKey = mins >= 1020 ? parts(ts + 86_400_000, "America/Chicago").key : p.key;
      if (CME_CLOSED.has(tradeKey)) return false;
      if (CME_EARLY.has(p.key) && mins >= (CME_EARLY_HALT[ex] ?? 720) && mins < 1020) return false;
      return true;
    }
    case "EUREX": {
      // Index/rates futures trading phase 01:10–22:00 CET/CEST, Mon–Fri.
      const p = parts(ts, "Europe/Berlin");
      const mins = p.h * 60 + p.min;
      if (p.wd === 0 || p.wd === 6 || EUREX_HOLIDAYS.has(p.key)) return false;
      return mins >= 70 && mins < 1320;
    }
    case "NYSE":
    case "NASDAQ": {
      const p = parts(ts, "America/New_York");
      const mins = p.h * 60 + p.min;
      if (p.wd === 0 || p.wd === 6 || US_EQ_HOLIDAYS.has(p.key)) return false;
      return mins >= 570 && mins < (US_EQ_EARLY[p.key] ?? 960);
    }
  }
}

/** Whether a daily bar dated `ts` (UTC midnight) is a trading day on the venue. */
function isTradingDay(ex: Exchange, ts: number): boolean {
  if (ex === "CRYPTO") return true;
  const d = new Date(ts);
  const wd = d.getUTCDay();
  const key = d.toISOString().slice(0, 10);
  if (wd === 0 || wd === 6) return false;
  if (ex === "FX") return !FX_HOLIDAYS.has(key.slice(5));
  if (ex === "EUREX") return !EUREX_HOLIDAYS.has(key);
  if (ex === "NYSE" || ex === "NASDAQ") return !US_EQ_HOLIDAYS.has(key);
  return !CME_CLOSED.has(key);
}

/** Expected closed-bar open times in [start, end) according to the venue calendar. */
export function expectedBars(ex: Exchange, stepMs: number, start: number, end: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(start / stepMs) * stepMs;
  for (let t = first; t + stepMs <= end; t += stepMs) {
    if (stepMs >= 86_400_000) {
      if (isTradingDay(ex, t)) out.push(t);
      continue;
    }
    // A bar is expected if the venue trades at any minute-step inside it.
    const probe = Math.min(stepMs, 5 * 60_000);
    for (let s = t; s < t + stepMs; s += probe) {
      if (isOpen(ex, s)) { out.push(t); break; }
    }
  }
  return out;
}
