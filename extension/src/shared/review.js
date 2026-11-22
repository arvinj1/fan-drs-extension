/**
 * Fan DRS Review - review policy and evidence packet.
 *
 * Pure decisions shared by the content script and the sidebar:
 *   - does this video look like cricket, and should capture run?
 *   - was that pause a "replay" gesture?
 *   - is a bail-off bracket valid evidence?
 *   - what did the viewer confirm, and what stays unknown? (no OUT / NOT OUT in the beta)
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

  // Terms that only mean cricket. One in the title or channel is enough.
  const DEFINITE = ["stumping", "stumped", "lbw", "ipl", "bbl", "t20", "t20i", "t20is", "wicketkeeper", "wicket-keeper", "third umpire", "test match", "cricbuzz", "espncricinfo", "bcci"];
  // Terms that also mean something else (Cricket Wireless, Ashes of Creation, DRS in F1,
  // ICC colour profiles, PSL the console, "we ran out of time"). Two distinct signals needed.
  const AMBIGUOUS = ["cricket", "wicket", "wickets", "drs", "ashes", "icc", "psl", "odi", "odis", "run out", "run-out", "innings", "bowled", "umpire", "century", "duck", "sixes", "boundary"];
  // Franchise codes are cricket-specific; national team names are not (hockey, football).
  const FRANCHISES = ["csk", "mi", "rcb", "kkr", "srh", "dc", "pbks", "rr", "lsg", "gt"];
  const NATIONS = ["ind", "india", "aus", "australia", "eng", "england", "pak", "pakistan", "sa", "rsa", "south africa", "nz", "new zealand", "sl", "sri lanka", "wi", "west indies", "ban", "bangladesh", "afg", "afghanistan", "zim", "zimbabwe", "ire", "ireland"];

  /** Lower-case words with letters and digits split ("IPL2025" -> "ipl 2025"), padded for whole-word matching. */
  function normalize(text) {
    return ` ${String(text || "")
      .toLowerCase()
      .replace(/([a-z])(\d)/g, "$1 $2")
      .replace(/(\d)([a-z])/g, "$1 $2")
      .replace(/[^a-z0-9\- ]+/g, " ")
      .replace(/\s+/g, " ")} `;
  }

  const hits = (norm, terms) => terms.filter((t) => norm.includes(` ${t} `));

  /** "<team> v|vs <team>" in a normalized string. Returns "franchise" | "nation" | null. */
  function fixture(norm) {
    const f = FRANCHISES.join("|");
    const n = NATIONS.join("|");
    if (new RegExp(` (${f}) (v|vs) (${f}) `).test(norm)) return "franchise";
    if (new RegExp(` (${n}) (v|vs) (${n}) `).test(norm)) return "nation";
    return null;
  }

  /**
   * Errs toward off: a missed cricket video costs one click, a false positive
   * costs capture on a video that isn't cricket.
   * Signals: definite terms (title or channel), ambiguous terms (title,
   * description; channel only counts as half), fixtures, and "Test" with
   * "Day N". Returns { isCricket, score, matched }.
   */
  function cricketScore({ title = "", channel = "", description = "" } = {}) {
    const t = normalize(title);
    const c = normalize(channel);
    const d = normalize(String(description).slice(0, 500));
    const definite = [...hits(t, DEFINITE), ...hits(c, DEFINITE)];
    const fx = fixture(t) || fixture(d);
    const ambiguous = new Set([...hits(t, AMBIGUOUS), ...hits(d, AMBIGUOUS)]);
    const channelAmbiguous = hits(c, AMBIGUOUS).filter((x) => !ambiguous.has(x));
    let score = (definite.length || fx === "franchise" ? 2 : 0) + ambiguous.size + channelAmbiguous.length * 0.5;
    if (fx === "nation") score += 1;
    if (/ test /.test(t) && / day [1-5] /.test(t)) score += 1;
    const matched = [...new Set([...definite, ...ambiguous, ...channelAmbiguous, ...(fx ? [`${fx} fixture`] : [])])];
    return { isCricket: score >= 2, score, matched };
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
    let backSeek = null; // { at, from }
    return {
      /** Call on timeupdate with the playing position. */
      onTime(t) {
        if (Number.isFinite(t)) lastTime = t;
      },
      /** Call on seeking with the new target time. */
      onSeek(target) {
        if (Number.isFinite(target) && lastTime !== null && lastTime - target >= seekMinSec) backSeek = { at: now(), from: lastTime };
        if (Number.isFinite(target)) lastTime = target;
      },
      /**
       * Call on pause. Returns null, or { from } (the position the viewer seeked
       * back from) at most once per back-seek. Reviewing up to `from` covers the
       * moment they went back to see, even if they paused before reaching it.
       */
      onPause() {
        const hit = backSeek !== null && now() - backSeek.at <= withinMs ? { from: backSeek.from } : null;
        backSeek = null;
        return hit;
      },
      reset() {
        lastTime = null;
        backSeek = null;
      },
    };
  }

  /** The review window for a trigger at `now`; a replay pause extends it to where the viewer came from. */
  function reviewWindow(now, replayFrom = null) {
    const t1 = Math.max(now, Number.isFinite(replayFrom) ? replayFrom : now);
    return { t0: Math.max(0, t1 - LIMITS.reviewWindowSec), t1 };
  }

  // ---------------------------------------------------------------------------
  // Evidence and finding
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

  // What a frame strip can never settle about a stumping (MCC Laws 29, 30, 39).
  // Always reported, whatever the viewer confirms.
  const NOT_ESTABLISHED = Object.freeze([
    "Whether the delivery was legal (a no-ball can’t be ruled out from these frames).",
    "Whether the keeper put the wicket down fairly, with the ball, and without another fielder involved.",
    "Whether the batter was attempting a run (that would make it a run out, not a stumping).",
  ]);

  const OPEN_TEXT = Object.freeze({
    NO_BRACKET: "The moment the wicket broke hasn’t been found. Mark the last frame with the bails on and the first with a bail off.",
    UNCONFIRMED_BRACKET: "A possible bail-off was detected but hasn’t been confirmed. Something over the bails (a glove, say) can look the same, so check both frames.",
    BRACKET_ORDER: "The bail-off frame must come after the last bail-on frame.",
    CUT_IN_BRACKET: "There’s a camera cut between the bail-on and bail-off frames, so they don’t show one continuous moment.",
    BRACKET_TOO_WIDE: "The bail-on and bail-off frames are too far apart to pin down the moment the wicket broke.",
    NO_CREASE: "The popping crease hasn’t been located, so being in or out of ground can’t be judged.",
    GROUNDING_UNKNOWN: "Whether bat or body was grounded behind the crease in the bail-on and bail-off frames hasn’t been answered.",
    GROUNDING_NOT_VISIBLE: "The two frames either disagree about bat and feet or don’t show them clearly.",
  });

  const defaultTime = (t) => `${t.toFixed(2)} s`;

  /**
   * The beta finding (SPEC 4.5). It is always INCONCLUSIVE: the extension
   * reports what the viewer confirmed and what remains unknown, and never
   * claims OUT or NOT OUT. A stumping also needs facts the frames can't give
   * (NOT_ESTABLISHED), and two samples can't show grounding at the instant
   * between them.
   *
   * bracket: { lastOn, firstOff, source, confirmed } (indices) | null
   * times: frame media times; grounded: viewer's answer about BOTH bracket
   * frames ('behind' | 'not-behind' | 'cant-see' | null).
   * Returns { call, observations[], open: [{ code, text }], notEstablished[] }.
   */
  function decideFinding(bracketCheck, { bracket = null, times = [], creaseSource = null, grounded = null, formatTime = defaultTime } = {}) {
    const observations = [];
    const open = [];
    const addOpen = (code) => open.push({ code, text: OPEN_TEXT[code] });

    const confirmed = Boolean(bracket && bracket.confirmed);
    bracketCheck.problems.forEach(addOpen);
    if (bracket && !confirmed) addOpen("UNCONFIRMED_BRACKET");
    if (confirmed && bracketCheck.valid) {
      const by = bracket.source === "viewer" ? "You marked" : "You confirmed";
      observations.push(`${by} the bails on at ${formatTime(times[bracket.lastOn])} and a bail off at ${formatTime(times[bracket.firstOff])}, ${bracketCheck.gapMs} ms apart in the same shot.`);
    }

    if (creaseSource) observations.push(creaseSource === "viewer" ? "You set the popping crease line." : "A crease line was detected automatically; you haven’t checked or adjusted it.");
    else addOpen("NO_CREASE");

    if (grounded === "behind" || grounded === "not-behind") {
      observations.push(grounded === "behind" ? "You judged bat or body grounded behind the crease in both frames." : "You judged neither bat nor body grounded behind the crease in either frame.");
    } else if (grounded === "cant-see") addOpen("GROUNDING_NOT_VISIBLE");
    else addOpen("GROUNDING_UNKNOWN");

    const notEstablished = [...NOT_ESTABLISHED];
    if (confirmed && bracketCheck.valid) notEstablished.push(`Grounding at the exact instant the wicket broke, somewhere in the ${bracketCheck.gapMs} ms between the two frames.`);
    else notEstablished.push("Grounding at the exact instant the wicket broke.");

    return { call: "INCONCLUSIVE", observations, open, notEstablished };
  }

  const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
  const normPoint = (v, size) => round3(v / size);

  /**
   * Builds the evidence packet. Frame images are never included.
   * frames: [{ id, t }]; bracket: { lastOn, firstOff, source, confidence, confirmed } indices;
   * crease: { line (pixels), source, width, height } | null.
   */
  function buildEvidencePacket({ video, window, trigger, capture, frames, bracket, bracketCheck, crease, grounded, hint, finding, now = new Date() }) {
    const at = (i) => (Number.isInteger(i) && frames[i] ? { id: frames[i].id, t: round3(frames[i].t) } : null);
    return {
      schema: PACKET_SCHEMA,
      generatedAt: now.toISOString(),
      video: { id: video.id, title: video.title || "", channel: video.channel || "" },
      window: { t0: round3(window.t0), t1: round3(window.t1), trigger },
      capture: { frames: frames.length, coverage: round3(capture.coverage), gaps: capture.gaps.map((g) => ({ from: round3(g.from), to: round3(g.to) })) },
      frames: frames.map((f) => ({ id: f.id, t: round3(f.t) })),
      bracket: bracket
        ? { lastOn: at(bracket.lastOn), firstOff: at(bracket.firstOff), gapMs: bracketCheck.gapMs, sameShot: bracketCheck.sameShot, source: bracket.source, confidence: bracket.confidence ?? null, confirmed: Boolean(bracket.confirmed) }
        : null,
      crease: crease
        ? { line: { x1: normPoint(crease.line.x1, crease.width), y1: normPoint(crease.line.y1, crease.height), x2: normPoint(crease.line.x2, crease.width), y2: normPoint(crease.line.y2, crease.height) }, source: crease.source }
        : null,
      grounded: { value: grounded || "unknown", source: grounded ? "viewer" : "none", frames: bracket ? [at(bracket.lastOn), at(bracket.firstOff)].filter(Boolean).map((f) => f.id) : [], hint: hint ? { value: hint.value, confidence: hint.confidence } : null },
      finding: { call: finding.call, observations: finding.observations, open: finding.open.map((o) => o.code), notEstablished: finding.notEstablished },
    };
  }

  const api = Object.freeze({
    PACKET_SCHEMA,
    LIMITS,
    cricketScore,
    decideCapture,
    createReplayDetector,
    reviewWindow,
    validateBracket,
    decideFinding,
    buildEvidencePacket,
    OPEN_TEXT,
  });

  root.FanDRSReview = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
