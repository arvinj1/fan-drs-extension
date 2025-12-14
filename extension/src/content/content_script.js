/**
 * Fan DRS Review - Content Script
 * Injects:
 *   (1) "Fan DRS Review" button under the YouTube player
 *   (2) an in-page sidebar (iframe) for the analysis UI
 * Provides:
 *   - playback context
 *   - rolling keyframe ring-buffer (last ~20s) without seeking
 */

const STATE = {
  sidebarOpen: false,
  currentVideoId: null,
};

function isWatchPage() {
  return location.pathname === "/watch";
}

function getVideoIdFromUrl() {
  const u = new URL(location.href);
  return u.searchParams.get("v");
}

function findActionsBar() {
  return (
    document.querySelector("#top-level-buttons-computed") ||
    document.querySelector("ytd-menu-renderer #top-level-buttons-computed") ||
    document.querySelector("#actions") ||
    null
  );
}

function ensureButton() {
  if (!isWatchPage()) return;
  const videoId = getVideoIdFromUrl();
  if (!videoId) return;
  if (document.getElementById("fan-drs-btn")) return;

  const actions = findActionsBar();
  if (!actions) return;

  const btn = document.createElement("button");
  btn.id = "fan-drs-btn";
  btn.type = "button";
  btn.textContent = "Fan DRS Review";
  btn.style.cssText = `
    margin-left: 8px;
    padding: 8px 10px;
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(30,30,40,0.9);
    color: #fff;
    font: 600 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    cursor: pointer;
  `;
  btn.addEventListener("click", () => toggleSidebar(true));
  actions.appendChild(btn);
}

function ensureSidebar() {
  if (document.getElementById("fan-drs-sidebar-host")) return;

  const host = document.createElement("div");
  host.id = "fan-drs-sidebar-host";
  host.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    height: 100vh;
    width: 420px;
    z-index: 2147483647;
    transform: translateX(100%);
    transition: transform 180ms ease-out;
    box-shadow: -10px 0 30px rgba(0,0,0,0.35);
    background: rgba(16,16,22,0.98);
    border-left: 1px solid rgba(255,255,255,0.08);
  `;

  const iframe = document.createElement("iframe");
  iframe.id = "fan-drs-sidebar";
  iframe.src = chrome.runtime.getURL("src/sidebar/sidebar.html");
  iframe.style.cssText = `
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  `;
  host.appendChild(iframe);

  const handle = document.createElement("div");
  handle.id = "fan-drs-handle";
  handle.textContent = "DRS";
  handle.title = "Open Fan DRS Review";
  handle.style.cssText = `
    position: fixed;
    right: 8px;
    top: 40%;
    z-index: 2147483647;
    padding: 8px 10px;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(30,30,40,0.88);
    color: #fff;
    font: 700 12px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    cursor: pointer;
    opacity: 0;
    transition: opacity 180ms ease-out;
  `;
  handle.addEventListener("click", () => toggleSidebar(true));

  document.documentElement.appendChild(host);
  document.documentElement.appendChild(handle);

  // Messaging bridge: host <-> iframe sidebar
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.__fanDRS !== true) return;

    if (ev.data.type === "REQUEST_CONTEXT") {
      postContextToSidebar();
      return;
    }

    if (ev.data.type === "CLOSE_REQUEST") {
      toggleSidebar(false);
      return;
    }

    if (ev.data.type === "REQUEST_KEYFRAMES") {
      const { t0, t1, maxFrames } = ev.data.payload || {};
      const resp = getKeyframesForWindow(t0, t1, maxFrames);
      postToSidebar({ type: "KEYFRAMES_RESPONSE", payload: resp });
      return;
    }
  });
}

function toggleSidebar(open) {
  ensureSidebar();

  const host = document.getElementById("fan-drs-sidebar-host");
  const handle = document.getElementById("fan-drs-handle");
  if (!host || !handle) return;

  STATE.sidebarOpen = open ?? !STATE.sidebarOpen;
  host.style.transform = STATE.sidebarOpen ? "translateX(0)" : "translateX(100%)";
  handle.style.opacity = STATE.sidebarOpen ? "0" : "1";

  if (STATE.sidebarOpen) {
    startCaptureLoop();
    postContextToSidebar();
  } else {
    stopCaptureLoop();
  }
}

function getVideoEl() {
  return document.querySelector("video.html5-main-video");
}

function getPlaybackContext() {
  const videoId = getVideoIdFromUrl();
  const video = getVideoEl();
  const t = video ? video.currentTime : null;
  const duration = video ? video.duration : null;
  const paused = video ? video.paused : null;

  return {
    videoId,
    url: location.href,
    title: document.querySelector("h1.ytd-watch-metadata")?.innerText?.trim() || "",
    channel: document.querySelector("ytd-channel-name a")?.innerText?.trim() || "",
    currentTime: t,
    duration,
    paused,
    capturedAt: new Date().toISOString(),
  };
}

function postToSidebar(msg) {
  const iframe = document.getElementById("fan-drs-sidebar");
  if (!iframe || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({ __fanDRS: true, ...msg }, "*");
}

function postContextToSidebar() {
  postToSidebar({ type: "CONTEXT", payload: getPlaybackContext() });
}

/** Rolling keyframe ring-buffer (client-first, no seeking)
 * Captures thumbnails from the current YouTube <video> while sidebar is open.
 */
const FRAME_BUFFER = [];
const FRAME_CFG = {
  intervalMs: 250,
  maxFrames: 90,       // ~22.5s at 250ms
  thumbWidth: 320,     // downscale for speed
  jpegQuality: 0.6,
};

let captureRunning = false;
let lastCaptureAt = 0;
let canvas = null;
let ctx2d = null;
let rvfcHandle = null;

function ensureCanvas() {
  if (canvas && ctx2d) return;
  canvas = document.createElement("canvas");
  ctx2d = canvas.getContext("2d", { willReadFrequently: false });
}

function pushFrame(tsSec, dataUrl) {
  FRAME_BUFFER.push({ ts: tsSec, jpeg: dataUrl });
  while (FRAME_BUFFER.length > FRAME_CFG.maxFrames) FRAME_BUFFER.shift();
}

function captureOnce(video) {
  if (!video || video.readyState < 2) return; // HAVE_CURRENT_DATA
  ensureCanvas();

  const w = video.videoWidth || 0;
  const h = video.videoHeight || 0;
  if (w <= 0 || h <= 0) return;

  const scale = FRAME_CFG.thumbWidth / w;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  canvas.width = tw;
  canvas.height = th;
  ctx2d.drawImage(video, 0, 0, tw, th);
  const dataUrl = canvas.toDataURL("image/jpeg", FRAME_CFG.jpegQuality);
  pushFrame(video.currentTime, dataUrl);
}

function startCaptureLoop() {
  if (captureRunning) return;
  captureRunning = true;

  const video = getVideoEl();
  if (!video) return;

  if (typeof video.requestVideoFrameCallback === "function") {
    const cb = () => {
      if (!captureRunning) return;
      const t = performance.now();
      if (t - lastCaptureAt >= FRAME_CFG.intervalMs) {
        lastCaptureAt = t;
        captureOnce(video);
      }
      rvfcHandle = video.requestVideoFrameCallback(cb);
    };
    rvfcHandle = video.requestVideoFrameCallback(cb);
    return;
  }

  const timer = setInterval(() => {
    if (!captureRunning) { clearInterval(timer); return; }
    captureOnce(video);
  }, FRAME_CFG.intervalMs);
}

function stopCaptureLoop() {
  captureRunning = false;
  rvfcHandle = null;
}

function getKeyframesForWindow(t0, t1, maxFrames = 60) {
  const frames = FRAME_BUFFER.filter(f => f.ts >= t0 && f.ts <= t1);
  const stride = Math.max(1, Math.floor(frames.length / maxFrames));
  const sampled = frames.filter((_, i) => i % stride === 0).slice(0, maxFrames);

  const video = getVideoEl();
  const quality = {
    thumbWidth: FRAME_CFG.thumbWidth,
    intervalMs: FRAME_CFG.intervalMs,
    videoWidth: video?.videoWidth || null,
    videoHeight: video?.videoHeight || null,
    bufferedFrames: FRAME_BUFFER.length,
  };

  return { t0, t1, frames: sampled, quality };
}

// YouTube SPA navigation observer
let lastUrl = location.href;
const obs = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(() => {
      ensureButton();
      toggleSidebar(false);
    }, 600);
  } else {
    ensureButton();
  }
});

obs.observe(document.documentElement, { childList: true, subtree: true });

setTimeout(() => ensureButton(), 800);
