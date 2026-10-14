import { it, expect } from "vitest";
import { buildIR } from "@/lib/use/strategy/ir";
import { fxDayBucket } from "@/lib/use/strategy/executor";
it("fast", async () => {
  const code = `//@version=5\nindicator("x", overlay=true)\n[a, d] = ta.supertrend(2.0, 10)\nh = request.security(syminfo.tickerid, "D", high[1], lookahead=barmerge.lookahead_on)\nplot(a)\nplot(h)`;
  const ir = await buildIR(code);
  expect(ir.diagnostics).toEqual([]);
  const [s] = fxDayBucket(Date.UTC(2026, 8, 30, 12)); expect(new Date(s).toISOString()).toBe("2026-09-29T21:00:00.000Z");
  const bad = await buildIR(`//@version=5\nindicator("x")\nh = request.security(syminfo.tickerid, "D", high, lookahead=barmerge.lookahead_on)\nplot(h)`);
  expect(bad.diagnostics.length).toBe(1);
});
