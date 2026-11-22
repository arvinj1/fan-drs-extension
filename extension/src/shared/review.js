/**
 * Fan DRS Review - review policy and evidence packet.
 *
 * Pure decisions shared by the content script and the sidebar:
 *   - does this video look like cricket, and should capture run?
 *   - was that pause a "replay" gesture?
 *   - is a bail-off bracket valid evidence?
 *   - what's the verdict, and why?
 *   - the evidence packet (schema fan-drs.evidence/1), the record a future
 *     assistant answers from.
 * See docs/SPEC.md sections 4 and 5.
 */
(function attach(root) {
  "use strict";

  const PACKET_SCHEMA = "fan-drs.evidence/1";

  const LIMITS = Object.freeze({
    reviewWindowSec: 12,
    reviewMaxFrames: 48,
    bracketMaxGapMs: 400,
    replaySeekMinSec: 2,
    replayPauseWithinMs: 15000,
  });

  // ---------------------------------------------------------------------------
  // Cricket detection and capture policy
  // ---------------------------------------------------------------------------

  // Strong terms identify cricket on their own; weak terms need a second signal.
  const STRONG = ["cricket", "wicket", "wickets", "stumping", "stumped", "drs", "lbw", "ipl", "bbl", "psl", "ashes", "run out", "run-out", "third umpire", "bcci", "icc", "odi", "t20", "t20i", "test match", "cricbuzz", "espncricinfo"];
  const WEAK = ["test", "bowled", "bowler", "batter", "batsman", "umpire", "over", "innings", "century", "duck", "sixes", "boundary", "keeper"];

  function wordHits(text, terms) {
    const lower = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9\- ]+/g, " ")} `;
    return terms.filter((t) => lower.includes(` ${t} `));
  }

  /**
   * Scores title (x2), channel and description (first 500 chars).
   * Returns { isCricket, score, matched }.
   */
  function cricketScore({ title = "", channel = "", description = "" } = {}) {
    const desc = String(description).slice(0, 500);
    const strong = [...wordHits(title, STRONG).map((t) => ({ t, w: 2 })), ...wordHits(channel, STRONG).map((t) => ({ t, w: 2 })), ...wordHits(desc, STRONG).map((t) => ({ t, w: 1 }))];
    const weak = [...wordHits(title, WEAK), ...wordHits(desc, WEAK)];
    const score = strong.reduce((s, x) => s + x.w, 0) + Math.min(2, weak.length) * 0.5;
    const matched = [...new Set([...strong.map((x) => x.t), ...weak])];
    return { isCricket: strong.length > 0 && score >= 2, score, matched };
  }

  /**
   * Decides whether capture runs. Precedence: this video's toggle, then the
   * channel preference, then cricket detection.
   * Returns { on, reason } with reason in VIDEO_ON | VIDEO_OFF | CHANNEL_ON |
   * CHANNEL_OFF | CRICKET | NOT_CRICKET.
   */
  function decideCapture({ videoOverride = null, channelPref = null, cricket = false } = {}) {
    if (videoOverride === "on" || videoOverride === "off") return { on: videoOverride === "on", reason: videoOverride === "on" ? "VIDEO_ON" : "VIDEO_OFF" };
    if (channelPref === "on" || channelPref === "off") return { on: channelPref === "on", reason: channelPref === "on" ? "CHANNEL_ON" : "CHANNEL_OFF" };
    return cricket ? { on: true, reason: "CRICKET" } : { on: false, reason: "NOT_CRICKET" };
  }

  /**
   * Tracks seeks and decides whether a pause is the "replay" gesture: a pause
   * soon after seeking back at least a couple of seconds.
   */
  function createReplayDetector({ now = () => Date.now(), seekMinSec = LIMITS.replaySeekMinSec, withinMs = LIMITS.replayPauseWithinMs } = {}) {
    let lastTime = null;
    let backSeekAt = null;
    return {
      /** Call on timeupdate with the playing position. */
      onTime(t) {
        if (Number.isFinite(t)) lastTime = t;
      },
      /** Call on seeking with the new target time. */
      onSeek(target) {
        if (Number.isFinite(target) && lastTime !== null && lastTime - target >= seekMinSec) backSeekAt = now();
        if (Number.isFinite(target)) lastTime = target;
      },
      /** Call on pause; true at most once per back-seek. */
      onPause() {
        const hit = backSeekAt !== null && now() - backSeekAt <= withinMs;
        if (hit) backSeekAt = null;
        return hit;
      },
      reset() {
        lastTime = null;
        backSeekAt = null;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Evidence and verdict
  // ---------------------------------------------------------------------------

  /**
   * Checks a bracket (indices into frames) against the cut set.
   * Returns { valid, gapMs, sameShot, problems[] } with stable problem codes.
   */
  function validateBracket(frames, lastOn, firstOff, cuts = new Set()) {
    const problems = [];
    if (!Number.isInteger(lastOn) || !Number.isInteger(firstOff) || !frames[lastOn] || !frames[firstOff]) {
      return { valid: false, gapMs: null, sameShot: null, problems: ["NO_BRACKET"] };
    }
    if (firstOff <= lastOn) problems.push("BRACKET_ORDER");
    let sameShot = true;
    for (let i = lastOn + 1; i <= firstOff; i++) if (cuts.has(i)) sameShot = false;
    if (!sameShot) problems.push("CUT_IN_BRACKET");
    const gapMs = Math.round((frames[firstOff].t - frames[lastOn].t) * 1000);
    if (gapMs > LIMITS.bracketMaxGapMs) problems.push("BRACKET_TOO_WIDE");
    return { valid: problems.length === 0, gapMs, sameShot, problems };
  }

  const ASSUMPTIONS = Object.freeze([
    "The delivery was legal (a no-ball can’t be ruled out from these frames).",
    "The keeper put the wicket down with the ball in hand or with the ball.",
    "The camera angle shows the popping crease at the point of contact.",
  ]);

  const REASON_TEXT = Object.freeze({
    NO_BRACKET: "The moment the wicket broke wasn’t found. Pick the first frame where a bail is off.",
    BRACKET_ORDER: "The bail-off frame must come after the last bail-on frame.",
    CUT_IN_BRACKET: "There’s a camera cut between the bail-on and bail-off frames, so they don’t show one continuous moment.",
    BRACKET_TOO_WIDE: "The bail-on and bail-off frames are too far apart to pin down the moment the wicket broke.",
    GROUNDING_UNKNOWN: "Whether bat or body was grounded behind the crease at that moment hasn’t been confirmed.",
    GROUNDING_NOT_VISIBLE: "The bat and feet can’t be seen clearly at the moment the wicket broke.",
  });

  /**
   * The verdict rule (SPEC 4.5). grounded is the viewer's answer:
   * 'behind' | 'not-behind' | 'cant-see' | null.
   */
  function decideVerdict(bracketCheck, grounded) {
    const codes = [...bracketCheck.problems];
    if (grounded === "cant-see") codes.push("GROUNDING_NOT_VISIBLE");
    else if (grounded !== "behind" && grounded !== "not-behind") codes.push("GROUNDING_UNKNOWN");

    if (codes.length === 0) {
      const out = grounded === "not-behind";
      return {
        call: out ? "OUT" : "NOT_OUT",
        codes: [],
        reasons: [
          `The wicket broke between two frames ${bracketCheck.gapMs} ms apart in the same shot.`,
          out ? "At that moment neither bat nor body was grounded behind the popping crease." : "At that moment bat or body was grounded behind the popping crease.",
        ],
        assumptions: ASSUMPTIONS.slice(),
      };
    }
    return { call: "INCONCLUSIVE", codes, reasons: codes.map((c) => REASON_TEXT[c]), assumptions: ASSUMPTIONS.slice() };
  }

  const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
  const normPoint = (v, size) => round3(v / size);

  /**
   * Builds the evidence packet. Frame images are never included.
   * frames: [{ id, t }]; bracket: { lastOn, firstOff, source, confidence } indices;
   * crease: { line (pixels), source, width, height } | null.
   */
  function buildEvidencePacket({ video, window, trigger, capture, frames, bracket, bracketCheck, crease, grounded, hint, verdict, now = new Date() }) {
    const at = (i) => (Number.isInteger(i) && frames[i] ? { id: frames[i].id, t: round3(frames[i].t) } : null);
    return {
      schema: PACKET_SCHEMA,
      generatedAt: now.toISOString(),
      video: { id: video.id, title: video.title || "", channel: video.channel || "" },
      window: { t0: round3(window.t0), t1: round3(window.t1), trigger },
      capture: { frames: frames.length, coverage: round3(capture.coverage), gaps: capture.gaps.map((g) => ({ from: round3(g.from), to: round3(g.to) })) },
      frames: frames.map((f) => ({ id: f.id, t: round3(f.t) })),
      bracket: bracket
        ? { lastOn: at(bracket.lastOn), firstOff: at(bracket.firstOff), gapMs: bracketCheck.gapMs, sameShot: bracketCheck.sameShot, source: bracket.source, confidence: bracket.confidence ?? null }
        : null,
      crease: crease
        ? { line: { x1: normPoint(crease.line.x1, crease.width), y1: normPoint(crease.line.y1, crease.height), x2: normPoint(crease.line.x2, crease.width), y2: normPoint(crease.line.y2, crease.height) }, source: crease.source }
        : null,
      grounded: { value: grounded || "unknown", source: grounded ? "viewer" : "none", hint: hint ? { value: hint.value, confidence: hint.confidence } : null },
      verdict: { call: verdict.call, reasons: verdict.reasons, assumptions: verdict.assumptions },
    };
  }

  const api = Object.freeze({
    PACKET_SCHEMA,
    LIMITS,
    cricketScore,
    decideCapture,
    createReplayDetector,
    validateBracket,
    decideVerdict,
    buildEvidencePacket,
    REASON_TEXT,
  });

  root.FanDRSReview = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
