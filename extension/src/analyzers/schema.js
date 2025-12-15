export const Verdict = {
  OUT: "OUT",
  NOT_OUT: "NOT_OUT",
  INCONCLUSIVE: "INCONCLUSIVE",
};

export function evidence(id, weight, reliability, quality, notes, debug) {
  return { id, weight, reliability, quality, notes, debug };
}