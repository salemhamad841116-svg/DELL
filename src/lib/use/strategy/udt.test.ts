import { describe, it, expect } from "vitest";
import { buildIR } from "./ir";
import { PineRuntime, formatTime } from "./executor";

const src = `//@version=6
indicator("udt")
mode = input.string("b", "Mode", options = ["a", "b"])
type S
    int leg = 0
    float lvl = na
    string ev = "—"
var S st = S.new()
f(S s, int n) =>
    if close > open
        s.leg := s.leg + n
        s.lvl := close
    s.leg
legs = f(st, 2)
k = switch mode
    "a" => 10
    => 20
txt = str.tostring(int(7.9), "00") + "|" + str.tostring(1.23456, "#.##")
tm = str.format_time(time, "yyyy-MM-dd HH:mm", "UTC")
lvl = st.lvl`;

describe("UDT / switch / str.* support", () => {
  it("validates with no diagnostics", async () => {
    const ir = await buildIR(src);
    expect(ir.diagnostics).toEqual([]);
    expect(ir.scriptType).toBe("INDICATOR");
  });
  it("executes with reference semantics across bars", async () => {
    const ir = await buildIR(src);
    const c = [0, 1, 2].map((i) => ({ ts: Date.UTC(2026, 8, 1, 0, i), open: 1, high: 3, low: 0.5, close: i === 1 ? 0.8 : 2, volume: 1 }));
    const rt = new PineRuntime(ir, c, {}, 0.01, { tickerid: "X", timeframe: "1m" });
    c.forEach((_, i) => rt.step(i, { positionSize: 0, avgPrice: null, equity: 0, openTrades: 0 }));
    expect([0, 1, 2].map((i) => rt.valueAt("legs", i))).toEqual([2, 2, 4]);
    expect(rt.valueAt("k", 2)).toBe(20);
    expect(rt.valueAt("txt", 0)).toBe("07|1.23");
    expect(rt.valueAt("tm", 1)).toBe("2026-09-01 00:01");
    expect(rt.valueAt("lvl", 2)).toBe(2);
  });
  it("statement switch and unknown format letters stay unsupported", async () => {
    const ir = await buildIR(`//@version=6\nindicator("x")\nswitch close\n    1 => 2`);
    expect(ir.diagnostics.some((d) => d.construct === "switch")).toBe(true);
    expect(() => formatTime(0, "EEE", "UTC", 1)).toThrow();
  });
});
