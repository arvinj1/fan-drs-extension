export function clamp(x, lo=0, hi=1){ return Math.max(lo, Math.min(hi, x)); }

export function computeScores(evidenceList = [], quality = { Q: 0.6 }) {
  const Q = clamp(quality.Q ?? 0.6);

  let pos = 0, neg = 0, strength = 0;

  for (const e of evidenceList) {
    const rel = clamp(e.reliability ?? 0.5);
    const q = clamp(e.quality ?? Q);
    const w = e.weight ?? 0;

    const contrib = Math.abs(w) * rel * q;
    strength += contrib;

    if (w >= 0) pos += w * rel * q;
    else neg += (-w) * rel * q;
  }

  const S = clamp(strength);
  const total = pos + neg + 1e-6;
  const A = clamp(1 - (Math.min(pos, neg) / total) * 2); // 1=clean, 0=contradictory

  return { Q, S, A, pos, neg };
}

export function computeConfidence({ evidenceList, quality, penalty = 1.0 }) {
  const { Q, S, A } = computeScores(evidenceList, quality);
  const P = clamp(penalty);
  return clamp(S * A * Q * P);
}