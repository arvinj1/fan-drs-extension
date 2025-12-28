import { Verdict } from "./schema.js";
import { clamp } from "./confidence_engine.js";

export const MODE_THRESHOLDS = {
  A: { out: 0.88, inconclusive: 0.65, label: "ULTRA-CONSERVATIVE" },
  B: { out: 0.80, inconclusive: 0.55, label: "CONSERVATIVE" },  // default
  C: { out: 0.70, inconclusive: 0.45, label: "AGGRESSIVE" },
  D: { out: 0.60, inconclusive: 0.40, label: "EXPERIMENTAL" }
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

  // 3-way threshold decision
  const thresholds = MODE_THRESHOLDS[mode] ?? MODE_THRESHOLDS.B;
  const conf = confidence ?? 0;
  
  // High confidence → definitive verdict
  if (conf >= thresholds.out) {
    return { verdict: direction.posStronger ? Verdict.OUT : Verdict.NOT_OUT, reason: "High confidence decision" };
  }
  
  // Low confidence → opposite verdict
  if (conf <= (1 - thresholds.out)) {
    return { verdict: direction.posStronger ? Verdict.NOT_OUT : Verdict.OUT, reason: "High confidence opposite" };
  }
  
  // Medium confidence → inconclusive
  return { verdict: Verdict.INCONCLUSIVE, reason: "Confidence in inconclusive range" };
}