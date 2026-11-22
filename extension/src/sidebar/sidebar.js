/**
 * Fan DRS Review - review card controller.
 *
 * Joins the content script over a nonce-authenticated MessageChannel (see
 * the content script), then:
 *   - shows capture state with the per-video and per-channel overrides
 *   - on REVIEW_REQUESTED, fetches the window's frames, runs the detectors
 *     (FanDRSVision) and renders the strip, stage, bracket, crease, grounding
 *     question and finding
 *   - lets the viewer correct any detector output; every change recomputes the
 *     finding (FanDRSReview.decideFinding: always inconclusive in the beta) and
 *     the evidence packet
 *
 * Decoding and detection run here, in the extension page, never in the
 * YouTube page.
 */
(function fanDrsCard() {
  "use strict";

  const Core = globalThis.FanDRSCore;
  const Vision = globalThis.FanDRSVision;
  const Review = globalThis.FanDRSReview;
  const YOUTUBE_ORIGIN = "https://www.youtube.com";
  // Shared secret from the content script, delivered in our URL fragment.
  const NONCE = location.hash.slice(1);
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);

  const state = {
    port: null,
    rpc: null,
    ctx: null,
    /** The active review, or null. Replaced wholesale by each new review. */
    review: null,
    /** Bumped by every new review and every reset; async work checks it after each await. */
    reviewSeq: 0,
    pickingCrease: null, // null | [] | [{x, y}]
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
    state.rpc = Core.createRpcClient((msg) => port.postMessage(msg), { timeoutMs: 4000 });
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
        clearReview(RESET_COPY[msg.payload?.reason] || RESET_COPY.SOURCE_CHANGED);
        return;
      case "REVIEW_REQUESTED":
        runReview(msg.payload);
        return;
    }
  }

  const RESET_COPY = {
    VIDEO_CHANGED: "New video. The previous review was cleared.",
    SOURCE_CHANGED: "The video source changed. The previous review was cleared.",
    PLAYER_MISSING: "The YouTube player went away. The previous review was cleared.",
  };

  const request = (type, payload, key) => {
    if (!state.rpc) return Promise.reject(Object.assign(new Error("NOT_CONNECTED"), { code: "NOT_CONNECTED" }));
    return state.rpc.request(type, payload, { key });
  };

  const quiet = (err) => err && (err.code === "SUPERSEDED" || err.code === "CANCELLED");

  async function refreshContext() {
    try {
      applyContext(await request("GET_CONTEXT", undefined, "context"));
    } catch (err) {
      if (!quiet(err)) setStatus("Can’t read the YouTube player. Reload the page and try again.");
    }
  }

  // ---------------------------------------------------------------------------
  // Capture state
  // ---------------------------------------------------------------------------

  const REASON_LABEL = {
    CRICKET: "cricket detected",
    NOT_CRICKET: "not detected as cricket",
    VIDEO_ON: "on for this video",
    VIDEO_OFF: "off for this video",
    CHANNEL_ON: "on for this channel",
    CHANNEL_OFF: "off for this channel",
  };

  const CAPTURE_ERROR_COPY = {
    CAPTURE_BLOCKED: "Blocked: the browser won’t let the extension read frames from this video.",
    CAPTURE_FAILED: "Capture failed. Pause and play the video to retry.",
  };

  function applyContext(ctx) {
    if (!ctx) return;
    state.ctx = ctx;
    const cap = ctx.capture;
    const pill = $("capturePill");
    if (!ctx.hasPlayer) {
      pill.textContent = "No player found";
      pill.className = "pill off";
    } else if (cap.error) {
      pill.textContent = CAPTURE_ERROR_COPY[cap.error] || "Capture stopped unexpectedly.";
      pill.className = "pill off";
    } else if (cap.on) {
      pill.textContent = `● Capturing · ${REASON_LABEL[cap.reason]} · ${cap.bufferedFrames} frames`;
      pill.className = "pill on";
    } else {
      pill.textContent = `Not capturing · ${REASON_LABEL[cap.reason]}`;
      pill.className = "pill off";
    }
    $("btnCapture").textContent = cap.on ? "Turn off for this video" : "Turn on for this video";
    $("btnCapture").disabled = !ctx.hasPlayer;
    $("rememberChannel").checked = cap.channelPref !== null;
    $("rememberChannel").disabled = !ctx.channel;
    $("rememberLabel").textContent = ctx.channel ? `Remember for ${ctx.channel}` : "Remember for this channel";
  }

  async function setCapture(scope, value) {
    try {
      applyContext(await request("SET_CAPTURE", { scope, value }, `capture-${scope}`));
    } catch (err) {
      if (!quiet(err)) setStatus("Couldn’t change the capture setting.");
    }
  }

  // ---------------------------------------------------------------------------
  // Review
  // ---------------------------------------------------------------------------

  const TRIGGER_LABEL = { chip: "from the DRS button", shortcut: "from the keyboard shortcut", "replay-pause": "from your replay pause", card: "from this panel" };

  async function decodeGray(jpeg) {
    const bitmap = await createImageBitmap(await (await fetch(jpeg)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return Vision.toGray(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  async function runReview(req) {
    const seq = ++state.reviewSeq;
    const current = () => seq === state.reviewSeq;
    state.review = null;
    state.pickingCrease = null;
    $("emptyView").hidden = true;
    $("reviewView").hidden = false;
    $("windowLabel").textContent = `Reviewing ${Core.formatPreciseTime(req.t0)} → ${Core.formatPreciseTime(req.t1)} · ${TRIGGER_LABEL[req.trigger] || ""}`;
    setVerdictText("Analyzing…");
    setStatus("Collecting frames…");

    let result;
    try {
      result = await request("GET_KEYFRAMES", { t0: req.t0, t1: req.t1, maxFrames: Review.LIMITS.reviewMaxFrames, includeImages: true }, "review");
    } catch (err) {
      if (current() && !quiet(err)) setStatus(err.code === "TIMEOUT" ? "The page didn’t answer in time. Try again." : "Couldn’t collect frames. Try again.");
      return;
    }
    if (!current()) return;
    if (Number.isInteger(req.generation) && result.generation !== req.generation) {
      // The video changed between the request and the answer.
      setVerdictText("—");
      setStatus("The video changed before the review finished. Review again.");
      return;
    }
    if (result.frames.length === 0) {
      state.review = null;
      renderNoFrames(req);
      return;
    }

    let grays;
    try {
      grays = await Promise.all(result.frames.map((f) => decodeGray(f.jpeg)));
    } catch {
      if (current()) setStatus("Couldn’t read the captured frames.");
      return;
    }
    if (!current()) return;
    // YouTube can switch quality mid-window. Detectors compare like with like,
    // so keep the frames that match the most recent size and say so.
    const last = grays[grays.length - 1];
    const all = result.frames.map((f, i) => ({ id: f.id, t: f.mediaTime, jpeg: f.jpeg, gray: grays[i] }));
    const frames = all.filter((f) => f.gray.width === last.width && f.gray.height === last.height);
    const dropped = all.length - frames.length;
    const review = { req, video: result.video, frames, coverage: result.coverage, width: last.width, height: last.height };
    detect(review);
    review.selected = review.bracket ? review.bracket.lastOn : frames.length - 1;
    review.grounded = null;
    state.review = review;
    renderReview();
    setStatus(`Analyzed ${frames.length} frames.${dropped ? ` ${dropped} frames were skipped because the video quality changed.` : ""}`);
  }

  /** Runs the detectors and stores their output (or abstention reasons) on the review. */
  function detect(review) {
    const grays = review.frames.map((f) => f.gray);
    review.cuts = Vision.detectCuts(grays);

    // Stumps: try a few frames spread across the window; the first hit wins.
    review.stumps = null;
    const tries = [0.5, 0.25, 0.75, 0.1, 0.9].map((p) => Math.round(p * (grays.length - 1)));
    for (const i of tries) {
      const s = Vision.detectStumps(grays[i]);
      if (s.ok) {
        review.stumps = s;
        break;
      }
    }

    review.bracket = null;
    review.bailReason = "STUMPS_NOT_FOUND";
    if (review.stumps) {
      const b = Vision.detectBailOff(grays, Vision.bailRegion(review.stumps, grays[0]), { cuts: review.cuts });
      // A candidate only: the detector sees pixels change near the bails, which a
      // glove can also cause. It supports nothing until the viewer confirms it.
      if (b.ok) review.bracket = { lastOn: b.lastOn, firstOff: b.firstOff, source: "detector", confidence: b.confidence, confirmed: false };
      else review.bailReason = b.reason;
    }

    const at = review.bracket ? review.bracket.lastOn : Math.floor(grays.length / 2);
    const c = Vision.detectCrease(grays[at], { exclude: review.stumps ? review.stumps.rect : null });
    review.crease = c.ok ? { line: c.line, source: "detector", confidence: c.confidence } : null;
    review.creaseReason = c.ok ? null : c.reason;
    updateHint(review);
  }

  function updateHint(review) {
    const at = review.bracket ? review.bracket.lastOn : review.selected ?? Math.floor(review.frames.length / 2);
    review.hint = Vision.groundingHint(review.frames[at].gray, review.crease ? review.crease.line : null, review.stumps);
  }

  function evaluate(review) {
    const times = review.frames.map((f) => ({ id: f.id, t: f.t }));
    const b = review.bracket;
    const check = Review.validateBracket(times, b ? b.lastOn : null, b ? b.firstOff : null, review.cuts);
    const finding = Review.decideFinding(check, {
      bracket: b,
      times: review.frames.map((f) => f.t),
      creaseSource: review.crease ? review.crease.source : null,
      grounded: review.grounded,
      formatTime: Core.formatPreciseTime,
    });
    const packet = Review.buildEvidencePacket({
      video: review.video,
      window: { t0: review.req.t0, t1: review.req.t1 },
      trigger: review.req.trigger,
      capture: review.coverage,
      frames: times,
      bracket: b,
      bracketCheck: check,
      crease: review.crease ? { line: review.crease.line, width: review.width, height: review.height, source: review.crease.source } : null,
      grounded: review.grounded,
      hint: review.hint && review.hint.value !== "unknown" ? review.hint : null,
      finding,
    });
    return { check, finding, packet };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const BAIL_REASON_COPY = {
    STUMPS_NOT_FOUND: "The stumps weren’t found in these frames, so the bail-off moment wasn’t detected.",
    NO_BAIL_CHANGE: "No frame shows the bails coming off.",
    BAIL_CHANGE_AT_EDGE: "The bails change at the very end of the window. Review from a moment slightly later.",
    BAIL_CHANGE_NOT_SUSTAINED: "Something passed over the bails, but they didn’t stay off.",
    BAIL_CHANGE_AMBIGUOUS: "More than one moment looks like the bails coming off.",
    CUT_AFTER_BAIL_CHANGE: "The camera cuts right after the bails change.",
    CUT_BEFORE_BAIL_CHANGE: "The camera cuts right before the bails change.",
    TOO_FEW_FRAMES: "Too few frames were captured.",
  };

  const CREASE_REASON_COPY = {
    CREASE_NOT_FOUND: "No crease line was found.",
    CREASE_TOO_SHORT: "No long straight line was found.",
    CREASE_AMBIGUOUS: "Several lines look like the crease.",
  };

  const HINT_COPY = { behind: "Suggestion from the frame: behind the crease.", "not-behind": "Suggestion from the frame: not behind the crease." };

  function renderNoFrames(req) {
    $("strip").replaceChildren();
    $("stageImg").removeAttribute("src");
    $("stageOverlay").replaceChildren();
    $("stageCaption").textContent = "";
    $("bracketText").textContent = "";
    $("creaseText").textContent = "";
    $("hintText").textContent = "";
    setVerdictText("NO FRAMES");
    $("btnConfirmBracket").hidden = true;
    setList("observations", []);
    setList("notEstablished", []);
    setList("openItems", [
      state.ctx && !state.ctx.capture.on ? "Capture was off for this video. It’s on now; replay the moment and review again." : "Nothing was captured in this window. Replay the moment and review again.",
    ]);
    setStatus(`No frames between ${Core.formatPreciseTime(req.t0)} and ${Core.formatPreciseTime(req.t1)}.`);
  }

  function renderReview() {
    const r = state.review;
    if (!r) return;
    renderStrip(r);
    renderStage(r);

    const b = r.bracket;
    const { check, finding, packet } = evaluate(r);
    r.packet = packet;
    if (b) {
      // The detector's confidence is a ranking score, not a probability, so it isn't shown.
      const span = `bails on at ${Core.formatPreciseTime(r.frames[b.lastOn].t)}, a bail off at ${Core.formatPreciseTime(r.frames[b.firstOff].t)} (${check.gapMs} ms apart)`;
      $("bracketText").textContent =
        b.source === "viewer" ? `Marked by you: ${span}.` :
        b.confirmed ? `Confirmed by you: ${span}.` :
        `Candidate, detected automatically: ${span}. Something over the bails can look the same, so check both frames, then confirm or mark them yourself.`;
    } else {
      $("bracketText").textContent = `${BAIL_REASON_COPY[r.bailReason] || "Not detected."} Select frames in the strip and mark them below.`;
    }
    $("btnConfirmBracket").hidden = !(b && b.source === "detector" && !b.confirmed);

    const creaseText = r.crease
      ? r.crease.source === "detector"
        ? "Detected. If the line isn’t on the crease, set it yourself."
        : "Set by you."
      : `${CREASE_REASON_COPY[r.creaseReason] || "Not set."} Click two points on the crease in the frame.`;
    $("creaseText").textContent = state.pickingCrease ? `Click point ${state.pickingCrease.length + 1} of 2 on the crease.` : creaseText;
    $("btnSetCrease").setAttribute("aria-pressed", String(Boolean(state.pickingCrease)));
    $("btnClearCrease").disabled = !r.crease;
    $("stageBox").classList.toggle("picking", Boolean(state.pickingCrease));

    $("hintText").textContent = r.hint && HINT_COPY[r.hint.value] ? `${HINT_COPY[r.hint.value]} Check the frames and choose.` : "Look at the bail-on and bail-off frames and choose.";
    for (const input of document.querySelectorAll('input[name="grounded"]')) input.checked = input.value === r.grounded;

    setVerdictText("INCONCLUSIVE");
    setList("observations", finding.observations.length ? finding.observations : ["Nothing confirmed yet."]);
    setList("openItems", finding.open.length ? finding.open.map((o) => o.text) : ["Nothing open on your side."]);
    setList("notEstablished", finding.notEstablished);
    $("packetFallback").hidden = true;
  }

  function renderStrip(r) {
    const strip = $("strip");
    const b = r.bracket;
    const items = r.frames.map((f, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(i === r.selected));
      btn.tabIndex = -1;
      if (b && i === b.lastOn) btn.classList.add("on");
      if (b && i === b.firstOff) btn.classList.add("off");
      if (r.cuts.has(i)) btn.classList.add("cut");
      const pre = b && b.source === "detector" && !b.confirmed ? "candidate " : "";
      const label = `${Core.formatPreciseTime(f.t)}${b && i === b.lastOn ? `, ${pre}last bail on` : ""}${b && i === b.firstOff ? `, ${pre}first bail off` : ""}${r.cuts.has(i) ? ", after a camera cut" : ""}`;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      const img = document.createElement("img");
      img.alt = "";
      img.src = f.jpeg;
      btn.appendChild(img);
      btn.addEventListener("click", () => select(i));
      return btn;
    });
    strip.replaceChildren(...items);
    items[r.selected]?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function renderStage(r) {
    const f = r.frames[r.selected];
    $("stageImg").src = f.jpeg;
    $("stageImg").alt = `Frame at ${Core.formatPreciseTime(f.t)}`;
    const b = r.bracket;
    const pre = b && b.source === "detector" && !b.confirmed ? "candidate " : "";
    const role = b && r.selected === b.lastOn ? ` · ${pre}last bail on` : b && r.selected === b.firstOff ? ` · ${pre}first bail off` : "";
    $("stageCaption").textContent = `${Core.formatPreciseTime(f.t)} · frame ${r.selected + 1} of ${r.frames.length}${role}`;

    const svg = $("stageOverlay");
    svg.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const shapes = [];
    if (r.crease) shapes.push(svgEl("line", { ...r.crease.line, stroke: "#2de0a7", "stroke-width": Math.max(1.5, r.width / 240), "stroke-dasharray": "6 4" }));
    for (const p of state.pickingCrease || []) shapes.push(svgEl("circle", { cx: p.x, cy: p.y, r: Math.max(3, r.width / 120), fill: "#2de0a7" }));
    if (r.stumps) shapes.push(svgEl("rect", { ...r.stumps.rect, fill: "none", stroke: "rgba(255,255,255,0.5)", "stroke-width": 1 }));
    svg.replaceChildren(...shapes);
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function setVerdictText(text) {
    $("verdict").textContent = text;
  }

  function setList(id, items) {
    $(id).replaceChildren(
      ...items.map((t) => {
        const li = document.createElement("li");
        li.textContent = t;
        return li;
      })
    );
  }

  function setStatus(text) {
    $("statusText").textContent = text;
  }

  function clearReview(statusText) {
    state.reviewSeq++;
    if (state.rpc) state.rpc.cancelAll("CANCELLED");
    state.review = null;
    state.pickingCrease = null;
    $("reviewView").hidden = true;
    $("emptyView").hidden = false;
    setStatus(statusText || "");
    if (state.rpc) refreshContext();
  }

  // ---------------------------------------------------------------------------
  // Viewer actions
  // ---------------------------------------------------------------------------

  function select(i) {
    const r = state.review;
    if (!r || i < 0 || i >= r.frames.length) return;
    r.selected = i;
    renderReview();
    $("strip").querySelectorAll(".thumb")[i]?.focus({ preventScroll: true });
  }

  function setBracketEnd(which) {
    const r = state.review;
    if (!r) return;
    const b = r.bracket || { lastOn: null, firstOff: null };
    const next = { ...b, [which]: r.selected, source: "viewer", confidence: null, confirmed: true };
    if (which === "lastOn" && (next.firstOff === null || next.firstOff <= r.selected)) next.firstOff = Math.min(r.selected + 1, r.frames.length - 1);
    if (which === "firstOff" && (next.lastOn === null || next.lastOn >= r.selected)) next.lastOn = Math.max(r.selected - 1, 0);
    r.bracket = next;
    r.grounded = null; // the answer was about the old frames
    updateHint(r);
    renderReview();
  }

  function stagePoint(ev) {
    const r = state.review;
    const img = $("stageImg");
    const box = img.getBoundingClientRect();
    // object-fit: contain -> letterboxed content rectangle
    const scale = Math.min(box.width / r.width, box.height / r.height);
    const offX = (box.width - r.width * scale) / 2;
    const offY = (box.height - r.height * scale) / 2;
    const x = (ev.clientX - box.left - offX) / scale;
    const y = (ev.clientY - box.top - offY) / scale;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  $("stageBox").addEventListener("click", (ev) => {
    const r = state.review;
    if (!r || !state.pickingCrease) return;
    const p = stagePoint(ev);
    if (!p) return;
    state.pickingCrease.push(p);
    if (state.pickingCrease.length === 2) {
      const [a, b] = state.pickingCrease;
      state.pickingCrease = null;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 8) {
        setStatus("Those points are too close together. Set the crease again.");
      } else {
        r.crease = { line: extendLine(a, b, r.width, r.height), source: "viewer", confidence: null };
        r.grounded = null; // "behind the crease" now means a different line
        updateHint(r);
        setStatus("Crease set.");
      }
    }
    renderReview();
  });

  /** Extends the segment a-b to the frame edges. */
  function extendLine(a, b, w, h) {
    const t = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2; // normal angle
    const rho = a.x * Math.cos(t) + a.y * Math.sin(t);
    return Vision.lineInFrame(t, rho, w, h) || { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  $("strip").addEventListener("keydown", (ev) => {
    const r = state.review;
    if (!r) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(ev.key in moves)) return;
    ev.preventDefault();
    const d = moves[ev.key];
    select(d === -Infinity ? 0 : d === Infinity ? r.frames.length - 1 : r.selected + d);
  });

  $("btnSetOn").addEventListener("click", () => setBracketEnd("lastOn"));
  $("btnConfirmBracket").addEventListener("click", () => {
    const r = state.review;
    if (!r || !r.bracket) return;
    r.bracket = { ...r.bracket, confirmed: true };
    setStatus("Bail-off frames confirmed.");
    renderReview();
  });
  $("btnSetOff").addEventListener("click", () => setBracketEnd("firstOff"));
  $("btnSetCrease").addEventListener("click", () => {
    if (!state.review) return;
    state.pickingCrease = state.pickingCrease ? null : [];
    renderReview();
  });
  $("btnClearCrease").addEventListener("click", () => {
    const r = state.review;
    if (!r) return;
    r.crease = null;
    r.creaseReason = null;
    r.grounded = null;
    updateHint(r);
    renderReview();
  });
  for (const input of document.querySelectorAll('input[name="grounded"]')) {
    input.addEventListener("change", () => {
      if (!state.review) return;
      state.review.grounded = input.value;
      renderReview();
    });
  }

  $("btnCopy").addEventListener("click", async () => {
    const r = state.review;
    if (!r || !r.packet) return;
    const json = JSON.stringify(r.packet, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setStatus("Evidence copied. Paste it into a chat or a bug report.");
    } catch {
      const ta = $("packetFallback");
      ta.value = json;
      ta.hidden = false;
      ta.select();
      setStatus("Copying was blocked. The evidence is selected below; press Cmd/Ctrl+C.");
    }
  });

  async function reviewFromCard() {
    await refreshContext(); // fresh playback time, not the last 500 ms tick
    const ctx = state.ctx;
    if (!ctx || !Number.isFinite(ctx.currentTime)) {
      setStatus("Play the video first.");
      return;
    }
    if (!ctx.capture.on) await setCapture("video", "on");
    runReview({ ...Review.reviewWindow(ctx.currentTime), trigger: "card", generation: state.ctx.capture.generation });
  }
  $("btnReviewNow").addEventListener("click", reviewFromCard);
  $("btnReviewAgain").addEventListener("click", reviewFromCard);

  $("btnCapture").addEventListener("click", () => setCapture("video", state.ctx?.capture.on ? "off" : "on"));
  $("rememberChannel").addEventListener("change", (ev) => setCapture("channel", ev.target.checked ? (state.ctx?.capture.on ? "on" : "off") : null));

  $("btnClose").addEventListener("click", () => {
    request("CLOSE", undefined, "close").catch(() => {});
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (state.pickingCrease) {
        state.pickingCrease = null;
        renderReview();
      } else request("CLOSE", undefined, "close").catch(() => {});
    }
  });
})();
