/**
 * Fan DRS Review - Sidebar Controller (slice A1)
 *
 * Talks to the content script over a private MessageChannel port that the
 * content script transfers once after this page loads. Every request is
 * correlated and time-bounded; Reset, a new analysis or a session reset
 * cancels anything in flight so a late answer cannot change the UI.
 *
 * This release reports evidence only: what was captured for the chosen
 * window and what is missing. It makes no dismissal decision.
 */
(function fanDrsSidebar() {
  "use strict";

  const Core = globalThis.FanDRSCore;
  const YOUTUBE_ORIGIN = "https://www.youtube.com";
  // Shared secret from the content script, delivered in our URL fragment.
  const NONCE = location.hash.slice(1);

  const $ = (id) => document.getElementById(id);

  const state = {
    port: null,
    rpc: null,
    ctx: null,
    /** User-chosen window; null means "last 12 seconds" at Analyze time. */
    marks: { start: null, end: null },
    phase: "idle", // idle | collecting | ready | error
  };

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  window.addEventListener("message", (ev) => {
    if (state.port) return; // One authenticated port per page load.
    if (ev.source !== window.parent || ev.origin !== YOUTUBE_ORIGIN) return;
    // Page scripts share the parent window, so origin and source can't tell
    // them apart from the content script. Only the nonce can; anything without
    // it is ignored and the real handshake can still arrive afterwards.
    if (!Core.isAuthenticConnect(ev.data, NONCE)) return;
    const port = ev.ports && ev.ports[0];
    if (!port) return;

    state.port = port;
    state.rpc = Core.createRpcClient((msg) => port.postMessage(msg));
    port.onmessage = (e) => onInbound(e.data);
    refreshContext();
  });

  function onInbound(msg) {
    if (!Core.validateInbound(msg).ok) return;
    if (msg.kind === "response") {
      state.rpc.handleResponse(msg);
      return;
    }
    switch (msg.type) {
      case "CONTEXT_CHANGED":
        applyContext(msg.payload);
        return;
      case "SESSION_RESET":
        resetReview(RESET_COPY[msg.payload?.reason] || RESET_COPY.SOURCE_CHANGED);
        return;
    }
  }

  const RESET_COPY = {
    VIDEO_CHANGED: "New video. Marks and captured frames were cleared.",
    SOURCE_CHANGED: "The video source changed. Marks and captured frames were cleared.",
    PLAYER_MISSING: "The YouTube player went away. Marks and captured frames were cleared; capture resumes when a video plays.",
  };

  const CAPTURE_ERROR_COPY = {
    CAPTURE_BLOCKED: "Blocked: the browser won’t let the extension read frames from this video.",
    CAPTURE_FAILED: "Capture failed. Pause and play the video to retry.",
  };

  async function request(type, payload, key) {
    if (!state.rpc) throw Object.assign(new Error("NOT_CONNECTED"), { code: "NOT_CONNECTED" });
    return state.rpc.request(type, payload, { key });
  }

  async function refreshContext(key = "context") {
    try {
      applyContext(await request("GET_CONTEXT", undefined, key));
      return state.ctx;
    } catch (err) {
      if (err.code !== "SUPERSEDED" && err.code !== "CANCELLED") setStatus("Can’t read the YouTube player. Reload the page and reopen the panel.");
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------

  function applyContext(ctx) {
    if (!ctx) return;
    state.ctx = ctx;
    $("ctxTitle").textContent = ctx.title || "—";
    $("ctxChannel").textContent = ctx.channel || "—";
    $("ctxTime").textContent = ctx.hasPlayer
      ? `${Core.formatTime(ctx.currentTime)} / ${ctx.isLive ? "Live" : Core.formatTime(ctx.duration)}${ctx.adShowing ? " · Ad playing" : ""}`
      : "No player found";
    const cap = ctx.capture;
    $("bufferText").textContent = !cap
      ? "—"
      : cap.error
        ? CAPTURE_ERROR_COPY[cap.error] || "Capture stopped unexpectedly."
        : `${cap.running ? "Capturing" : "Paused"} · ${cap.bufferedFrames} frames buffered`;
    renderWindow();
  }

  // ---------------------------------------------------------------------------
  // Window selection
  // ---------------------------------------------------------------------------

  function currentWindow() {
    const { start, end } = state.marks;
    if (start !== null && end !== null) return { t0: start, t1: end, source: "marks" };
    if (start !== null && state.ctx?.currentTime != null) return { t0: start, t1: state.ctx.currentTime, source: "start" };
    if (end !== null) return { ...Core.lastSecondsWindow(end), source: "end" };
    const last = Core.lastSecondsWindow(state.ctx?.currentTime);
    return last ? { ...last, source: "last" } : null;
  }

  const WINDOW_ERRORS = {
    WINDOW_INVALID: "Play the video for a moment so the player time is available.",
    WINDOW_NEGATIVE: "The window starts before the video does.",
    WINDOW_REVERSED: "The end mark is at or before the start mark. Set them again.",
    WINDOW_TOO_LONG: `Windows can be at most ${Core.LIMITS.maxWindowSec} seconds. Move the marks closer together.`,
  };

  /** Explains an invalid window in terms of what the user did to produce it. */
  function windowError(win, reason) {
    if (reason === "WINDOW_REVERSED" && win.source !== "marks") return "Play the video past the moment you want to review.";
    return WINDOW_ERRORS[reason];
  }

  function renderWindow() {
    const win = currentWindow();
    const { start, end } = state.marks;
    $("markStartValue").textContent = start === null ? "Not set" : Core.formatPreciseTime(start);
    $("markEndValue").textContent = end === null ? "Not set" : Core.formatPreciseTime(end);
    $("btnClearMarks").disabled = start === null && end === null;
    if (!win) {
      $("windowText").textContent = "Waiting for the player time.";
      return;
    }
    const check = Core.validateWindow(win);
    const range = `${Core.formatPreciseTime(win.t0)} → ${Core.formatPreciseTime(win.t1)}`;
    const label = {
      last: `Last 12 seconds: ${range}`,
      marks: `Marked window: ${range}`,
      start: `From your start mark to now: ${range}`,
      end: `12 seconds before your end mark: ${range}`,
    }[win.source];
    $("windowText").textContent = check.ok ? label : `${label}. ${windowError(win, check.reason)}`;
  }

  async function mark(which) {
    const ctx = await refreshContext(`mark-${which}`);
    if (!ctx || ctx.currentTime == null) return;
    state.marks[which] = ctx.currentTime;
    renderWindow();
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  function setStatus(text) {
    $("statusText").textContent = text;
  }

  function setPhase(phase) {
    state.phase = phase;
    $("btnAnalyze").disabled = phase === "collecting";
    $("btnAnalyze").textContent = phase === "collecting" ? "Collecting…" : "Analyze";
  }

  async function analyze() {
    const ctx = await refreshContext();
    if (!ctx) return;
    if (!ctx.hasPlayer) {
      setStatus("No YouTube player on this page. Open a video and try again.");
      return;
    }
    const win = currentWindow();
    const check = Core.validateWindow(win);
    if (!check.ok) {
      setStatus(windowError(win, check.reason));
      return;
    }

    setPhase("collecting");
    setStatus("Collecting captured frames for the window…");
    let result;
    try {
      result = await request("GET_KEYFRAMES", { ...check.window, maxFrames: Core.LIMITS.analysisMaxFrames }, "analysis");
    } catch (err) {
      if (err.code === "SUPERSEDED" || err.code === "CANCELLED") return;
      setPhase("error");
      setStatus(err.code === "TIMEOUT" ? "The page didn’t answer in time. Try Analyze again." : "Couldn’t collect frames. Try Analyze again.");
      return;
    }
    if (state.ctx?.capture && result.generation !== state.ctx.capture.generation) {
      // The frames belong to a source that is no longer playing.
      setPhase("idle");
      setStatus("The video changed while collecting. Press Analyze again.");
      return;
    }
    renderEvidence(result);
  }

  function renderEvidence(result) {
    const n = result.frames.length;
    const { coverage } = result;
    const pct = Math.round(coverage.ratio * 100);
    setPhase("ready");

    $("verdictValue").textContent = n === 0 ? "NO EVIDENCE" : "INCONCLUSIVE";
    $("modePill").textContent = "EVIDENCE ONLY";
    $("meterFill").style.width = `${pct}%`;
    $("meterValue").textContent = `${pct}% of the window (${coverage.coveredSec.toFixed(1)} s) · ${n} frame${n === 1 ? "" : "s"}`;
    renderTimeline(result);

    const why = [];
    if (n === 0) {
      if (state.ctx?.capture?.error) why.push(CAPTURE_ERROR_COPY[state.ctx.capture.error] || "Capture stopped unexpectedly.");
      why.push("No frames were captured in this window. Capture only runs while this panel is open.");
      why.push("Replay the moment with the panel open, then press Analyze.");
      if (state.ctx?.isLive) why.push("This is a live stream. Only footage played while the panel was open can be reviewed.");
    } else {
      why.push(`${n} frame${n === 1 ? "" : "s"} cover ${coverage.coveredSec.toFixed(1)} of ${(result.window.t1 - result.window.t0).toFixed(1)} seconds.`);
      if (coverage.gaps.length) {
        const list = coverage.gaps.map((g) => `${Core.formatPreciseTime(g.from)}–${Core.formatPreciseTime(g.to)}`).join(", ");
        const evicted = result.buffer.full && result.buffer.from !== null && result.buffer.from > result.window.t0;
        why.push(
          evicted
            ? `Missing footage: ${list}. The buffer only holds the latest ${(result.buffer.to - result.buffer.from).toFixed(1)} seconds of footage at this playback speed, so the start of the window was overwritten. Choose a shorter window or replay at normal speed.`
            : `Missing footage: ${list}. Replay that part with the panel open to fill it.`
        );
      }
      if (state.ctx?.isLive) why.push("This is a live stream. Only footage played while the panel was open can be reviewed.");
      why.push("Automatic stumping decisions aren’t enabled in this version, so the result stays inconclusive.");
    }
    setWhyBullets(why);
    setStatus(n === 0 ? "Nothing captured for this window yet." : `Collected ${n} frames.`);
  }

  function renderTimeline(result) {
    const bar = $("timelineBar");
    bar.replaceChildren();
    const span = result.window.t1 - result.window.t0;
    const pos = (t) => `${((t - result.window.t0) / span) * 100}%`;
    for (const gap of result.coverage.gaps) {
      const el = document.createElement("div");
      el.className = "gap";
      el.style.left = pos(gap.from);
      el.style.width = `calc(${pos(gap.to)} - ${pos(gap.from)})`;
      bar.appendChild(el);
    }
    for (const f of result.frames) {
      const el = document.createElement("div");
      el.className = "tick";
      el.style.left = pos(f.mediaTime);
      bar.appendChild(el);
    }
    $("timelineLegend").textContent = `${Core.formatPreciseTime(result.window.t0)} → ${Core.formatPreciseTime(result.window.t1)} · ticks are captured frames, hatched areas are gaps.`;
  }

  function setWhyBullets(items) {
    const ul = $("whyBullets");
    ul.replaceChildren(
      ...items.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  function resetReview(statusText = "Ready.") {
    if (state.rpc) state.rpc.cancelAll("CANCELLED");
    state.marks = { start: null, end: null };
    setPhase("idle");
    $("verdictValue").textContent = "—";
    $("modePill").textContent = "WAITING";
    $("meterFill").style.width = "0%";
    $("meterValue").textContent = "—";
    $("timelineBar").replaceChildren();
    $("timelineLegend").textContent = "Captured frames and gaps appear here after Analyze.";
    setWhyBullets([
      "Nothing analyzed yet.",
      "Replay the dismissal with this panel open, then press Analyze.",
      "This version shows what the captured frames cover. It doesn’t decide OUT or NOT OUT.",
    ]);
    setStatus(statusText);
    renderWindow();
    if (state.rpc) refreshContext();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab.dataset.tab}`));
    });
  });

  $("btnClose").addEventListener("click", () => {
    if (state.rpc) state.rpc.cancelAll("CANCELLED");
    request("CLOSE", undefined, "close").catch(() => {});
  });
  $("btnLast12").addEventListener("click", () => {
    state.marks = { start: null, end: null };
    refreshContext();
  });
  $("btnMarkStart").addEventListener("click", () => mark("start"));
  $("btnMarkEnd").addEventListener("click", () => mark("end"));
  $("btnClearMarks").addEventListener("click", () => {
    state.marks = { start: null, end: null };
    renderWindow();
  });
  $("btnAnalyze").addEventListener("click", analyze);
  $("btnReset").addEventListener("click", () => resetReview());

  for (const [id, label] of [["btnAgree", "Agree"], ["btnDisagree", "Disagree"], ["btnNotSure", "Not sure"]]) {
    $(id).addEventListener("click", () => {
      $("feedbackText").textContent = `You chose “${label}”. Feedback isn’t saved in this version.`;
    });
  }

  resetReview();
})();
