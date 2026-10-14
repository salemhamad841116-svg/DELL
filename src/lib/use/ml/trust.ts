// Trust gate: decides whether a calibrated prediction may become a directional signal.
export type TrustInput = {
  probs: { UP: number; DOWN: number; NEUTRAL: number };
  oofSamples: number;
  oofAccuracy: number;
  baselineAccuracy: number;
  ece: number;
  regimeMatches: boolean;
  minConfidence?: number | undefined; // default 0.55
};
export type TrustResult = { trusted: boolean; reasons: string[] };

export function trustGate(t: TrustInput): TrustResult {
  const min = t.minConfidence ?? 0.55;
  const reasons: string[] = [];
  const top = Math.max(t.probs.UP, t.probs.DOWN);
  if (top < min) reasons.push(`LOW_CONFIDENCE ${(top * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
  if (Math.abs(t.probs.UP - t.probs.DOWN) < 0.1) reasons.push("UP/DOWN gap < 10pp");
  if (t.oofSamples < 300) reasons.push(`INSUFFICIENT_SAMPLES ${t.oofSamples} < 300`);
  if (t.oofAccuracy <= t.baselineAccuracy) reasons.push(`NO_EDGE OOF ${(t.oofAccuracy * 100).toFixed(1)}% ≤ baseline ${(t.baselineAccuracy * 100).toFixed(1)}%`);
  if (t.ece > 0.1) reasons.push(`MISCALIBRATED ECE ${t.ece.toFixed(3)} > 0.10`);
  if (!t.regimeMatches) reasons.push("REGIME_MISMATCH");
  return { trusted: reasons.length === 0, reasons };
}
