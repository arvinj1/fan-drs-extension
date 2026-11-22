/**
 * Fan DRS Review - shared core.
 *
 * Pure, DOM-free logic used by both the content script and the sidebar, and
 * exercised directly by the Node unit tests. Nothing here touches the page,
 * the network or extension storage.
 *
 * Loaded as a classic script (content_scripts list, sidebar <script>) and as a
 * CommonJS module under Node. It attaches a single frozen global, FanDRSCore.
 */
(function attach(root) {
  "use strict";

  const PROTOCOL_VERSION = 1;

  const LIMITS = Object.freeze({
    captureIntervalMs: 250,
    ringMaxFrames: 90,
    ringMaxBytes: 8 * 1024 * 1024,
    analysisMaxFrames: 60,
    defaultWindowSec: 12,
    // Must fit in the ring at 1x playback (90 frames x 250 ms = 22.5 s).
    maxWindowSec: 20,
    // A gap is reported when two consecutive frames are further apart than
    // this, in media seconds. Three missed capture ticks at 1x playback.
    gapThresholdSec: 0.75,
    requestTimeoutMs: 2000,
  });

  const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
  const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

  // ---------------------------------------------------------------------------
  // Frame ring: bounded by frame count and encoded bytes, deduped by media time.
  // ---------------------------------------------------------------------------

  function createFrameRing({ maxFrames = LIMITS.ringMaxFrames, maxBytes = LIMITS.ringMaxBytes } = {}) {
    let frames = [];
    let bytes = 0;
    let nextId = 1;

    function evictOldest() {
      const dropped = frames.shift();
      bytes -= dropped.bytes;
    }

    return {
      /**
       * Adds a frame. Returns the stored record, or null when rejected
       * (non-finite time, empty image, or a duplicate media time from a paused
       * player or a repeated fallback tick).
       */
      push({ mediaTime, jpeg, width, height, videoId, generation }) {
        if (!isFiniteNumber(mediaTime) || mediaTime < 0) return null;
        if (!isNonEmptyString(jpeg)) return null;
        if (frames.some((f) => f.generation === generation && f.mediaTime === mediaTime)) return null;

        const record = Object.freeze({
          id: nextId++,
          videoId,
          generation,
          mediaTime,
          width,
          height,
          jpeg,
          bytes: jpeg.length,
        });
        if (record.bytes > maxBytes) return null;

        frames.push(record);
        bytes += record.bytes;
        while (frames.length > maxFrames || bytes > maxBytes) evictOldest();
        return record;
      },
      clear() {
        frames = [];
        bytes = 0;
      },
      /** Frames for one generation, ordered by media time. */
      framesFor(generation) {
        return frames.filter((f) => f.generation === generation).sort((a, b) => a.mediaTime - b.mediaTime);
      },
      get size() {
        return frames.length;
      },
      get bytes() {
        return bytes;
      },
      /** True once the ring has started evicting, i.e. older footage is gone. */
      get full() {
        return frames.length >= maxFrames || bytes > maxBytes * 0.9;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Windows, sampling and coverage.
  // ---------------------------------------------------------------------------

  /** The default "last N seconds" window ending at the current playback time. */
  function lastSecondsWindow(currentTime, seconds = LIMITS.defaultWindowSec) {
    if (!isFiniteNumber(currentTime) || currentTime < 0) return null;
    return { t0: Math.max(0, currentTime - seconds), t1: currentTime };
  }

  /** Returns { ok: true, window } or { ok: false, reason } with a stable reason code. */
  function validateWindow(win) {
    if (!win || !isFiniteNumber(win.t0) || !isFiniteNumber(win.t1)) return { ok: false, reason: "WINDOW_INVALID" };
    if (win.t0 < 0) return { ok: false, reason: "WINDOW_NEGATIVE" };
    if (win.t1 <= win.t0) return { ok: false, reason: "WINDOW_REVERSED" };
    if (win.t1 - win.t0 > LIMITS.maxWindowSec) return { ok: false, reason: "WINDOW_TOO_LONG" };
    return { ok: true, window: { t0: win.t0, t1: win.t1 } };
  }

  /**
   * Picks at most maxFrames evenly spread frames, always keeping the first
   * and last frame so the window's edges are never silently dropped.
   */
  function sampleWithEndpoints(sortedFrames, maxFrames = LIMITS.analysisMaxFrames) {
    const n = sortedFrames.length;
    if (n <= maxFrames) return sortedFrames.slice();
    if (maxFrames <= 0) return [];
    if (maxFrames === 1) return [sortedFrames[n - 1]];
    const picked = [];
    for (let i = 0; i < maxFrames; i++) {
      picked.push(sortedFrames[Math.round((i * (n - 1)) / (maxFrames - 1))]);
    }
    return picked;
  }

  /**
   * Describes which parts of [t0, t1] the frames actually cover. Gaps are
   * measured, never estimated from frame counts.
   */
  function measureCoverage(win, mediaTimes, gapThresholdSec = LIMITS.gapThresholdSec) {
    const span = win.t1 - win.t0;
    const gaps = [];
    if (mediaTimes.length === 0) {
      gaps.push({ from: win.t0, to: win.t1 });
    } else {
      const first = mediaTimes[0];
      const last = mediaTimes[mediaTimes.length - 1];
      if (first - win.t0 > gapThresholdSec) gaps.push({ from: win.t0, to: first });
      for (let i = 1; i < mediaTimes.length; i++) {
        if (mediaTimes[i] - mediaTimes[i - 1] > gapThresholdSec) gaps.push({ from: mediaTimes[i - 1], to: mediaTimes[i] });
      }
      if (win.t1 - last > gapThresholdSec) gaps.push({ from: last, to: win.t1 });
    }
    const missing = gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
    return {
      gaps,
      coveredSec: Math.max(0, span - missing),
      ratio: span > 0 ? Math.max(0, Math.min(1, (span - missing) / span)) : 0,
    };
  }

  /**
   * Builds the KEYFRAMES response payload for one validated window.
   * Frame records carry metadata only; image data stays in the content
   * script until a consumer (the slice B frame rail) actually needs it.
   */
  function selectWindow(ring, generation, win, maxFrames = LIMITS.analysisMaxFrames) {
    const all = ring.framesFor(generation);
    const inWindow = all.filter((f) => f.mediaTime >= win.t0 && f.mediaTime <= win.t1);
    const sampled = sampleWithEndpoints(inWindow, Math.min(maxFrames, LIMITS.analysisMaxFrames));
    return {
      window: { t0: win.t0, t1: win.t1 },
      generation,
      framesInWindow: inWindow.length,
      frames: sampled.map(({ id, videoId, mediaTime, width, height }) => ({ id, videoId, mediaTime, width, height })),
      coverage: measureCoverage(win, inWindow.map((f) => f.mediaTime)),
      buffer: {
        from: all.length ? all[0].mediaTime : null,
        to: all.length ? all[all.length - 1].mediaTime : null,
        full: ring.full,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Capture session: one per tab, bound to one <video> and one video ID.
  // ---------------------------------------------------------------------------

  /**
   * grab(video) -> { jpeg, width, height } | null  (throws on canvas failure)
   * isAdShowing() -> boolean
   * onError(code, error) is called when a failure streak starts (stable code)
   * and with null when capture recovers. The current code is also readable as
   * session.lastError, so a late subscriber never misses it.
   */
  function createCaptureSession({ ring, grab, isAdShowing = () => false, onError = () => {}, setInterval: si = setInterval, clearInterval: ci = clearInterval, intervalMs = LIMITS.captureIntervalMs }) {
    let video = null;
    let videoId = null;
    let generation = 0;
    let running = false;
    let rvfcHandle = null;
    let timerId = null;
    let lastWallMs = -Infinity;
    let lastError = null;

    function capture(mediaTime) {
      if (!running || !video) return;
      if (isAdShowing()) return; // Ad frames are never evidence.
      if (video.readyState < 2) return; // HAVE_CURRENT_DATA
      let image;
      try {
        image = grab(video);
      } catch (err) {
        const code = err && err.name === "SecurityError" ? "CAPTURE_BLOCKED" : "CAPTURE_FAILED";
        if (lastError !== code) {
          lastError = code;
          onError(code, err);
        }
        return;
      }
      if (!image) return;
      if (lastError !== null) {
        lastError = null;
        onError(null);
      }
      ring.push({ mediaTime, jpeg: image.jpeg, width: image.width, height: image.height, videoId, generation });
    }

    function onVideoFrame(nowMs, metadata) {
      if (!running) return;
      if (nowMs - lastWallMs >= intervalMs) {
        lastWallMs = nowMs;
        capture(metadata && isFiniteNumber(metadata.mediaTime) ? metadata.mediaTime : video.currentTime);
      }
      rvfcHandle = video.requestVideoFrameCallback(onVideoFrame);
    }

    function cancelScheduled() {
      if (rvfcHandle !== null && video && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      rvfcHandle = null;
      if (timerId !== null) ci(timerId);
      timerId = null;
    }

    return {
      /**
       * Binds to a video. A different element or video ID starts a new
       * generation and drops every frame from the previous one.
       * Returns false (and stays stopped) when there is no usable video.
       */
      start(nextVideo, nextVideoId) {
        if (!nextVideo || !isNonEmptyString(nextVideoId)) {
          this.unbind();
          return false;
        }
        if (nextVideo !== video || nextVideoId !== videoId) {
          this.stop();
          ring.clear();
          video = nextVideo;
          videoId = nextVideoId;
          generation += 1;
        }
        if (running) return true;
        running = true;
        lastWallMs = -Infinity;
        lastError = null;
        if (typeof video.requestVideoFrameCallback === "function") {
          rvfcHandle = video.requestVideoFrameCallback(onVideoFrame);
        } else {
          timerId = si(() => capture(video.currentTime), intervalMs);
        }
        return true;
      },
      stop() {
        running = false;
        cancelScheduled();
      },
      /** Drops all frames and bumps the generation, e.g. when the source changes under the same element. */
      invalidate() {
        ring.clear();
        generation += 1;
      },
      /** Stops, forgets the bound video and drops its frames (player gone, or leaving /watch). */
      unbind() {
        this.stop();
        if (video === null && videoId === null) return;
        video = null;
        videoId = null;
        this.invalidate();
      },
      /** Stable code of the current capture failure streak, or null. */
      get lastError() {
        return lastError;
      },
      get running() {
        return running;
      },
      get generation() {
        return generation;
      },
      get videoId() {
        return videoId;
      },
      get video() {
        return video;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Bridge protocol. Every message crosses a private MessageChannel port; the
  // schema check is defense in depth against our own bugs, not the page.
  // ---------------------------------------------------------------------------

  const REQUEST_TYPES = Object.freeze(["GET_CONTEXT", "GET_KEYFRAMES", "SET_CAPTURE", "CLOSE"]);
  const EVENT_TYPES = Object.freeze(["CONTEXT_CHANGED", "SESSION_RESET", "REVIEW_REQUESTED"]);

  /**
   * The connect handshake is authenticated by a nonce that only the content
   * script and the sidebar know: it travels in the iframe URL fragment, and
   * the iframe lives in a closed shadow root, so page scripts can't read it.
   */
  function isAuthenticConnect(data, expectedNonce) {
    return Boolean(
      data &&
        data.fanDRS === "connect" &&
        data.v === PROTOCOL_VERSION &&
        isNonEmptyString(expectedNonce) &&
        data.nonce === expectedNonce
    );
  }

  /** Validates a sidebar -> content request. Returns { ok, reason }. */
  function validateRequest(msg) {
    if (!msg || typeof msg !== "object") return { ok: false, reason: "NOT_OBJECT" };
    if (msg.v !== PROTOCOL_VERSION) return { ok: false, reason: "BAD_VERSION" };
    if (!Number.isSafeInteger(msg.id) || msg.id <= 0) return { ok: false, reason: "BAD_ID" };
    if (!REQUEST_TYPES.includes(msg.type)) return { ok: false, reason: "UNKNOWN_TYPE" };
    if (msg.type === "GET_KEYFRAMES") {
      const p = msg.payload;
      if (!p || !validateWindow(p).ok) return { ok: false, reason: "BAD_WINDOW" };
      if (!Number.isSafeInteger(p.maxFrames) || p.maxFrames < 1 || p.maxFrames > LIMITS.analysisMaxFrames) return { ok: false, reason: "BAD_MAX_FRAMES" };
      if (p.includeImages !== undefined && typeof p.includeImages !== "boolean") return { ok: false, reason: "BAD_INCLUDE_IMAGES" };
    }
    if (msg.type === "SET_CAPTURE") {
      const p = msg.payload;
      if (!p || (p.scope !== "video" && p.scope !== "channel")) return { ok: false, reason: "BAD_SCOPE" };
      if (p.value !== "on" && p.value !== "off" && p.value !== null) return { ok: false, reason: "BAD_VALUE" };
    }
    return { ok: true };
  }

  /** Validates a content -> sidebar message (a response or an event). */
  function validateInbound(msg) {
    if (!msg || typeof msg !== "object" || msg.v !== PROTOCOL_VERSION) return { ok: false, reason: "BAD_ENVELOPE" };
    if (msg.kind === "response") {
      if (!Number.isSafeInteger(msg.id) || msg.id <= 0) return { ok: false, reason: "BAD_ID" };
      if (typeof msg.ok !== "boolean") return { ok: false, reason: "BAD_RESPONSE" };
      return { ok: true };
    }
    if (msg.kind === "event") {
      return EVENT_TYPES.includes(msg.type) ? { ok: true } : { ok: false, reason: "UNKNOWN_EVENT" };
    }
    return { ok: false, reason: "BAD_KIND" };
  }

  /**
   * Request/response client over a port-like object ({ postMessage }).
   * One active request per key: starting a new request with the same key
   * rejects the previous one, so a late answer can never update the UI.
   */
  function createRpcClient(post, { timeoutMs = LIMITS.requestTimeoutMs, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
    let nextId = 1;
    const pending = new Map(); // id -> { resolve, reject, timer, key }
    const activeByKey = new Map(); // key -> id

    function settle(id) {
      const entry = pending.get(id);
      if (!entry) return null;
      pending.delete(id);
      ct(entry.timer);
      if (entry.key && activeByKey.get(entry.key) === id) activeByKey.delete(entry.key);
      return entry;
    }

    function rejectWith(id, code) {
      const entry = settle(id);
      if (entry) entry.reject(Object.assign(new Error(code), { code }));
    }

    return {
      request(type, payload, { key = type } = {}) {
        if (activeByKey.has(key)) rejectWith(activeByKey.get(key), "SUPERSEDED");
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = st(() => rejectWith(id, "TIMEOUT"), timeoutMs);
          pending.set(id, { resolve, reject, timer, key });
          activeByKey.set(key, id);
          post({ v: PROTOCOL_VERSION, id, type, payload });
        });
      },
      /** Feed every validated response here. Unknown or stale IDs are ignored. */
      handleResponse(msg) {
        const entry = settle(msg.id);
        if (!entry) return false;
        if (msg.ok) entry.resolve(msg.payload);
        else entry.reject(Object.assign(new Error(msg.error || "REQUEST_FAILED"), { code: msg.error || "REQUEST_FAILED" }));
        return true;
      },
      /** Rejects everything in flight (Reset, panel close, navigation). */
      cancelAll(code = "CANCELLED") {
        for (const id of Array.from(pending.keys())) rejectWith(id, code);
      },
      get pendingCount() {
        return pending.size;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Presentation helpers.
  // ---------------------------------------------------------------------------

  function formatTime(sec) {
    if (!isFiniteNumber(sec) || sec < 0) return "—";
    const whole = Math.floor(sec);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
  }

  /** Precise label for a frame or mark, e.g. 1:02.25. */
  function formatPreciseTime(sec) {
    if (!isFiniteNumber(sec) || sec < 0) return "—";
    const hundredths = Math.round(sec * 100);
    return `${formatTime(Math.floor(hundredths / 100))}.${String(hundredths % 100).padStart(2, "0")}`;
  }

  const api = Object.freeze({
    PROTOCOL_VERSION,
    LIMITS,
    createFrameRing,
    lastSecondsWindow,
    validateWindow,
    sampleWithEndpoints,
    measureCoverage,
    selectWindow,
    createCaptureSession,
    validateRequest,
    validateInbound,
    isAuthenticConnect,
    createRpcClient,
    formatTime,
    formatPreciseTime,
  });

  root.FanDRSCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
