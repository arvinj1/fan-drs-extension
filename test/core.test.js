"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/src/shared/core.js");

const frame = (mediaTime, extra = {}) => ({ mediaTime, jpeg: `data:image/jpeg;base64,${"A".repeat(10)}`, width: 320, height: 180, videoId: "vid", generation: 1, ...extra });

test("ring rejects non-finite, negative and empty frames", () => {
  const ring = Core.createFrameRing();
  assert.equal(ring.push(frame(NaN)), null);
  assert.equal(ring.push(frame(-0.1)), null);
  assert.equal(ring.push(frame(Infinity)), null);
  assert.equal(ring.push(frame(1, { jpeg: "" })), null);
  assert.equal(ring.size, 0);
});

test("ring keeps a frame at media time zero", () => {
  const ring = Core.createFrameRing();
  assert.ok(ring.push(frame(0)));
  assert.equal(ring.framesFor(1)[0].mediaTime, 0);
});

test("ring dedupes repeated media times within a generation only", () => {
  const ring = Core.createFrameRing();
  assert.ok(ring.push(frame(1)));
  assert.equal(ring.push(frame(1)), null);
  assert.ok(ring.push(frame(1, { generation: 2 })));
  assert.equal(ring.size, 2);
});

test("ring is bounded by frame count, evicting oldest first", () => {
  const ring = Core.createFrameRing({ maxFrames: 3 });
  for (const t of [1, 2, 3, 4]) ring.push(frame(t));
  assert.deepEqual(ring.framesFor(1).map((f) => f.mediaTime), [2, 3, 4]);
});

test("ring is bounded by bytes and keeps its byte count exact", () => {
  const jpeg = "x".repeat(100);
  const ring = Core.createFrameRing({ maxFrames: 100, maxBytes: 250 });
  for (const t of [1, 2, 3]) ring.push(frame(t, { jpeg }));
  assert.equal(ring.size, 2);
  assert.equal(ring.bytes, 200);
  assert.equal(ring.push(frame(9, { jpeg: "y".repeat(251) })), null);
  ring.clear();
  assert.equal(ring.bytes, 0);
  assert.equal(ring.size, 0);
});

test("framesFor sorts by media time after a backward seek", () => {
  const ring = Core.createFrameRing();
  for (const t of [10, 10.25, 4, 4.25]) ring.push(frame(t));
  assert.deepEqual(ring.framesFor(1).map((f) => f.mediaTime), [4, 4.25, 10, 10.25]);
});

test("lastSecondsWindow clamps to zero and rejects bad times", () => {
  assert.deepEqual(Core.lastSecondsWindow(30), { t0: 18, t1: 30 });
  assert.deepEqual(Core.lastSecondsWindow(5), { t0: 0, t1: 5 });
  assert.deepEqual(Core.lastSecondsWindow(0), { t0: 0, t1: 0 });
  assert.equal(Core.lastSecondsWindow(null), null);
  assert.equal(Core.lastSecondsWindow(NaN), null);
});

test("validateWindow returns stable reason codes", () => {
  assert.equal(Core.validateWindow({ t0: 0, t1: 0 }).reason, "WINDOW_REVERSED");
  assert.equal(Core.validateWindow({ t0: 5, t1: 4 }).reason, "WINDOW_REVERSED");
  assert.equal(Core.validateWindow({ t0: -1, t1: 4 }).reason, "WINDOW_NEGATIVE");
  assert.equal(Core.validateWindow({ t0: 0, t1: 20.01 }).reason, "WINDOW_TOO_LONG");
  assert.equal(Core.validateWindow({ t0: "1", t1: 4 }).reason, "WINDOW_INVALID");
  assert.equal(Core.validateWindow(null).reason, "WINDOW_INVALID");
  assert.deepEqual(Core.validateWindow({ t0: 0, t1: 20 }), { ok: true, window: { t0: 0, t1: 20 } });
});

test("the longest allowed window fits in a full ring at 1x playback", () => {
  const { ringMaxFrames, captureIntervalMs, maxWindowSec } = Core.LIMITS;
  assert.ok(maxWindowSec <= (ringMaxFrames * captureIntervalMs) / 1000);
});

test("sampleWithEndpoints keeps both ends and respects the cap", () => {
  const items = Array.from({ length: 90 }, (_, i) => i);
  const picked = Core.sampleWithEndpoints(items, 60);
  assert.equal(picked.length, 60);
  assert.equal(picked[0], 0);
  assert.equal(picked[59], 89);
  assert.deepEqual(Core.sampleWithEndpoints(items, 1), [89]);
  assert.deepEqual(Core.sampleWithEndpoints(items, 0), []);
  assert.deepEqual(Core.sampleWithEndpoints([1, 2], 60), [1, 2]);
});

test("measureCoverage reports leading, inner and trailing gaps", () => {
  const cov = Core.measureCoverage({ t0: 0, t1: 10 }, [2, 2.25, 2.5, 6, 6.25]);
  assert.deepEqual(cov.gaps, [{ from: 0, to: 2 }, { from: 2.5, to: 6 }, { from: 6.25, to: 10 }]);
  assert.ok(Math.abs(cov.coveredSec - 0.75) < 1e-9);
});

test("measureCoverage with no frames is one full gap and zero ratio", () => {
  const cov = Core.measureCoverage({ t0: 3, t1: 5 }, []);
  assert.deepEqual(cov.gaps, [{ from: 3, to: 5 }]);
  assert.equal(cov.ratio, 0);
});

test("measureCoverage with dense frames is fully covered", () => {
  const times = Array.from({ length: 41 }, (_, i) => i * 0.25);
  const cov = Core.measureCoverage({ t0: 0, t1: 10 }, times);
  assert.deepEqual(cov.gaps, []);
  assert.equal(cov.ratio, 1);
});

test("selectWindow only returns frames from the active generation and window", () => {
  const ring = Core.createFrameRing();
  for (let t = 0; t <= 20; t += 0.25) ring.push(frame(t));
  ring.push(frame(5, { generation: 2 }));
  const res = Core.selectWindow(ring, 1, { t0: 8, t1: 20 }, 60);
  assert.equal(res.framesInWindow, 49);
  assert.equal(res.frames.length, 49);
  assert.equal(res.frames[0].mediaTime, 8);
  assert.equal(res.frames.at(-1).mediaTime, 20);
  assert.equal(Core.selectWindow(ring, 2, { t0: 8, t1: 20 }, 60).frames.length, 0);
  assert.ok(!("bytes" in res.frames[0]));
  assert.ok(!("jpeg" in res.frames[0]), "image data stays in the content script");
});

test("selectWindow reports the buffer span and whether older footage was evicted", () => {
  const ring = Core.createFrameRing({ maxFrames: 4 });
  for (const t of [1, 2]) ring.push(frame(t));
  assert.deepEqual(Core.selectWindow(ring, 1, { t0: 0, t1: 3 }).buffer, { from: 1, to: 2, full: false });
  for (const t of [3, 4, 5]) ring.push(frame(t));
  assert.deepEqual(Core.selectWindow(ring, 1, { t0: 0, t1: 5 }).buffer, { from: 2, to: 5, full: true });
  assert.deepEqual(Core.selectWindow(Core.createFrameRing(), 1, { t0: 0, t1: 5 }).buffer, { from: null, to: null, full: false });
});

// ---------------------------------------------------------------------------
// Capture session lifecycle with a fake <video>.
// ---------------------------------------------------------------------------

function fakeVideo({ rvfc = true } = {}) {
  const callbacks = new Map();
  let next = 1;
  const v = { readyState: 4, currentTime: 0, videoWidth: 1280, videoHeight: 720, cancelled: [] };
  if (rvfc) {
    v.requestVideoFrameCallback = (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    };
    v.cancelVideoFrameCallback = (id) => {
      v.cancelled.push(id);
      callbacks.delete(id);
    };
  }
  /** Delivers one presented frame to every pending callback. */
  v.present = (nowMs, mediaTime) => {
    const pending = Array.from(callbacks.entries());
    callbacks.clear();
    for (const [, cb] of pending) cb(nowMs, { mediaTime });
  };
  v.pendingCallbacks = () => callbacks.size;
  return v;
}

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setInterval: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    tick: () => Array.from(timers.values()).forEach((fn) => fn()),
    get count() {
      return timers.size;
    },
  };
}

const okGrab = () => ({ jpeg: "data:image/jpeg;base64,AAAA", width: 320, height: 180 });

test("session refuses to start without a video and does not stay running", () => {
  const session = Core.createCaptureSession({ ring: Core.createFrameRing(), grab: okGrab });
  assert.equal(session.start(null, "vid"), false);
  assert.equal(session.running, false);
  assert.equal(session.start(fakeVideo(), ""), false);
  assert.equal(session.running, false);
});

test("losing the player unbinds once: frames dropped, generation bumped, then idempotent", () => {
  const ring = Core.createFrameRing();
  const video = fakeVideo();
  const session = Core.createCaptureSession({ ring, grab: okGrab });
  session.start(video, "a");
  video.present(0, 1);
  const gen = session.generation;
  session.start(null, "a");
  assert.equal(session.video, null);
  assert.equal(session.videoId, null);
  assert.equal(ring.size, 0);
  assert.equal(session.generation, gen + 1);
  assert.equal(video.pendingCallbacks(), 0);
  session.unbind();
  session.start(null, "a");
  assert.equal(session.generation, gen + 1, "repeated ticks without a player don't churn generations");
});

test("session captures with media time and throttles by wall time", () => {
  const ring = Core.createFrameRing();
  const video = fakeVideo();
  const session = Core.createCaptureSession({ ring, grab: okGrab });
  session.start(video, "vid");
  video.present(0, 1.0);
  video.present(100, 1.1); // inside the 250 ms throttle
  video.present(260, 1.26);
  assert.deepEqual(ring.framesFor(session.generation).map((f) => f.mediaTime), [1.0, 1.26]);
});

test("stop cancels the pending video frame callback", () => {
  const video = fakeVideo();
  const session = Core.createCaptureSession({ ring: Core.createFrameRing(), grab: okGrab });
  session.start(video, "vid");
  assert.equal(video.pendingCallbacks(), 1);
  session.stop();
  assert.equal(video.pendingCallbacks(), 0);
  assert.equal(video.cancelled.length, 1);
  assert.equal(session.running, false);
});

test("repeated open/close never stacks capture loops", () => {
  const video = fakeVideo();
  const session = Core.createCaptureSession({ ring: Core.createFrameRing(), grab: okGrab });
  for (let i = 0; i < 5; i++) {
    session.start(video, "vid");
    session.start(video, "vid");
    session.stop();
  }
  session.start(video, "vid");
  assert.equal(video.pendingCallbacks(), 1);
});

test("fallback interval is cleared on stop and not duplicated", () => {
  const timers = fakeTimers();
  const ring = Core.createFrameRing();
  const video = fakeVideo({ rvfc: false });
  const session = Core.createCaptureSession({ ring, grab: okGrab, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  session.start(video, "vid");
  session.start(video, "vid");
  assert.equal(timers.count, 1);
  video.currentTime = 2;
  timers.tick();
  timers.tick(); // paused: same media time is deduped
  assert.equal(ring.size, 1);
  session.stop();
  assert.equal(timers.count, 0);
});

test("reopening the same video keeps frames; a new video clears them", () => {
  const ring = Core.createFrameRing();
  const video = fakeVideo();
  const session = Core.createCaptureSession({ ring, grab: okGrab });
  session.start(video, "a");
  video.present(0, 1);
  session.stop();
  session.start(video, "a");
  assert.equal(ring.size, 1);
  const gen = session.generation;
  session.start(video, "b");
  assert.equal(ring.size, 0);
  assert.equal(session.generation, gen + 1);
  const other = fakeVideo();
  session.start(other, "b");
  assert.equal(session.generation, gen + 2);
  assert.equal(video.pendingCallbacks(), 0, "old element's callback was cancelled");
});

test("invalidate drops frames and bumps the generation", () => {
  const ring = Core.createFrameRing();
  const video = fakeVideo();
  const session = Core.createCaptureSession({ ring, grab: okGrab });
  session.start(video, "a");
  video.present(0, 1);
  const gen = session.generation;
  session.invalidate();
  assert.equal(ring.size, 0);
  assert.equal(session.generation, gen + 1);
});

test("ads and unready video are never captured", () => {
  const ring = Core.createFrameRing();
  const video = fakeVideo();
  let ad = true;
  const session = Core.createCaptureSession({ ring, grab: okGrab, isAdShowing: () => ad });
  session.start(video, "a");
  video.present(0, 1);
  ad = false;
  video.readyState = 1;
  video.present(300, 1.3);
  assert.equal(ring.size, 0);
  video.readyState = 4;
  video.present(600, 1.6);
  assert.equal(ring.size, 1);
});

test("canvas failures are reported once per streak with a stable code", () => {
  const errors = [];
  const video = fakeVideo();
  let fail = true;
  const grab = () => {
    if (fail) throw Object.assign(new Error("tainted"), { name: "SecurityError" });
    return okGrab();
  };
  const session = Core.createCaptureSession({ ring: Core.createFrameRing(), grab, onError: (code) => errors.push(code) });
  session.start(video, "a");
  video.present(0, 1);
  video.present(300, 1.3);
  assert.deepEqual(errors, ["CAPTURE_BLOCKED"]);
  assert.equal(session.lastError, "CAPTURE_BLOCKED", "readable as state by a late subscriber");
  fail = false;
  video.present(600, 1.6);
  assert.equal(session.lastError, null);
  fail = true;
  video.present(900, 1.9);
  assert.deepEqual(errors, ["CAPTURE_BLOCKED", null, "CAPTURE_BLOCKED"]);
});

// ---------------------------------------------------------------------------
// Protocol and RPC.
// ---------------------------------------------------------------------------

const req = (extra) => ({ v: Core.PROTOCOL_VERSION, id: 1, type: "GET_CONTEXT", ...extra });

test("validateRequest enforces version, id, type and keyframe bounds", () => {
  assert.equal(Core.validateRequest(req()).ok, true);
  assert.equal(Core.validateRequest(req({ v: 0 })).reason, "BAD_VERSION");
  assert.equal(Core.validateRequest(req({ id: 0 })).reason, "BAD_ID");
  assert.equal(Core.validateRequest(req({ id: 1.5 })).reason, "BAD_ID");
  assert.equal(Core.validateRequest(req({ type: "EVAL" })).reason, "UNKNOWN_TYPE");
  assert.equal(Core.validateRequest(null).reason, "NOT_OBJECT");
  const kf = (payload) => Core.validateRequest(req({ type: "GET_KEYFRAMES", payload }));
  assert.equal(kf({ t0: 0, t1: 12, maxFrames: 60 }).ok, true);
  assert.equal(kf({ t0: 12, t1: 0, maxFrames: 60 }).reason, "BAD_WINDOW");
  assert.equal(kf({ t0: 0, t1: 12, maxFrames: 61 }).reason, "BAD_MAX_FRAMES");
  assert.equal(kf({ t0: 0, t1: 12, maxFrames: 0 }).reason, "BAD_MAX_FRAMES");
  assert.equal(kf(undefined).reason, "BAD_WINDOW");
  assert.equal(kf({ t0: 0, t1: 12, maxFrames: 48, includeImages: true }).ok, true);
  assert.equal(kf({ t0: 0, t1: 12, maxFrames: 48, includeImages: "yes" }).reason, "BAD_INCLUDE_IMAGES");
  const set = (payload) => Core.validateRequest(req({ type: "SET_CAPTURE", payload }));
  assert.equal(set({ scope: "video", value: "on" }).ok, true);
  assert.equal(set({ scope: "channel", value: null }).ok, true);
  assert.equal(set({ scope: "tab", value: "on" }).reason, "BAD_SCOPE");
  assert.equal(set({ scope: "video", value: true }).reason, "BAD_VALUE");
  assert.equal(set(undefined).reason, "BAD_SCOPE");
});

test("validateInbound accepts only known responses and events", () => {
  const v = Core.PROTOCOL_VERSION;
  assert.equal(Core.validateInbound({ v, kind: "response", id: 3, ok: true }).ok, true);
  assert.equal(Core.validateInbound({ v, kind: "response", id: 3 }).reason, "BAD_RESPONSE");
  assert.equal(Core.validateInbound({ v, kind: "event", type: "CONTEXT_CHANGED" }).ok, true);
  assert.equal(Core.validateInbound({ v, kind: "event", type: "REVIEW_REQUESTED" }).ok, true);
  assert.equal(Core.validateInbound({ v, kind: "event", type: "RUN" }).reason, "UNKNOWN_EVENT");
  assert.equal(Core.validateInbound({ v, kind: "event", type: "CAPTURE_ERROR" }).reason, "UNKNOWN_EVENT", "errors travel as context state");
  assert.equal(Core.validateInbound({ v: 9, kind: "event", type: "CONTEXT_CHANGED" }).reason, "BAD_ENVELOPE");
});

test("connect handshake requires the exact nonce", () => {
  const v = Core.PROTOCOL_VERSION;
  const nonce = "4f1c1a1e-2b7d-4c55-9f0e-6f2b1b9a7c10";
  assert.equal(Core.isAuthenticConnect({ fanDRS: "connect", v, nonce }, nonce), true);
  assert.equal(Core.isAuthenticConnect({ fanDRS: "connect", v }, nonce), false);
  assert.equal(Core.isAuthenticConnect({ fanDRS: "connect", v, nonce: "guess" }, nonce), false);
  assert.equal(Core.isAuthenticConnect({ fanDRS: "connect", v, nonce: "" }, ""), false, "no nonce in the URL means no connection");
  assert.equal(Core.isAuthenticConnect({ fanDRS: "connect", v: 0, nonce }, nonce), false);
  assert.equal(Core.isAuthenticConnect(null, nonce), false);
});

function rpcHarness() {
  const sent = [];
  const timers = new Map();
  let next = 1;
  const rpc = Core.createRpcClient((m) => sent.push(m), {
    timeoutMs: 100,
    setTimeout: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return { rpc, sent, fireTimeouts: () => Array.from(timers.values()).forEach((fn) => fn()), timers };
}

test("rpc correlates responses by id and ignores unknown ids", async () => {
  const { rpc, sent } = rpcHarness();
  const p = rpc.request("GET_CONTEXT");
  assert.equal(rpc.handleResponse({ id: 999, ok: true, payload: 1 }), false);
  assert.equal(rpc.handleResponse({ id: sent[0].id, ok: true, payload: { a: 1 } }), true);
  assert.deepEqual(await p, { a: 1 });
  assert.equal(rpc.pendingCount, 0);
});

test("a newer request with the same key supersedes the old one; late answers are dropped", async () => {
  const { rpc, sent } = rpcHarness();
  const first = rpc.request("GET_KEYFRAMES", {}, { key: "analysis" });
  const second = rpc.request("GET_KEYFRAMES", {}, { key: "analysis" });
  await assert.rejects(first, { code: "SUPERSEDED" });
  assert.equal(rpc.handleResponse({ id: sent[0].id, ok: true, payload: "stale" }), false);
  rpc.handleResponse({ id: sent[1].id, ok: true, payload: "fresh" });
  assert.equal(await second, "fresh");
});

test("rpc times out, cancels on reset, and clears its timers", async () => {
  const { rpc, sent, fireTimeouts, timers } = rpcHarness();
  const timed = rpc.request("GET_CONTEXT");
  fireTimeouts();
  await assert.rejects(timed, { code: "TIMEOUT" });
  const a = rpc.request("GET_CONTEXT", undefined, { key: "a" });
  const b = rpc.request("GET_KEYFRAMES", {}, { key: "b" });
  rpc.cancelAll("CANCELLED");
  await assert.rejects(a, { code: "CANCELLED" });
  await assert.rejects(b, { code: "CANCELLED" });
  assert.equal(timers.size, 0);
  assert.equal(rpc.handleResponse({ id: sent[1].id, ok: true }), false);
});

test("rpc surfaces error codes from failed responses", async () => {
  const { rpc, sent } = rpcHarness();
  const p = rpc.request("GET_KEYFRAMES", {});
  rpc.handleResponse({ id: sent[0].id, ok: false, error: "BAD_WINDOW" });
  await assert.rejects(p, { code: "BAD_WINDOW" });
});

test("time formatting handles zero, hours and invalid input", () => {
  assert.equal(Core.formatTime(0), "0:00");
  assert.equal(Core.formatTime(62.9), "1:02");
  assert.equal(Core.formatTime(3725), "1:02:05");
  assert.equal(Core.formatTime(null), "—");
  assert.equal(Core.formatTime(Infinity), "—");
  assert.equal(Core.formatPreciseTime(62.25), "1:02.25");
  assert.equal(Core.formatPreciseTime(0), "0:00.00");
  assert.equal(Core.formatPreciseTime(1.996), "0:02.00");
  assert.equal(Core.formatPreciseTime(59.999), "1:00.00");
});
