import { Verdict } from "./schema.js";
import { clamp } from "./confidence_engine.js";

export const MODE_THRESHOLDS = {
  A: { decide: 0.90 },
  B: { decide: 0.85 },
  C: { decide: 0.75 },
};

export function applyPolicy({
  mode = "B",
  confidence,
  qualityQ,
  framesCount,
  critical = { hasBailOff: false, hasCrease: false, hasFoot: false },
  direction = { posStronger: true }, // pos=OUT evidence, neg=NOT_OUT evidence
}) {
  // Hard gates — unaffected by mode
  if ((framesCount ?? 0) < 10) return { verdict: Verdict.INCONCLUSIVE, reason: "Too few frames" };
  if ((qualityQ ?? 0.6) < 0.45) return { verdict: Verdict.INCONCLUSIVE, reason: "Low video quality" };

  // Stumping critical signals gate (for stumping analyzer)
  // Phase 1: Only bail-off required for testing
  if (!critical.hasBailOff) return { verdict: Verdict.INCONCLUSIVE, reason: "Missing bail-off moment" };
  // TODO Phase 2: Re-enable crease and foot requirements
  // if (!critical.hasCrease)  return { verdict: Verdict.INCONCLUSIVE, reason: "Missing crease line" };
  // if (!critical.hasFoot)    return { verdict: Verdict.INCONCLUSIVE, reason: "Missing foot position" };

  const th = MODE_THRESHOLDS[mode]?.decide ?? MODE_THRESHOLDS.B.decide;
  if ((confidence ?? 0) < th) return { verdict: Verdict.INCONCLUSIVE, reason: "Below decision threshold" };

  // Decide direction
  return { verdict: direction.posStronger ? Verdict.OUT : Verdict.NOT_OUT, reason: "High confidence decision" };
}