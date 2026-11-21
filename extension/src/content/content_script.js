/**
 * Fan DRS Review - Content Script
 *
 * Owns everything that touches the YouTube page:
 *   - the "Fan DRS Review" button under the player and the reopen handle
 *   - the lazily created sidebar iframe (an extension page)
 *   - one capture session bound to the current <video> and video ID
 *   - a private MessageChannel to the sidebar (no window-wide postMessage)
 *
 * Capture runs only while the panel is open, never seeks, and never fetches
 * or uploads media. Pure logic lives in src/shared/core.js (FanDRSCore).
 */
(function fanDrsContent() {
  "use strict";

  const Core = globalThis.FanDRSCore;
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
  const CONTEXT_TICK_MS = 500;
  const THUMB_WIDTH = 320;
  const JPEG_QUALITY = 0.6;

  const ids = Object.freeze({
    button: "fan-drs-btn",
    host: "fan-drs-sidebar-host",
    iframe: "fan-drs-sidebar",
    handle: "fan-drs-handle",
  });

  const ui = {
    open: false,
    everOpened: false,
    port: null,
    tickTimer: null,
    lastContextKey: "",
    lastUrl: location.href,
    boundVideo: null,
  };

  // ---------------------------------------------------------------------------
  // Page reads
  // ---------------------------------------------------------------------------

  const isWatchPage = () => location.pathname === "/watch";
  const getVideoId = () => (isWatchPage() ? new URL(location.href).searchParams.get("v") : null);
  const getVideoEl = () => document.querySelector("video.html5-main-video");
  const isAdShowing = () => Boolean(document.querySelector("#movie_player.ad-showing"));

  function getPlaybackContext() {
    const video = getVideoEl();
    const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      videoId: getVideoId(),
      title: document.querySelector("h1.ytd-watch-metadata")?.innerText?.trim() || "",
      channel: document.querySelector("ytd-channel-name a")?.innerText?.trim() || "",
      hasPlayer: Boolean(video),
      currentTime: video ? finite(video.currentTime) : null,
      duration: video ? finite(video.duration) : null,
      isLive: Boolean(video && video.duration === Infinity),
      paused: video ? video.paused : null,
      adShowing: isAdShowing(),
      capture: {
        running: session.running,
        generation: session.generation,
        bufferedFrames: ring.size,
        bufferedBytes: ring.bytes,
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
    onError: (code) => emit("CAPTURE_ERROR", { code }),
  });

  function onVideoEmptied() {
    // The element was reused for a different source (e.g. autoplay).
    session.invalidate();
    emit("SESSION_RESET", { reason: "SOURCE_CHANGED" });
  }

  function bindVideo(video) {
    if (ui.boundVideo === video) return;
    if (ui.boundVideo) ui.boundVideo.removeEventListener("emptied", onVideoEmptied);
    ui.boundVideo = video;
    if (video) video.addEventListener("emptied", onVideoEmptied);
  }

  /** Makes the capture session match the current page. Safe to call often. */
  function reconcileCapture() {
    if (!ui.open) {
      session.stop();
      return;
    }
    const video = getVideoEl();
    const videoId = getVideoId();
    const changed = video !== session.video || videoId !== session.videoId;
    const hadSession = session.generation > 0;
    const started = session.start(video, videoId);
    bindVideo(started ? video : null);
    if (changed && hadSession) emit("SESSION_RESET", { reason: video ? "VIDEO_CHANGED" : "PLAYER_MISSING" });
  }

  // ---------------------------------------------------------------------------
  // Bridge to the sidebar
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

  function handleRequest(msg) {
    const check = Core.validateRequest(msg);
    if (!check.ok) {
      if (Number.isSafeInteger(msg?.id)) respond(msg.id, false, check.reason);
      return;
    }
    switch (msg.type) {
      case "GET_CONTEXT":
        respond(msg.id, true, getPlaybackContext());
        return;
      case "GET_KEYFRAMES": {
        reconcileCapture();
        const { t0, t1, maxFrames } = msg.payload;
        respond(msg.id, true, Core.selectWindow(ring, session.generation, { t0, t1 }, maxFrames));
        return;
      }
      case "CLOSE":
        respond(msg.id, true, null);
        setOpen(false);
        return;
    }
  }

  function connectSidebar(iframe) {
    if (ui.port) ui.port.close();
    const channel = new MessageChannel();
    ui.port = channel.port1;
    ui.port.onmessage = (ev) => handleRequest(ev.data);
    // Targeted at the extension origin, so the page cannot receive the port.
    iframe.contentWindow.postMessage({ fanDRS: "connect", v: Core.PROTOCOL_VERSION }, EXTENSION_ORIGIN, [channel.port2]);
    ui.lastContextKey = "";
    pushContextIfChanged();
  }

  function pushContextIfChanged() {
    const ctx = getPlaybackContext();
    const key = JSON.stringify([ctx.videoId, ctx.title, ctx.channel, ctx.currentTime, ctx.duration, ctx.paused, ctx.adShowing, ctx.capture]);
    if (key === ui.lastContextKey) return;
    ui.lastContextKey = key;
    emit("CONTEXT_CHANGED", ctx);
  }

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
    btn.textContent = "Fan DRS Review";
    btn.setAttribute("aria-controls", ids.host);
    btn.setAttribute("aria-expanded", String(ui.open));
    btn.style.cssText = `
      margin-left: 8px; padding: 8px 10px; border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.15); background: rgba(30,30,40,0.9);
      color: #fff; font: 600 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      cursor: pointer;
    `;
    btn.addEventListener("click", () => setOpen(true));
    actions.appendChild(btn);
  }

  function ensurePanel() {
    if (document.getElementById(ids.host)) return;

    const host = document.createElement("div");
    host.id = ids.host;
    host.setAttribute("role", "complementary");
    host.setAttribute("aria-label", "Fan DRS Review");
    host.style.cssText = `
      position: fixed; top: 0; right: 0; height: 100vh; width: min(420px, 100vw); box-sizing: border-box;
      z-index: 2147483647; transform: translateX(100%); visibility: hidden;
      transition: transform 180ms ease-out, visibility 0s linear 180ms;
      box-shadow: -10px 0 30px rgba(0,0,0,0.35); background: rgba(16,16,22,0.98);
      border-left: 1px solid rgba(255,255,255,0.08);
    `;

    const iframe = document.createElement("iframe");
    iframe.id = ids.iframe;
    iframe.title = "Fan DRS Review panel";
    iframe.style.cssText = "width: 100%; height: 100%; border: 0; background: transparent;";
    iframe.addEventListener("load", () => connectSidebar(iframe));
    iframe.src = chrome.runtime.getURL("src/sidebar/sidebar.html");
    host.appendChild(iframe);

    const handle = document.createElement("button");
    handle.id = ids.handle;
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
  }

  function setOpen(open) {
    if (open && !getVideoId()) return;
    if (open) ensurePanel();
    const host = document.getElementById(ids.host);
    const handle = document.getElementById(ids.handle);
    const btn = document.getElementById(ids.button);
    if (!host || !handle) return;

    const wasOpen = ui.open;
    ui.open = open;
    if (open) ui.everOpened = true;

    host.style.transform = open ? "translateX(0)" : "translateX(100%)";
    host.style.visibility = open ? "visible" : "hidden";
    host.style.transitionDelay = open ? "0s" : "0s, 180ms";
    handle.style.display = !open && ui.everOpened && getVideoId() ? "block" : "none";
    if (btn) btn.setAttribute("aria-expanded", String(open));

    if (open) {
      reconcileCapture();
      pushContextIfChanged();
      if (ui.tickTimer === null) ui.tickTimer = setInterval(onTick, CONTEXT_TICK_MS);
      if (!wasOpen) document.getElementById(ids.iframe)?.focus();
    } else {
      session.stop();
      if (ui.tickTimer !== null) clearInterval(ui.tickTimer);
      ui.tickTimer = null;
      if (wasOpen) (btn && btn.isConnected ? btn : handle).focus();
    }
  }

  function onTick() {
    reconcileCapture();
    pushContextIfChanged();
  }

  /** Removes everything when leaving watch pages. */
  function unmount() {
    setOpen(false);
    session.stop();
    session.invalidate();
    bindVideo(null);
    for (const id of [ids.button, ids.host, ids.handle]) document.getElementById(id)?.remove();
    if (ui.port) ui.port.close();
    ui.port = null;
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
      if (ui.open) reconcileCapture();
    }
    if (getVideoId()) ensureButton();
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
  queueReconcile();
})();
