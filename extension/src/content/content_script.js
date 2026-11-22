/**
 * Fan DRS Review - Content Script
 *
 * Owns everything that touches the YouTube page:
 *   - the status chip under the player ("● DRS ready" / "DRS off"), which
 *     also starts a review, and the reopen handle
 *   - capture policy: runs on cricket videos by itself, with per-video and
 *     per-channel overrides (docs/SPEC.md 4.1)
 *   - review triggers: chip, Alt+Shift+R (via the service worker), and the
 *     replay gesture of seeking back and pausing (SPEC 4.2)
 *   - the lazily created card iframe in a closed shadow root, joined by a
 *     nonce-authenticated MessageChannel
 *
 * Capture never seeks, never fetches media and never uploads anything.
 * Pure logic lives in src/shared (FanDRSCore, FanDRSReview).
 */
(function fanDrsContent() {
  "use strict";

  const Core = globalThis.FanDRSCore;
  const Review = globalThis.FanDRSReview;
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
  const TICK_MS = 500;
  const THUMB_WIDTH = 480;
  const JPEG_QUALITY = 0.7;

  const ids = Object.freeze({ button: "fan-drs-btn" });

  const ui = {
    open: false,
    everOpened: false,
    port: null,
    host: null,
    handle: null,
    iframe: null,
    nonce: null,
    tickTimer: null,
    lastContextKey: "",
    lastUrl: location.href,
    boundVideo: null,
    /** Generation whose reset the card has already been told about. */
    announcedGeneration: 0,
    /** Review waiting for the card to connect. */
    pendingReview: null,
    reviewSeq: 0,
  };

  const prefs = {
    /** videoId -> "on" | "off", for this tab's lifetime. */
    videoOverrides: new Map(),
    /** channel name -> "on" | "off", persisted. Null prototype: names like "constructor" are just names. */
    channelPrefs: Object.create(null),
  };

  const channelPref = (name) => (name && Object.hasOwn(prefs.channelPrefs, name) ? prefs.channelPrefs[name] : null);
  const toPrefs = (v) => Object.assign(Object.create(null), isPlainPrefs(v) ? v : {});

  // ---------------------------------------------------------------------------
  // Page reads
  // ---------------------------------------------------------------------------

  const isWatchPage = () => location.pathname === "/watch";
  const getVideoId = () => (isWatchPage() ? new URL(location.href).searchParams.get("v") : null);
  const getVideoEl = () => document.querySelector("video.html5-main-video");
  const isAdShowing = () => Boolean(document.querySelector("#movie_player.ad-showing"));
  // textContent, not innerText: this runs every tick and innerText forces layout.
  const text = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() || "";

  function pageMeta() {
    return {
      title: text("h1.ytd-watch-metadata"),
      channel: text("ytd-channel-name a"),
      description: text("#description-inline-expander, #description"),
    };
  }

  function capturePolicy() {
    const meta = pageMeta();
    const cricket = Review.cricketScore(meta);
    const videoId = getVideoId();
    const decision = Review.decideCapture({
      videoOverride: videoId ? prefs.videoOverrides.get(videoId) || null : null,
      channelPref: channelPref(meta.channel),
      cricket: cricket.isCricket,
    });
    return { ...decision, cricket, meta };
  }

  function getPlaybackContext() {
    const video = getVideoEl();
    const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const policy = capturePolicy();
    return {
      videoId: getVideoId(),
      title: policy.meta.title,
      channel: policy.meta.channel,
      hasPlayer: Boolean(video),
      currentTime: video ? finite(video.currentTime) : null,
      duration: video ? finite(video.duration) : null,
      isLive: Boolean(video && video.duration === Infinity),
      paused: video ? video.paused : null,
      adShowing: isAdShowing(),
      capture: {
        on: policy.on,
        reason: policy.reason,
        channelPref: channelPref(policy.meta.channel),
        running: session.running,
        generation: session.generation,
        bufferedFrames: ring.size,
        bufferedBytes: ring.bytes,
        error: session.lastError,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------

  let canvas = null;
  let ctx2d = null;

  function grabFrame(video) {
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (w <= 0 || h <= 0) return null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx2d = canvas.getContext("2d");
    }
    const tw = Math.min(THUMB_WIDTH, w);
    const th = Math.max(1, Math.round((h * tw) / w));
    canvas.width = tw;
    canvas.height = th;
    ctx2d.drawImage(video, 0, 0, tw, th);
    // Throws SecurityError if the frame is cross-origin; the session reports it.
    return { jpeg: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: tw, height: th };
  }

  const ring = Core.createFrameRing();
  const session = Core.createCaptureSession({
    ring,
    grab: grabFrame,
    isAdShowing,
    // The error is part of the context, so a card that connects late still sees it.
    onError: () => pushContextIfChanged(),
  });

  const replay = Review.createReplayDetector({ now: () => performance.now() });
  const onTimeUpdate = (ev) => replay.onTime(ev.target.currentTime);
  const onSeeking = (ev) => replay.onSeek(ev.target.currentTime);
  const onPause = () => {
    const hit = replay.onPause();
    // Never replace a review the viewer is looking at; they can press Review again.
    if (hit && session.running && !ui.open) openReview("replay-pause", hit.from);
  };

  function onVideoEmptied() {
    // The element was reused for a different source (autoplay, or YouTube
    // swapping the src after an SPA navigation). If this generation's reset
    // was already announced (the video ID changed first), drop the old
    // source's frames quietly; otherwise announce so the card is cleared too.
    const alreadyAnnounced = ui.announcedGeneration === session.generation;
    session.invalidate();
    replay.reset();
    // Only one quiet drop per announcement: the new generation is unannounced,
    // so the next genuine source change is reported.
    if (!alreadyAnnounced) announceReset("SOURCE_CHANGED");
  }

  function announceReset(reason) {
    ui.announcedGeneration = session.generation;
    ui.pendingReview = null;
    emit("SESSION_RESET", { reason });
  }

  const VIDEO_LISTENERS = [["emptied", onVideoEmptied], ["timeupdate", onTimeUpdate], ["seeking", onSeeking], ["pause", onPause]];

  function bindVideo(video) {
    if (ui.boundVideo === video) return;
    if (ui.boundVideo) for (const [type, fn] of VIDEO_LISTENERS) ui.boundVideo.removeEventListener(type, fn);
    ui.boundVideo = video;
    replay.reset();
    if (video) for (const [type, fn] of VIDEO_LISTENERS) video.addEventListener(type, fn);
  }

  /** Makes the capture session match the page and the capture policy. Safe to call often. */
  function reconcileCapture() {
    const video = getVideoEl();
    const videoId = getVideoId();
    if (!video || !videoId) {
      // Announce once; later ticks find nothing bound and stay quiet.
      const wasBound = session.video !== null;
      session.unbind();
      bindVideo(null);
      if (wasBound) announceReset("PLAYER_MISSING");
      return;
    }
    const changed = session.video !== null && (video !== session.video || videoId !== session.videoId);
    bindVideo(video);
    if (capturePolicy().on) {
      session.start(video, videoId);
    } else if (session.video !== video || session.videoId !== videoId) {
      // Bind to the new video without capturing, so frames never mix videos.
      session.start(video, videoId);
      session.stop();
    } else {
      session.stop();
    }
    if (changed) announceReset("VIDEO_CHANGED");
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  function loadPrefs() {
    chrome.storage.local.get("channelPrefs").then(
      (data) => {
        prefs.channelPrefs = toPrefs(data?.channelPrefs);
        onTick();
      },
      () => {}
    );
  }

  const isPlainPrefs = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => x === "on" || x === "off");

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.channelPrefs) {
      prefs.channelPrefs = toPrefs(changes.channelPrefs.newValue);
      onTick();
    }
  });

  /** scope: "video" | "channel"; value: "on" | "off" | null (clear). */
  async function setCapture(scope, value) {
    const videoId = getVideoId();
    const { channel } = pageMeta();
    if (scope === "video" && videoId) {
      if (value === null) prefs.videoOverrides.delete(videoId);
      else prefs.videoOverrides.set(videoId, value);
    } else if (scope === "channel" && channel) {
      const next = toPrefs(prefs.channelPrefs);
      if (value === null) delete next[channel];
      else next[channel] = value;
      prefs.channelPrefs = next;
      await chrome.storage.local.set({ channelPrefs: { ...next } });
    }
    onTick();
  }

  // ---------------------------------------------------------------------------
  // Bridge to the card
  // ---------------------------------------------------------------------------

  function emit(type, payload) {
    if (ui.port) ui.port.postMessage({ v: Core.PROTOCOL_VERSION, kind: "event", type, payload });
  }

  function respond(id, ok, payloadOrError) {
    if (!ui.port) return;
    const msg = { v: Core.PROTOCOL_VERSION, kind: "response", id, ok };
    if (ok) msg.payload = payloadOrError;
    else msg.error = payloadOrError;
    ui.port.postMessage(msg);
  }

  /** Keyframes for a window; image data only when asked for, capped for review. */
  function keyframes({ t0, t1, maxFrames, includeImages }) {
    reconcileCapture();
    const cap = includeImages ? Math.min(maxFrames, Review.LIMITS.reviewMaxFrames) : maxFrames;
    const result = Core.selectWindow(ring, session.generation, { t0, t1 }, cap);
    // Identity of the video these frames came from, so the card never labels
    // one video's frames with another's metadata.
    const { title, channel } = pageMeta();
    result.video = { id: session.videoId, title, channel };
    if (includeImages) {
      const byId = new Map(ring.framesFor(session.generation).map((f) => [f.id, f.jpeg]));
      result.frames = result.frames.map((f) => ({ ...f, jpeg: byId.get(f.id) }));
    }
    return result;
  }

  async function handleRequest(msg) {
    const check = Core.validateRequest(msg);
    if (!check.ok) {
      if (Number.isSafeInteger(msg?.id)) respond(msg.id, false, check.reason);
      return;
    }
    switch (msg.type) {
      case "GET_CONTEXT":
        respond(msg.id, true, getPlaybackContext());
        return;
      case "GET_KEYFRAMES":
        respond(msg.id, true, keyframes(msg.payload));
        return;
      case "SET_CAPTURE":
        try {
          await setCapture(msg.payload.scope, msg.payload.value);
          respond(msg.id, true, getPlaybackContext());
        } catch {
          respond(msg.id, false, "PREF_SAVE_FAILED");
        }
        return;
      case "CLOSE":
        respond(msg.id, true, null);
        setOpen(false);
        return;
    }
  }

  function connectCard(iframe) {
    if (ui.port) ui.port.close();
    const channel = new MessageChannel();
    ui.port = channel.port1;
    ui.port.onmessage = (ev) => handleRequest(ev.data);
    // Targeted at the extension origin, so the page cannot receive the port.
    iframe.contentWindow.postMessage({ fanDRS: "connect", v: Core.PROTOCOL_VERSION, nonce: ui.nonce }, EXTENSION_ORIGIN, [channel.port2]);
    ui.lastContextKey = "";
    pushContextIfChanged();
    if (ui.pendingReview) {
      emit("REVIEW_REQUESTED", ui.pendingReview);
      ui.pendingReview = null;
    }
  }

  function pushContextIfChanged() {
    if (!ui.port) return;
    const ctx = getPlaybackContext();
    const key = JSON.stringify([ctx.videoId, ctx.title, ctx.channel, ctx.currentTime, ctx.duration, ctx.paused, ctx.adShowing, ctx.capture]);
    if (key === ui.lastContextKey) return;
    ui.lastContextKey = key;
    emit("CONTEXT_CHANGED", ctx);
  }

  // ---------------------------------------------------------------------------
  // Review
  // ---------------------------------------------------------------------------

  /**
   * Opens the card on a 12 s window ending now, or, for a replay pause, ending
   * where the viewer seeked back from. trigger: chip | shortcut | replay-pause.
   */
  function openReview(trigger, replayFrom = null) {
    const video = getVideoEl();
    const videoId = getVideoId();
    if (!video || !videoId) return;
    if (!capturePolicy().on) setCapture("video", "on");
    const now = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const review = { id: ++ui.reviewSeq, ...Review.reviewWindow(now, replayFrom), trigger, generation: session.generation };
    setOpen(true);
    if (ui.port) emit("REVIEW_REQUESTED", review);
    else ui.pendingReview = review;
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.fanDRS !== "review") return;
    openReview("shortcut");
  });

  // ---------------------------------------------------------------------------
  // UI mounting
  // ---------------------------------------------------------------------------

  function ensureButton() {
    if (!getVideoId() || document.getElementById(ids.button)) return;
    const actions =
      document.querySelector("#top-level-buttons-computed") ||
      document.querySelector("ytd-menu-renderer #top-level-buttons-computed") ||
      document.querySelector("#actions");
    if (!actions) return;

    const btn = document.createElement("button");
    btn.id = ids.button;
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", String(ui.open));
    btn.style.cssText = `
      margin-left: 8px; padding: 8px 12px; border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.15); background: rgba(30,30,40,0.9);
      color: #fff; font: 600 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      cursor: pointer; white-space: nowrap;
    `;
    btn.addEventListener("click", () => openReview("chip"));
    actions.appendChild(btn);
    renderChip();
  }

  function renderChip() {
    const btn = document.getElementById(ids.button);
    if (!btn) return;
    const on = session.running;
    const label = on ? "● DRS ready" : "DRS off";
    if (btn.textContent !== label) btn.textContent = label;
    btn.style.color = on ? "#7ff0c4" : "#fff";
    btn.title = on ? "Capturing the last few seconds. Click to review this moment (Alt+Shift+R)." : "Not capturing on this video. Click to start capturing and review.";
  }

  function ensurePanel() {
    if (ui.host && ui.host.isConnected) return;

    const host = document.createElement("div");
    host.setAttribute("role", "complementary");
    host.setAttribute("aria-label", "Fan DRS Review");
    host.style.cssText = `
      position: fixed; top: 0; right: 0; height: 100vh; width: min(440px, 100vw); box-sizing: border-box;
      z-index: 2147483647; transform: translateX(100%); visibility: hidden;
      transition: transform 180ms ease-out, visibility 0s linear 180ms;
      box-shadow: -10px 0 30px rgba(0,0,0,0.35); background: rgba(16,16,22,0.98);
      border-left: 1px solid rgba(255,255,255,0.08);
    `;

    // The iframe sits in a closed shadow root created from this isolated world,
    // so page scripts can't read its src. The nonce in the fragment is the
    // shared secret that authenticates the connect handshake.
    ui.nonce = crypto.randomUUID();
    const shadow = host.attachShadow({ mode: "closed" });
    const iframe = document.createElement("iframe");
    iframe.title = "Fan DRS Review";
    iframe.allow = "clipboard-write";
    iframe.style.cssText = "display: block; width: 100%; height: 100%; border: 0; background: transparent;";
    iframe.addEventListener("load", () => connectCard(iframe));
    iframe.src = `${chrome.runtime.getURL("src/sidebar/sidebar.html")}#${ui.nonce}`;
    shadow.appendChild(iframe);

    const handle = document.createElement("button");
    handle.type = "button";
    handle.textContent = "DRS";
    handle.setAttribute("aria-label", "Open Fan DRS Review");
    handle.style.cssText = `
      position: fixed; right: 8px; top: 40%; z-index: 2147483647; display: none;
      padding: 8px 10px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.15);
      background: rgba(30,30,40,0.88); color: #fff;
      font: 700 12px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; cursor: pointer;
    `;
    handle.addEventListener("click", () => setOpen(true));

    document.documentElement.appendChild(host);
    document.documentElement.appendChild(handle);
    ui.host = host;
    ui.handle = handle;
    ui.iframe = iframe;
  }

  function setOpen(open, { restoreFocus = true } = {}) {
    if (open && !getVideoId()) return;
    if (open) ensurePanel();
    const { host, handle } = ui;
    const btn = document.getElementById(ids.button);
    if (!host || !handle) return;

    const wasOpen = ui.open;
    ui.open = open;
    if (open) ui.everOpened = true;

    host.style.transform = open ? "translateX(0)" : "translateX(100%)";
    host.style.visibility = open ? "visible" : "hidden";
    // A closed panel can't hold focus or be reached by keyboard or screen reader.
    host.inert = !open;
    host.style.transitionDelay = open ? "0s" : "0s, 180ms";
    handle.style.display = !open && ui.everOpened && getVideoId() ? "block" : "none";
    if (btn) btn.setAttribute("aria-expanded", String(open));

    if (open) {
      pushContextIfChanged();
      if (!wasOpen) ui.iframe?.focus();
    } else if (wasOpen && restoreFocus) {
      // The host is inert now, so focus can't stay inside the panel.
      (btn && btn.isConnected ? btn : handle).focus();
    }
  }

  function onTick() {
    if (!getVideoId()) return;
    reconcileCapture();
    renderChip();
    pushContextIfChanged();
  }

  function startTicking() {
    if (ui.tickTimer === null) ui.tickTimer = setInterval(onTick, TICK_MS);
  }

  /** Removes everything when leaving watch pages. */
  function unmount() {
    setOpen(false, { restoreFocus: false });
    if (ui.tickTimer !== null) clearInterval(ui.tickTimer);
    ui.tickTimer = null;
    session.unbind();
    bindVideo(null);
    document.getElementById(ids.button)?.remove();
    ui.host?.remove();
    ui.handle?.remove();
    ui.host = null;
    ui.handle = null;
    if (ui.port) ui.port.close();
    ui.port = null;
    ui.iframe = null;
    ui.nonce = null;
    ui.pendingReview = null;
    ui.everOpened = false;
  }

  // ---------------------------------------------------------------------------
  // SPA navigation: YouTube swaps routes and re-renders the actions bar.
  // ---------------------------------------------------------------------------

  function reconcilePage() {
    if (location.href !== ui.lastUrl) {
      ui.lastUrl = location.href;
      if (!getVideoId()) {
        unmount();
        return;
      }
    }
    if (getVideoId()) {
      ensureButton();
      startTicking();
    }
  }

  let reconcileQueued = false;
  function queueReconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    requestAnimationFrame(() => {
      reconcileQueued = false;
      reconcilePage();
    });
  }

  document.addEventListener("yt-navigate-finish", queueReconcile);
  window.addEventListener("popstate", queueReconcile);
  new MutationObserver(queueReconcile).observe(document.documentElement, { childList: true, subtree: true });
  loadPrefs();
  queueReconcile();
})();
