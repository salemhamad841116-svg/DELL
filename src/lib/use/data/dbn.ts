// Databento DBN decoder (v1/v2/v3) for OHLCV records, with optional zstd.
// Pure JS — safe for the Worker runtime. Prices are fixed-point 1e-9.
import { decompress } from "fzstd";

export type DbnBar = { instrumentId: number; rtype: number; ts: number; open: number; high: number; low: number; close: number; volume: number };
export type DbnFile = { version: number; dataset: string; schema: number; start: number; end: number; bars: DbnBar[]; recordsRead: number; skipped: number };

const UNDEF = 0x7fffffffffffffffn;
const OHLCV_RTYPES = new Set([0x20, 0x21, 0x22, 0x23, 0x24]); // 1s, 1m, 1h, 1d, eod

export function decodeDbn(input: Uint8Array): DbnFile {
  // zstd magic 28 B5 2F FD
  const buf = input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd ? decompress(input) : input;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0x44 || buf[1] !== 0x42 || buf[2] !== 0x4e) throw new Error("DBN: bad magic");
  const version = buf[3]!;
  const metaLen = dv.getUint32(4, true);
  const m = 8;
  const dataset = new TextDecoder().decode(buf.subarray(m, m + 16)).replace(/\0+$/, "");
  const schema = dv.getUint16(m + 16, true);
  const start = Number(dv.getBigUint64(m + 18, true) / 1_000_000n);
  const endRaw = dv.getBigUint64(m + 26, true);
  const end = endRaw === 0xffffffffffffffffn ? 0 : Number(endRaw / 1_000_000n);
  let off = 8 + metaLen;
  const bars: DbnBar[] = [];
  let recordsRead = 0, skipped = 0;
  while (off < buf.length) {
    const len = buf[off]! * 4;
    if (len === 0 || off + len > buf.length) break;
    const rtype = buf[off + 1]!;
    recordsRead++;
    if (OHLCV_RTYPES.has(rtype) && len >= 56) {
      const px = (o: number) => { const v = dv.getBigInt64(off + o, true); return v === UNDEF ? NaN : Number(v) / 1e9; };
      bars.push({
        rtype,
        instrumentId: dv.getUint32(off + 4, true),
        ts: Number(dv.getBigUint64(off + 8, true) / 1_000_000n),
        open: px(16), high: px(24), low: px(32), close: px(40),
        volume: Number(dv.getBigUint64(off + 48, true)),
      });
    } else skipped++;
    off += len;
  }
  return { version, dataset, schema, start, end, bars, recordsRead, skipped };
}

/** Parent symbols (e.g. GC.FUT) return every contract + spread. Keep the single most-traded instrument. */
export function dominantInstrument(bars: DbnBar[]): DbnBar[] {
  const vol = new Map<number, number>();
  for (const b of bars) vol.set(b.instrumentId, (vol.get(b.instrumentId) ?? 0) + b.volume);
  const top = [...vol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return bars.filter((b) => b.instrumentId === top);
}

/** Timestamps (ms) of every record in a DBN stream — used for Trades-schema gap checks. */
export function decodeDbnTimestamps(input: Uint8Array): number[] {
  const buf = input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd ? decompress(input) : input;
  if (buf.length < 8) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8 + dv.getUint32(4, true);
  const out: number[] = [];
  while (off < buf.length) { const len = buf[off]! * 4; if (!len || off + len > buf.length) break; out.push(Number(dv.getBigUint64(off + 8, true) / 1_000_000n)); off += len; }
  return out;
}
