/**
 * Fan DRS Review - vision detectors.
 *
 * Pure functions over grayscale frames { width, height, data: Uint8ClampedArray }
 * (one byte per pixel). No DOM, no canvas: decoding happens in the sidebar, and
 * the Node unit tests feed synthetic frames directly.
 *
 * Every detector abstains rather than guess. An abstention carries a stable
 * reason code that the card turns into "what's missing".
 *
 * Bail-off and cut logic follow the approach of phase1 bail_detection.js
 * (consecutive-frame change, median/MAD spike, cut rejection). The grounding
 * hint borrows the turf-colour idea from phase1 foot_detection.js.
 */
(function attach(root) {
  "use strict";

  const MAD_SCALE = 1.4826; // MAD -> standard deviation for normal data

  // ---------------------------------------------------------------------------
  // Basics
  // ---------------------------------------------------------------------------

  /** RGBA (canvas ImageData layout) -> grayscale frame. */
  function toGray({ width, height, data }) {
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    return { width, height, data: out };
  }

  function clampRect(frame, r) {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const x2 = Math.min(frame.width, Math.ceil(r.x + r.w));
    const y2 = Math.min(frame.height, Math.ceil(r.y + r.h));
    return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
  }

  /** Mean absolute pixel difference, optionally inside a rectangle. */
  function meanAbsDiff(a, b, rect) {
    if (a.width !== b.width || a.height !== b.height) throw new Error("FRAME_SIZE_MISMATCH");
    const r = rect ? clampRect(a, rect) : { x: 0, y: 0, w: a.width, h: a.height };
    if (!r) return 0;
    let sum = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * a.width;
      for (let x = r.x; x < r.x + r.w; x++) sum += Math.abs(a.data[row + x] - b.data[row + x]);
    }
    return sum / (r.w * r.h);
  }

  function median(values) {
    if (values.length === 0) return 0;
    const s = Float64Array.from(values).sort();
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** Robust centre and spread: median and scaled MAD. */
  function robustStats(values) {
    const m = median(values);
    return { median: m, sigma: median(values.map((v) => Math.abs(v - m))) * MAD_SCALE };
  }

  // ---------------------------------------------------------------------------
  // Shot cuts
  // ---------------------------------------------------------------------------

  /**
   * Returns the indices i where a cut happens between frame i-1 and i.
   * A cut is a whole-frame change far above the clip's normal motion.
   */
  function detectCuts(frames, { minAbs = 28, k = 6 } = {}) {
    const diffs = [];
    for (let i = 1; i < frames.length; i++) diffs.push(meanAbsDiff(frames[i - 1], frames[i]));
    const { median: m, sigma } = robustStats(diffs);
    const threshold = Math.max(minAbs, m + k * Math.max(sigma, 1));
    const cuts = new Set();
    diffs.forEach((d, i) => d > threshold && cuts.add(i + 1));
    return cuts;
  }

  // ---------------------------------------------------------------------------
  // Stumps
  // ---------------------------------------------------------------------------

  /**
   * Finds three thin, bright, near-vertical bars with near-equal spacing.
   * Returns { ok: true, rect, columns, top, bottom, confidence } in pixels,
   * or { ok: false, reason }.
   */
  function detectStumps(frame, { minHeightFrac = 0.15, maxSpanFrac = 0.25 } = {}) {
    const { width: w, height: h, data } = frame;
    // Column profile of "brighter than both neighbours two pixels away", which
    // responds to thin bright vertical bars and ignores broad bright areas.
    const ridge = new Float64Array(w);
    for (let y = 0; y < h; y++) {
      for (let x = 2; x < w - 2; x++) if (ridgeLift(frame, x, y, true) > 20) ridge[x] += 1;
    }
    const minRows = Math.max(4, Math.round(h * minHeightFrac));
    const peaks = [];
    for (let x = 1; x < w - 1; x++) {
      if (ridge[x] >= minRows && ridge[x] >= ridge[x - 1] && ridge[x] > ridge[x + 1]) peaks.push(x);
    }
    // Merge peaks closer than 3 px (one wide bar can produce two).
    const columns = [];
    for (const x of peaks) {
      if (columns.length && x - columns[columns.length - 1] < 3) {
        if (ridge[x] > ridge[columns[columns.length - 1]]) columns[columns.length - 1] = x;
      } else columns.push(x);
    }
    let best = null;
    for (let i = 0; i + 2 < columns.length; i++) {
      const [a, b, c] = [columns[i], columns[i + 1], columns[i + 2]];
      const g1 = b - a;
      const g2 = c - b;
      if (c - a > w * maxSpanFrac || Math.min(g1, g2) < 3) continue;
      const evenness = Math.min(g1, g2) / Math.max(g1, g2);
      if (evenness < 0.7) continue;
      const strength = (ridge[a] + ridge[b] + ridge[c]) / (3 * h);
      const score = evenness * strength;
      if (!best || score > best.score) best = { cols: [a, b, c], score, evenness };
    }
    if (!best) return { ok: false, reason: "STUMPS_NOT_FOUND" };

    // Vertical extent: rows where at least two of the three columns are ridges.
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < h; y++) {
      let hits = 0;
      for (const x of best.cols) if (ridgeLift(frame, x, y, true) > 20) hits++;
      if (hits >= 2) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    if (top < 0 || bottom - top < minRows) return { ok: false, reason: "STUMPS_NOT_FOUND" };
    const [a, , c] = best.cols;
    return {
      ok: true,
      columns: best.cols,
      top,
      bottom,
      rect: { x: a - 2, y: top, w: c - a + 5, h: bottom - top + 1 },
      confidence: Math.min(1, best.evenness * Math.min(1, best.score * 4)),
    };
  }

  /** Region where the bails sit: across the stump tops, a little above and below. */
  function bailRegion(stumps, frame) {
    const span = stumps.rect.w;
    const height = stumps.bottom - stumps.top;
    return clampRect(frame, {
      x: stumps.rect.x - span * 0.4,
      y: stumps.top - Math.max(6, height * 0.25),
      w: span * 1.8,
      h: Math.max(8, height * 0.25) + Math.max(3, height * 0.1),
    });
  }

  // ---------------------------------------------------------------------------
  // Bail-off
  // ---------------------------------------------------------------------------

  /**
   * Finds the frame pair where the bail region changes most, provided that the
   * change is an outlier, not on a cut, and persists (the bail stays gone).
   * Returns { ok: true, lastOn, firstOff, confidence } (frame indices) or
   * { ok: false, reason }.
   */
  function detectBailOff(frames, region, { cuts = new Set(), k = 5, minAbs = 6, persistFrames = 2 } = {}) {
    if (!region) return { ok: false, reason: "NO_BAIL_REGION" };
    if (frames.length < 4) return { ok: false, reason: "TOO_FEW_FRAMES" };
    const diffs = [];
    for (let i = 1; i < frames.length; i++) diffs.push(cuts.has(i) ? 0 : meanAbsDiff(frames[i - 1], frames[i], region));
    const { median: m, sigma } = robustStats(diffs.filter((_, i) => !cuts.has(i + 1)));
    const threshold = Math.max(minAbs, m + k * Math.max(sigma, 0.5));

    const ranked = diffs.map((d, i) => ({ d, i: i + 1 })).filter((x) => x.d > threshold).sort((a, b) => b.d - a.d);
    if (ranked.length === 0) return { ok: false, reason: "NO_BAIL_CHANGE" };
    const top = ranked[0];

    // Compare against a baseline a few frames before the spike. A bail coming
    // off never returns to it; a glove passing over the bails does. The glove
    // usually arrives a frame before the bails fly, so the last "on" frame is
    // the last one that still matches the baseline, not simply spike - 1.
    const baseIdx = Math.max(0, top.i - 3);
    if ([...Array(top.i - baseIdx).keys()].some((j) => cuts.has(baseIdx + 1 + j))) return { ok: false, reason: "CUT_BEFORE_BAIL_CHANGE" };
    const base = frames[baseIdx];
    const after = frames.slice(top.i + 1, top.i + 1 + persistFrames);
    if (after.length < persistFrames) return { ok: false, reason: "BAIL_CHANGE_AT_EDGE" };
    for (let j = 0; j < after.length; j++) {
      if (cuts.has(top.i + 1 + j)) return { ok: false, reason: "CUT_AFTER_BAIL_CHANGE" };
      if (meanAbsDiff(base, after[j], region) < top.d * 0.5) return { ok: false, reason: "BAIL_CHANGE_NOT_SUSTAINED" };
    }
    // Likewise the first "off" frame is the first that already matches the
    // settled scene after the event (a glove frame shows neither state).
    const settled = after[after.length - 1];
    let firstOff = top.i;
    while (firstOff < top.i + persistFrames && meanAbsDiff(frames[firstOff], settled, region) > threshold) firstOff++;
    let lastOn = baseIdx;
    for (let j = top.i - 1; j > baseIdx; j--) {
      if (meanAbsDiff(base, frames[j], region) <= threshold) {
        lastOn = j;
        break;
      }
    }

    // Ambiguity: a competing spike elsewhere of similar size.
    const rival = ranked.find((x) => Math.abs(x.i - top.i) > 2);
    if (rival && rival.d > top.d * 0.8) return { ok: false, reason: "BAIL_CHANGE_AMBIGUOUS" };

    const margin = (top.d - threshold) / top.d;
    const separation = rival ? 1 - rival.d / top.d : 1;
    return { ok: true, lastOn, firstOff, confidence: round2(Math.min(1, 0.5 + 0.3 * margin + 0.2 * separation)) };
  }

  // ---------------------------------------------------------------------------
  // Crease line
  // ---------------------------------------------------------------------------

  /**
   * Strongest straight bright line in the frame, at any angle within ±80° of
   * vertical, ignoring an excluded rectangle (the stumps). Hough voting over
   * ridge pixels (brighter than neighbours across the line direction).
   * Returns { ok: true, line: {x1,y1,x2,y2} (pixels), confidence } or { ok: false, reason }.
   */
  function detectCrease(frame, { exclude = null, minRatio = 1.3, minVotesFrac = 0.25 } = {}) {
    const { width: w, height: h, data } = frame;
    const ex = exclude ? clampRect(frame, { x: exclude.x - 4, y: exclude.y - 4, w: exclude.w + 8, h: exclude.h + 8 }) : null;
    const pts = [];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (ex && x >= ex.x && x < ex.x + ex.w && y >= ex.y && y < ex.y + ex.h) continue;
        if (ridgeLift(frame, x, y, true) > 25 || ridgeLift(frame, x, y, false) > 25) pts.push(x, y);
      }
    }
    if (pts.length < 20) return { ok: false, reason: "CREASE_NOT_FOUND" };

    // Line: x*cos(t) + y*sin(t) = rho, t = angle of the normal. A near-vertical
    // line has a near-horizontal normal, so normals in [-80°, 80°] from the x
    // axis cover lines within ±80° of vertical.
    const angles = [];
    for (let deg = -80; deg <= 80; deg += 2) angles.push((deg * Math.PI) / 180);
    const diag = Math.ceil(Math.hypot(w, h));
    const acc = new Uint32Array(angles.length * (2 * diag + 1));
    for (let p = 0; p < pts.length; p += 2) {
      const x = pts[p];
      const y = pts[p + 1];
      for (let a = 0; a < angles.length; a++) {
        const rho = Math.round(x * Math.cos(angles[a]) + y * Math.sin(angles[a])) + diag;
        acc[a * (2 * diag + 1) + rho]++;
      }
    }
    let best = { v: 0 };
    for (let i = 0; i < acc.length; i++) if (acc[i] > best.v) best = { v: acc[i], i };
    const bestA = Math.floor(best.i / (2 * diag + 1));
    const bestR = (best.i % (2 * diag + 1)) - diag;
    // Runner-up: best cell that is not the same line (different angle or offset).
    let second = 0;
    for (let i = 0; i < acc.length; i++) {
      const a = Math.floor(i / (2 * diag + 1));
      const r = (i % (2 * diag + 1)) - diag;
      // A thick line also scores at nearby angles and offsets; that's the same
      // line, not a rival (5 steps = 10 degrees, 10 px).
      if (Math.abs(a - bestA) <= 5 && Math.abs(r - bestR) <= 10) continue;
      if (acc[i] > second) second = acc[i];
    }
    const span = Math.min(w, h);
    if (best.v < span * minVotesFrac) return { ok: false, reason: "CREASE_TOO_SHORT" };
    const ratio = best.v / Math.max(1, second);
    if (ratio < minRatio) return { ok: false, reason: "CREASE_AMBIGUOUS" };

    const line = lineInFrame(angles[bestA], bestR, w, h);
    if (!line) return { ok: false, reason: "CREASE_NOT_FOUND" };
    return { ok: true, line, confidence: round2(Math.min(1, (ratio - 1) / 1.5)) };
  }

  /** Endpoints of x*cos(t)+y*sin(t)=rho clipped to the frame. */
  function lineInFrame(t, rho, w, h) {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const hits = [];
    if (Math.abs(c) > 1e-9) for (const y of [0, h - 1]) {
      const x = (rho - y * s) / c;
      if (x >= 0 && x <= w - 1) hits.push({ x, y });
    }
    if (Math.abs(s) > 1e-9) for (const x of [0, w - 1]) {
      const y = (rho - x * c) / s;
      if (y >= 0 && y <= h - 1) hits.push({ x, y });
    }
    if (hits.length < 2) return null;
    hits.sort((p, q) => p.y - q.y || p.x - q.x);
    const [p1, p2] = [hits[0], hits[hits.length - 1]];
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }

  /** Signed side of point (x, y) relative to the directed line; 0 on the line. */
  function sideOf(line, x, y) {
    return Math.sign((line.x2 - line.x1) * (y - line.y1) - (line.y2 - line.y1) * (x - line.x1));
  }

  // ---------------------------------------------------------------------------
  // Grounding hint
  // ---------------------------------------------------------------------------

  /**
   * Compares "not turf" mass on each side of the crease, low in the frame and
   * close to the line. The batter's ground is the side containing the stumps.
   * This is a hint for the viewer: confidence is capped at 0.6 and the verdict
   * rule never uses it alone.
   * Returns { value: 'behind' | 'not-behind' | 'unknown', confidence, reason? }.
   */
  function groundingHint(frame, crease, stumps, { band = 0.12, minMass = 30 } = {}) {
    if (!crease) return { value: "unknown", confidence: 0, reason: "NO_CREASE" };
    if (!stumps) return { value: "unknown", confidence: 0, reason: "NO_STUMPS" };
    const { width: w, height: h, data } = frame;
    const stumpsSide = sideOf(crease, stumps.rect.x + stumps.rect.w / 2, stumps.bottom);
    if (stumpsSide === 0) return { value: "unknown", confidence: 0, reason: "STUMPS_ON_CREASE" };
    const len = Math.hypot(crease.x2 - crease.x1, crease.y2 - crease.y1);
    const maxDist = band * w;
    const y0 = Math.floor(h * 0.5);

    const turf = [];
    for (let y = y0; y < h; y += 3) for (let x = 0; x < w; x += 3) turf.push(data[y * w + x]);
    const turfLevel = median(turf);

    let behind = 0;
    let beyond = 0;
    const sx = stumps.rect.x - 4;
    const sx2 = stumps.rect.x + stumps.rect.w + 4;
    for (let y = y0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= sx && x <= sx2 && y <= stumps.bottom + 2) continue; // the stumps themselves
        const dist = Math.abs((crease.x2 - crease.x1) * (y - crease.y1) - (crease.y2 - crease.y1) * (x - crease.x1)) / len;
        if (dist < 3 || dist > maxDist) continue; // skip the painted line itself
        if (Math.abs(data[y * w + x] - turfLevel) < 40) continue;
        if (sideOf(crease, x, y) === stumpsSide) behind++;
        else beyond++;
      }
    }
    const total = behind + beyond;
    if (total < minMass) return { value: "unknown", confidence: 0, reason: "NOTHING_NEAR_CREASE" };
    const share = Math.max(behind, beyond) / total;
    if (share < 0.7) return { value: "unknown", confidence: round2(share * 0.6), reason: "STRADDLING_CREASE" };
    return { value: behind > beyond ? "behind" : "not-behind", confidence: round2(Math.min(0.6, share * 0.6)) };
  }

  // Bars from 1 to ~6 px wide: compare with neighbours at several distances.
  const RIDGE_STEPS = [2, 3, 4];

  /** How much brighter pixel (x, y) is than both neighbours across a bar, at the best scale. */
  function ridgeLift(frame, x, y, horizontal) {
    const { width: w, height: h, data } = frame;
    const c = data[y * w + x];
    let best = -255;
    for (const d of RIDGE_STEPS) {
      let a;
      let b;
      if (horizontal) {
        if (x - d < 0 || x + d >= w) continue;
        a = data[y * w + x - d];
        b = data[y * w + x + d];
      } else {
        if (y - d < 0 || y + d >= h) continue;
        a = data[(y - d) * w + x];
        b = data[(y + d) * w + x];
      }
      const lift = Math.min(c - a, c - b);
      if (lift > best) best = lift;
    }
    return best;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  const api = Object.freeze({
    toGray,
    meanAbsDiff,
    median,
    robustStats,
    detectCuts,
    detectStumps,
    bailRegion,
    detectBailOff,
    detectCrease,
    lineInFrame,
    sideOf,
    groundingHint,
  });

  root.FanDRSVision = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
