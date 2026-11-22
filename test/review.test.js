"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../extension/src/shared/vision.js");
const R = require("../extension/src/shared/review.js");

// ---------------------------------------------------------------------------
// Synthetic side-on stumping scene: turf, three stumps, a bail on top, a
// near-vertical crease line in front of the stumps, and a batter's foot.
// ---------------------------------------------------------------------------

const W = 160;
const H = 90;

function scene({ bail = true, footX = 60, glove = false, noise = 0, seed = 1, bright = 0, creaseX = 80, creaseTilt = 0, barW = 2, dx = 0 } = {}) {
  const data = new Uint8ClampedArray(W * H);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  for (let i = 0; i < data.length; i++) data[i] = 90 + bright + noise * rnd();
  const rect = (x0, y, w, h, v) => {
    const x = x0 + dx; // camera shift moves everything drawn
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && xx < W && yy >= 0 && yy < H) data[yy * W + xx] = v + bright; // exposure lifts everything
  };
  // crease: bright 2 px line from (creaseX, 28) to (creaseX + creaseTilt, 89)
  for (let y = 28; y < H; y++) {
    const x = Math.round(creaseX + (creaseTilt * (y - 28)) / (H - 28));
    rect(x, y, barW, 1, 235);
  }
  for (const x of [100, 106, 112]) rect(x, 40, barW, 36, 230); // stumps
  if (bail) rect(99, 37, 16, 2, 225);
  else rect(118, 30, 6, 2, 225); // bail flying off to the right
  if (glove) rect(97, 34, 20, 6, 40); // a glove passing over the bails
  rect(footX, 70, 14, 10, 30); // foot (dark)
  return { width: W, height: H, data };
}

function clip(n, offAt, opts = {}) {
  return Array.from({ length: n }, (_, i) => scene({ ...opts, bail: i < offAt, seed: i + 1 }));
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

test("toGray weights RGB like luma", () => {
  const g = V.toGray({ width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]) });
  assert.equal(g.data[0], 255);
  assert.ok(g.data[1] > 70 && g.data[1] < 80);
});

test("meanAbsDiff respects the rectangle and rejects size mismatches", () => {
  const a = scene();
  const b = scene({ bail: false });
  assert.ok(V.meanAbsDiff(a, b, { x: 95, y: 30, w: 30, h: 12 }) > V.meanAbsDiff(a, b));
  assert.equal(V.meanAbsDiff(a, a), 0);
  assert.throws(() => V.meanAbsDiff(a, { width: 1, height: 1, data: new Uint8ClampedArray(1) }), /FRAME_SIZE_MISMATCH/);
});

test("robustStats ignores a single outlier", () => {
  const { median, sigma } = V.robustStats([1, 1, 2, 1, 2, 1, 100]);
  assert.equal(median, 1);
  assert.ok(sigma < 2);
});

test("detectStumps finds three evenly spaced bars and their extent", () => {
  const r = V.detectStumps(scene({ noise: 6 }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.columns, [100, 106, 112].map((x) => r.columns.find((c) => Math.abs(c - x) <= 1)));
  assert.ok(Math.abs(r.top - 40) <= 2 && Math.abs(r.bottom - 75) <= 2, `top ${r.top} bottom ${r.bottom}`);
});

test("detectStumps and detectCrease handle wider bars (higher resolution)", () => {
  const f = scene({ barW: 4, noise: 4 });
  const st = V.detectStumps(f);
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.ok(st.columns.every((c, i) => Math.abs(c - ([100, 106, 112][i] + 1.5)) <= 2), `columns ${st.columns}`);
  const cr = V.detectCrease(f, { exclude: st.rect });
  assert.equal(cr.ok, true, JSON.stringify(cr));
  assert.ok(Math.abs((cr.line.x1 + cr.line.x2) / 2 - 81.5) <= 3, `crease ${JSON.stringify(cr.line)}`);
});

test("detectStumps abstains on a frame without stumps", () => {
  const blank = { width: W, height: H, data: new Uint8ClampedArray(W * H).fill(90) };
  assert.deepEqual(V.detectStumps(blank), { ok: false, reason: "STUMPS_NOT_FOUND" });
});

test("detectCuts flags a whole-frame change and nothing else", () => {
  const frames = clip(12, 99, { noise: 4 });
  frames[7] = scene({ bright: 80, seed: 99 });
  for (let i = 8; i < 12; i++) frames[i] = scene({ bright: 80, seed: 100 + i });
  assert.deepEqual([...V.detectCuts(frames)], [7]);
  assert.equal(V.detectCuts(clip(12, 6, { noise: 4 })).size, 0, "a bail falling is not a cut");
});

test("detectBailOff brackets the change and reports confidence", () => {
  const frames = clip(16, 9, { noise: 4 });
  const stumps = V.detectStumps(frames[0]);
  const r = V.detectBailOff(frames, V.bailRegion(stumps, frames[0]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lastOn, 8);
  assert.equal(r.firstOff, 9);
  assert.ok(r.confidence >= 0.5 && r.confidence <= 1);
});

test("detectBailOff ignores a glove that passes and comes back", () => {
  const frames = clip(16, 99, { noise: 4 });
  frames[6] = scene({ glove: true, seed: 50 });
  const stumps = V.detectStumps(frames[0]);
  const r = V.detectBailOff(frames, V.bailRegion(stumps, frames[0]));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAIL_CHANGE_NOT_SUSTAINED");
});

test("a glove arriving the frame before the bails fly widens the bracket instead of hiding the event", () => {
  const frames = clip(16, 9, { noise: 4 });
  frames[8] = scene({ glove: true, bail: true, seed: 80 });
  const region = V.bailRegion(V.detectStumps(frames[0]), frames[0]);
  const r = V.detectBailOff(frames, region);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lastOn, 7, "the glove frame can't show the bail, so the last clear 'on' frame is earlier");
  assert.equal(r.firstOff, 9);
});

test("brightness changes and camera jerks are not mistaken for a bail coming off", () => {
  const base = clip(16, 99, { noise: 4 });
  const region = V.bailRegion(V.detectStumps(base[0]), base[0]);
  const brighter = base.map((f, i) => (i >= 9 ? scene({ noise: 4, seed: i + 1, bright: 15 }) : f));
  assert.equal(V.detectBailOff(brighter, region).ok, false, "exposure step");
  const jerk = base.map((f, i) => (i >= 9 ? scene({ noise: 4, seed: i + 1, dx: 3 }) : f));
  assert.equal(V.detectBailOff(jerk, region).ok, false, "3 px camera jerk");
  const flicker = base.map((f, i) => scene({ noise: 4, seed: i + 1, bright: i % 2 ? 12 : 0 }));
  assert.equal(V.detectBailOff(flicker, region).ok, false, "flicker");
});

test("a real bail-off is still found when a camera jerk follows later", () => {
  const frames = Array.from({ length: 16 }, (_, i) => scene({ noise: 4, seed: i + 1, bail: i < 5, dx: i >= 11 ? 3 : 0 }));
  const region = V.bailRegion(V.detectStumps(frames[0]), frames[0]);
  const r = V.detectBailOff(frames, region);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.lastOn, r.firstOff], [4, 5]);
});

test("structuralDiff ignores a uniform brightness change", () => {
  const a = scene();
  const b = scene({ bright: 10 }); // stays below 255, so nothing clips
  assert.ok(V.structuralDiff(a, b, { x: 0, y: 0, w: W, h: H }) < 1e-9);
  assert.ok(V.meanAbsDiff(a, b) >= 9);
});

test("detectBailOff abstains with no change, at the clip edge, or across a cut", () => {
  const still = clip(12, 99, { noise: 4 });
  const region = V.bailRegion(V.detectStumps(still[0]), still[0]);
  assert.equal(V.detectBailOff(still, region).reason, "NO_BAIL_CHANGE");
  assert.equal(V.detectBailOff(clip(12, 11, { noise: 4 }), region).reason, "BAIL_CHANGE_AT_EDGE");
  assert.equal(V.detectBailOff(clip(12, 6, { noise: 4 }), region, { cuts: new Set([7]) }).reason, "CUT_AFTER_BAIL_CHANGE");
  assert.equal(V.detectBailOff(still, null).reason, "NO_BAIL_REGION");
  assert.equal(V.detectBailOff(still.slice(0, 3), region).reason, "TOO_FEW_FRAMES");
});

test("detectCrease finds a vertical and a tilted crease, ignoring the stumps", () => {
  for (const tilt of [0, 20]) {
    const f = scene({ noise: 4, creaseTilt: tilt });
    const stumps = V.detectStumps(f);
    const r = V.detectCrease(f, { exclude: stumps.rect });
    assert.equal(r.ok, true, `tilt ${tilt}: ${JSON.stringify(r)}`);
    const xAt = (y) => r.line.x1 + ((r.line.x2 - r.line.x1) * (y - r.line.y1)) / (r.line.y2 - r.line.y1);
    assert.ok(Math.abs(xAt(40) - (80 + (tilt * 12) / 62)) <= 3, `tilt ${tilt}: x at 40 = ${xAt(40)}`);
    assert.ok(Math.abs(xAt(85) - (80 + (tilt * 57) / 62)) <= 3, `tilt ${tilt}: x at 85 = ${xAt(85)}`);
  }
});

test("detectCrease abstains on a featureless frame", () => {
  const blank = { width: W, height: H, data: new Uint8ClampedArray(W * H).fill(90) };
  assert.equal(V.detectCrease(blank).ok, false);
});

test("sideOf and lineInFrame agree on geometry", () => {
  const line = V.lineInFrame(0, 50, 100, 100); // x = 50
  assert.ok(Math.abs(line.x1 - 50) < 1e-6 && Math.abs(line.x2 - 50) < 1e-6);
  assert.equal(V.sideOf(line, 10, 50), -V.sideOf(line, 90, 50));
  assert.equal(V.sideOf(line, 50, 20), 0);
});

test("groundingHint suggests a side, capped below the decision threshold", () => {
  const crease = { x1: 80, y1: 28, x2: 80, y2: 89 };
  const stumps = V.detectStumps(scene());
  const out = V.groundingHint(scene({ footX: 62 }), crease, stumps);
  const home = V.groundingHint(scene({ footX: 84 }), crease, stumps);
  assert.equal(out.value, "not-behind");
  assert.equal(home.value, "behind");
  assert.ok(out.confidence <= 0.6 && home.confidence <= 0.6);
  assert.equal(V.groundingHint(scene({ footX: 74 }), crease, stumps).value, "unknown", "straddling the line");
  assert.equal(V.groundingHint(scene(), null, stumps).reason, "NO_CREASE");
  assert.equal(V.groundingHint(scene(), crease, null).reason, "NO_STUMPS");
});

// ---------------------------------------------------------------------------
// Review policy
// ---------------------------------------------------------------------------

const CRICKET_CASES = [
  // [title, channel, expected]
  ["Best Fails Of DRS in Cricket History", "Cricbuzz Cricket", true],
  ["Dhoni lightning stumping", "Fan clips", true],
  ["Ind v Aus | 2nd Test | Day 3", "", true],
  ["#IPL2025 final", "", true],
  ["IPL2025 Final Highlights", "", true],
  ["KKR vs MI", "", true],
  ["Ashes 2023 day 1: wicket after wicket", "", true],
  ["Run out compilation | cricket", "", true],
  ["Unit test tutorial for beginners", "CodeAcademy", false],
  ["Test drive: the new EV", "", false],
  ["Over the top", "", false],
  ["Lofi beats to study to", "", false],
  ["Cricket wireless phone review", "Cricket Wireless", false],
  ["We run out of time", "", false],
  ["Ashes of Creation gameplay", "", false],
  ["DRS for Formula 1 explained", "", false],
  ["ICC profile color management", "", false],
  ["PSL 5 review", "", false],
  ["Jiminy Cricket song", "", false],
  ["Sticky Wicket brewery tour", "", false],
  ["ODI", "", false],
  ["India vs Australia football friendly", "", false],
  ["", "", false],
];

test("cricketScore errs toward off on ambiguous titles", () => {
  for (const [title, channel, expected] of CRICKET_CASES) {
    assert.equal(R.cricketScore({ title, channel }).isCricket, expected, `${JSON.stringify(title)} / ${JSON.stringify(channel)}`);
  }
  assert.equal(R.cricketScore({ title: "Highlights", description: "Full highlights of the 2nd ODI between India and Australia" }).isCricket, false, "one description hit is not enough");
  assert.equal(R.cricketScore({ title: "Highlights", description: "2nd ODI: India v Australia cricket highlights" }).isCricket, true);
  assert.equal(R.cricketScore({ title: "Highlights", channel: "Cricket Wireless" }).isCricket, false, "an ambiguous channel name alone is not enough");
});

test("decideCapture follows video, then channel, then detection", () => {
  assert.deepEqual(R.decideCapture({ cricket: true }), { on: true, reason: "CRICKET" });
  assert.deepEqual(R.decideCapture({ cricket: false }), { on: false, reason: "NOT_CRICKET" });
  assert.deepEqual(R.decideCapture({ cricket: true, channelPref: "off" }), { on: false, reason: "CHANNEL_OFF" });
  assert.deepEqual(R.decideCapture({ cricket: false, channelPref: "on" }), { on: true, reason: "CHANNEL_ON" });
  assert.deepEqual(R.decideCapture({ cricket: true, channelPref: "off", videoOverride: "on" }), { on: true, reason: "VIDEO_ON" });
  assert.deepEqual(R.decideCapture({ cricket: true, videoOverride: "off" }), { on: false, reason: "VIDEO_OFF" });
  assert.deepEqual(R.decideCapture({ cricket: true, channelPref: "maybe" }), { on: true, reason: "CRICKET" }, "unknown values are ignored");
});

test("replay detector reports where the viewer seeked back from, once", () => {
  let clock = 0;
  const d = R.createReplayDetector({ now: () => clock });
  d.onTime(30);
  assert.equal(d.onPause(), null, "plain pause");
  d.onSeek(26); // back 4 s
  clock = 3000;
  assert.deepEqual(d.onPause(), { from: 30 });
  assert.equal(d.onPause(), null, "only once");
  d.onTime(28);
  d.onSeek(27.5); // back 0.5 s: too small
  assert.equal(d.onPause(), null);
  d.onTime(40);
  d.onSeek(35);
  clock = 30000; // too late
  assert.equal(d.onPause(), null);
  d.onTime(10);
  d.onSeek(20); // forward
  assert.equal(d.onPause(), null);
});

test("reviewWindow extends a replay pause to where the viewer came from", () => {
  assert.deepEqual(R.reviewWindow(4.3, 9), { t0: 0, t1: 9 }, "paused before the incident: still covered");
  assert.deepEqual(R.reviewWindow(30), { t0: 18, t1: 30 });
  assert.deepEqual(R.reviewWindow(30, 20), { t0: 18, t1: 30 }, "never shrinks below the pause time");
  assert.deepEqual(R.reviewWindow(5), { t0: 0, t1: 5 });
});

const frames = (times) => times.map((t, i) => ({ id: i + 1, t }));

test("validateBracket checks presence, order, cuts and width", () => {
  const f = frames([1, 1.25, 1.5, 1.75, 2.5]);
  assert.deepEqual(R.validateBracket(f, 1, 2), { valid: true, gapMs: 250, sameShot: true, problems: [] });
  assert.deepEqual(R.validateBracket(f, 1, 2, new Set([2])).problems, ["CUT_IN_BRACKET"]);
  assert.deepEqual(R.validateBracket(f, 3, 4).problems, ["BRACKET_TOO_WIDE"]);
  assert.deepEqual(R.validateBracket(f, 2, 1).problems, ["BRACKET_ORDER"]);
  assert.deepEqual(R.validateBracket(f, null, 2).problems, ["NO_BRACKET"]);
  assert.deepEqual(R.validateBracket(f, 0, 9).problems, ["NO_BRACKET"]);
});

test("decideVerdict needs a valid bracket, a crease, and the viewer's answer for both frames", () => {
  const ok = R.validateBracket(frames([1, 1.25]), 0, 1);
  const withCrease = { hasCrease: true };
  assert.equal(R.decideVerdict(ok, "not-behind", withCrease).call, "OUT");
  assert.equal(R.decideVerdict(ok, "behind", withCrease).call, "NOT_OUT");
  assert.deepEqual(R.decideVerdict(ok, "not-behind").codes, ["NO_CREASE"], "no call without a crease");
  const unknown = R.decideVerdict(ok, null, withCrease);
  assert.equal(unknown.call, "INCONCLUSIVE");
  assert.deepEqual(unknown.codes, ["GROUNDING_UNKNOWN"]);
  assert.deepEqual(R.decideVerdict(ok, "cant-see", withCrease).codes, ["GROUNDING_NOT_VISIBLE"]);
  const wide = R.validateBracket(frames([1, 2]), 0, 1);
  assert.deepEqual(R.decideVerdict(wide, "not-behind", withCrease).codes, ["BRACKET_TOO_WIDE"], "a clear foot can't rescue a vague moment");
  for (const v of [R.decideVerdict(ok, "behind", withCrease), unknown]) {
    assert.equal(v.assumptions.length, 3);
    assert.ok(v.reasons.every((r) => typeof r === "string" && r.length > 10));
  }
});

test("buildEvidencePacket normalizes geometry and never carries images", () => {
  const f = [{ id: 7, t: 64.5104, jpeg: "data:image/jpeg;base64,AAAA" }, { id: 8, t: 64.7611 }];
  const check = R.validateBracket(f, 0, 1);
  const verdict = R.decideVerdict(check, "behind", { hasCrease: true });
  const p = R.buildEvidencePacket({
    video: { id: "abc", title: "T", channel: "C" },
    window: { t0: 52.7611, t1: 64.7611 },
    trigger: "chip",
    capture: { coverage: 0.9, gaps: [{ from: 52.76, to: 54 }] },
    frames: f,
    bracket: { lastOn: 0, firstOff: 1, source: "detector", confidence: 0.8 },
    bracketCheck: check,
    crease: { line: { x1: 240, y1: 0, x2: 240, y2: 270 }, width: 480, height: 270, source: "viewer" },
    grounded: "behind",
    hint: { value: "behind", confidence: 0.5 },
    verdict,
    now: new Date("2026-11-21T20:40:00Z"),
  });
  assert.equal(p.schema, "fan-drs.evidence/1");
  assert.equal(p.generatedAt, "2026-11-21T20:40:00.000Z");
  assert.deepEqual(p.bracket.lastOn, { id: 7, t: 64.51 });
  assert.equal(p.bracket.gapMs, 251);
  assert.deepEqual(p.crease.line, { x1: 0.5, y1: 0, x2: 0.5, y2: 1 });
  assert.deepEqual(p.grounded, { value: "behind", source: "viewer", frames: [7, 8], hint: { value: "behind", confidence: 0.5 } });
  assert.equal(p.verdict.call, "NOT_OUT");
  assert.ok(!JSON.stringify(p).includes("base64"), "no image data");
  const empty = R.buildEvidencePacket({ video: { id: "x" }, window: { t0: 0, t1: 1 }, trigger: "shortcut", capture: { coverage: 0, gaps: [] }, frames: [], bracket: null, bracketCheck: R.validateBracket([], null, null), crease: null, grounded: null, hint: null, verdict: R.decideVerdict(R.validateBracket([], null, null), null) });
  assert.equal(empty.bracket, null);
  assert.deepEqual(empty.grounded, { value: "unknown", source: "none", frames: [], hint: null });
});
