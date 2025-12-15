/**
 * Fan DRS Review - Sidebar Controller
 * Phase 1: Context + keyframe request + stub analysis output
 */
import { runStumping } from '../analyzers/stumping/index.js';
import { applyPolicy, MODE_THRESHOLDS } from '../analyzers/policy.js';
import { detectWicketBreak } from '../analyzers/triggers/wicket_break_trigger.js';

const state = {
  ctx: null,
  keyframes: null,
  activeDismissal: null, // Current dismissal being analyzed { id, window, challenge, timelineEvents }
  dismissals: [], // All dismissals for current video [{ id, window, challenge, timelineEvents, createdAt }]
  bufferStatus: {
    recentFrames: 0,
    capturing: false,
  },
  eventCandidate: null, // { ts, confidence, type, evidence }
  dismissedHints: new Set(), // Track dismissed hints per videoId
};

// Helper to get current challenge state (backward compat)
function getChallenge() {
  return state.activeDismissal?.challenge || { bailOffTs: null, bailOffFrameId: null, autoDetected: false };
}

// Helper to get current timeline events (backward compat)
function getTimelineEvents() {
  return state.activeDismissal?.timelineEvents || [];
}

const DEFAULT_MODE = "B"; // Conservative
state.mode = DEFAULT_MODE;

async function loadMode() {
  try {
    const { fanDRS_mode } = await chrome.storage.local.get(["fanDRS_mode"]);
    state.mode = fanDRS_mode || DEFAULT_MODE;
    const sel = document.getElementById("modeSelect");
    if (sel) sel.value = state.mode;
    updateModeHelp();
  } catch (err) {
    console.warn('[Fan DRS] Failed to load mode (extension context may be invalidated):', err);
    state.mode = DEFAULT_MODE;
  }
}

async function saveMode(mode) {
  state.mode = mode;
  try {
    await chrome.storage.local.set({ fanDRS_mode: mode });
  } catch (err) {
    console.warn('[Fan DRS] Failed to save mode:', err);
  }
  updateModeHelp();
}

function updateModeHelp() {
  const help = document.getElementById("modeHelp");
  if (!help) return;
  if (state.mode === "A") help.textContent = "Ultra-Conservative: only calls OUT/NOT OUT with extremely strong evidence.";
  if (state.mode === "B") help.textContent = "Conservative (recommended): calls OUT/NOT OUT only when evidence is strong.";
  if (state.mode === "C") help.textContent = "Aggressive: makes more calls, but higher chance of being wrong on close decisions.";
}
function $(id){ return document.getElementById(id); }

function clamp(x, lo=0, hi=1){ return Math.max(lo, Math.min(hi, x)); }

function computeQualityQ(keyframesPayload) {
  const n = keyframesPayload?.frames?.length ?? 0;
  const vw = keyframesPayload?.quality?.videoWidth ?? 0;
  const vh = keyframesPayload?.quality?.videoHeight ?? 0;

  const frameCoverage = clamp(n / 24); // ~6s worth at 250ms
  const res = (vw >= 1280 && vh >= 720) ? 1.0 : (vw >= 854 ? 0.8 : 0.6);
  return clamp(0.6*frameCoverage + 0.4*res);
}


function setVerdict(verdict, confidence, modePillText) {
  $("verdictValue").textContent = verdict;
  $("meterFill").style.width = `${Math.round((confidence || 0)*100)}%`;
  $("meterValue").textContent = confidence ? `${Math.round(confidence*100)}%` : "—";
  $("modePill").textContent = modePillText || `MODE ${state.mode} • ${MODE_THRESHOLDS[state.mode]?.label || "FAN"}`;
}

function setStatus(text) { $("statusText").textContent = text; }

function updateBufferUI() {
  const { recentFrames, capturing } = state.bufferStatus;
  const analyzeBtn = $("btnAnalyze");
  
  if (!analyzeBtn) return;
  
  if (capturing && recentFrames < 10) {
    const percent = Math.round((recentFrames / 10) * 100);
    setStatus(`📹 Buffering frames… ${recentFrames}/10 (${percent}%)`);
    analyzeBtn.disabled = true;
    analyzeBtn.style.opacity = "0.5";
    analyzeBtn.style.cursor = "not-allowed";
  } else if (recentFrames >= 10) {
    if (analyzeBtn.disabled) {
      setStatus(`✓ Ready to analyze (${recentFrames} frames buffered)`);
    }
    analyzeBtn.disabled = false;
    analyzeBtn.style.opacity = "1";
    analyzeBtn.style.cursor = "pointer";
  } else {
    setStatus("Waiting for video…");
  }
}

function setDRSCard({ pitching="—", impact="—", wickets="—", official="—" } = {}){
  $("drsPitching").textContent = pitching;
  $("drsImpact").textContent = impact;
  $("drsWickets").textContent = wickets;
  $("drsOfficial").textContent = official;
}

function setWhyBullets(items){
  const ul = $("whyBullets");
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = it;
    ul.appendChild(li);
  }
}

function formatTime(sec){
  if (sec == null || Number.isNaN(sec)) return "—";
  const m = Math.floor(sec/60);
  const s = Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function requestContext(){
  window.parent.postMessage({ __fanDRS: true, type: "REQUEST_CONTEXT" }, "*");
}

function requestKeyframes(t0, t1, maxFrames=60){
  window.parent.postMessage({ __fanDRS: true, type: "REQUEST_KEYFRAMES", payload: { t0, t1, maxFrames } }, "*");
}



window.addEventListener("message", (ev) => {
  if (!ev.data || ev.data.__fanDRS !== true) return;

  if (ev.data.type === "KEYFRAMES_RESPONSE") {
    state.keyframes = ev.data.payload;
    const n = state.keyframes?.frames?.length ?? 0;
    setStatus(`Captured ${n} keyframes for analysis.`);
    return;
  }

  if (ev.data.type === "BUFFER_STATUS") {
    state.bufferStatus = ev.data.payload;
    updateBufferUI();
    return;
  }

  if (ev.data.type === "CONTEXT") {
    const prevVideoId = state.ctx?.videoId;
    state.ctx = ev.data.payload;
    $("ctxTitle").textContent = state.ctx.title || "—";
    $("ctxChannel").textContent = state.ctx.channel || "—";
    $("ctxTime").textContent = `${formatTime(state.ctx.currentTime)} / ${formatTime(state.ctx.duration)}`;
    
    // Load saved state if video changed
    if (state.ctx.videoId && state.ctx.videoId !== prevVideoId) {
      loadBailOffForVideo(state.ctx.videoId);
      loadAnalysisState(state.ctx.videoId);
    }
  }
});

document.getElementById("modeSelect")?.addEventListener("change", (e) => {
  saveMode(e.target.value);
});

// Tabs
document.querySelectorAll(".tab").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById(`panel-${b.dataset.tab}`).classList.add("active");
  });
});

$("btnClose").addEventListener("click", () => {
  window.parent.postMessage({ __fanDRS: true, type: "CLOSE_REQUEST" }, "*");
});

$("btnLast12").addEventListener("click", () => {
  $("windowText").textContent = "Will analyze last 12 seconds from current playback time.";
});

$("btnMarkStart").addEventListener("click", () => {
  $("windowText").textContent = "Mark Start: (Coming soon)";
});

$("btnMarkEnd").addEventListener("click", () => {
  $("windowText").textContent = "Mark End: (Coming soon)";
});

$("btnReset").addEventListener("click", () => {
  state.keyframes = null;
  clearTimeline();
  setVerdict("—", 0, "WAITING");
  setDRSCard({});
  setWhyBullets([
    "We haven't analyzed this clip yet.",
    "Click Analyze to capture keyframes and begin.",
    "We'll stay conservative on close calls."
  ]);
  setStatus("Ready.");
  updateTimelineLegend();
});

// Analyze button (Phase 1: keyframes + stub analysis)
$("btnAnalyze").addEventListener("click", async () => {
  requestContext();
  setStatus("Collecting context…");
  await new Promise(r => setTimeout(r, 250));

  if (!state.ctx?.videoId || state.ctx.currentTime == null) {
    setStatus("Could not read YouTube video context. Try reloading the page.");
    return;
  }

  const t1 = state.ctx.currentTime;
  const t0 = Math.max(0, t1 - 12);
  const window = { t0, t1 };
  
  // Create or reuse dismissal for this window
  const dismissalId = `${state.ctx.videoId}_${Math.floor(t0)}_${Math.floor(t1)}`;
  let dismissal = state.dismissals.find(d => d.id === dismissalId);
  
  if (!dismissal) {
    dismissal = {
      id: dismissalId,
      window,
      challenge: { bailOffTs: null, bailOffFrameId: null, autoDetected: false },
      timelineEvents: [],
      createdAt: new Date().toISOString(),
    };
    state.dismissals.push(dismissal);
  }
  
  state.activeDismissal = dismissal;
  
  $('windowText').textContent = `Analyzing ${formatTime(t0)} → ${formatTime(t1)} (last 12s)`;

  setStatus("Capturing keyframes (rolling buffer)…");
  requestKeyframes(t0, t1, 60);

  await new Promise(r => setTimeout(r, 450));

  const n = state.keyframes?.frames?.length ?? 0;
  if (n < 6) {
    setVerdict("INCONCLUSIVE", 0.35, "WAIT: MORE FRAMES");
    setWhyBullets([
      "Not enough keyframes captured yet. Keep the sidebar open for ~2–3 seconds and try again.",
      "We keep a rolling buffer so we can analyze the last few seconds without seeking.",
      "On close calls, we prefer INCONCLUSIVE over pretending."
    ]);
    setStatus("Not enough keyframes yet. Try again in a moment.");
    return;
  }

  setStatus("Running stumping analysis…");
  await new Promise(r => setTimeout(r, 450));

  // Run event trigger detector (non-blocking, for hint only)
  detectAndShowEventHint(state.keyframes.frames, { t0, t1 });

  // Run stumping analyzer (orchestrates bail-off, crease, foot)
  const analysis = await runStumping({
    frames: state.keyframes.frames,
    window,
    challenge: getChallenge(),
    mode: state.mode,
  });

  console.log('[Fan DRS] Stumping analysis result:', analysis);

  // Update state with detection results
  if (analysis.bailOff && state.activeDismissal) {
    state.activeDismissal.challenge.bailOffTs = analysis.bailOff.ts;
    state.activeDismissal.challenge.bailOffFrameId = analysis.bailOff.method === 'auto' ? 'auto_detected' : state.activeDismissal.challenge.bailOffFrameId;
    state.activeDismissal.challenge.autoDetected = analysis.bailOff.method === 'auto';

    // Add timeline marker if auto-detected
    if (analysis.bailOff.method === 'auto') {
      addTimelineEvent({
        id: "bail_off",
        ts: analysis.bailOff.ts,
        description: `Bail-off (auto ${Math.round(analysis.bailOff.confidence * 100)}%)`,
        markerColor: "rgba(220,38,38,0.9)", // red
        evidence: { method: "auto", confidence: analysis.bailOff.confidence }
      });
    }
  }

  const Q = computeQualityQ(state.keyframes);

  // Apply policy decision
  const policy = applyPolicy({
    mode: state.mode,
    confidence: analysis.confidence,
    qualityQ: Q,
    framesCount: n,
    critical: analysis.critical,
    direction: { posStronger: true }  // Phase 1 stub: assume OUT for testing
  });

  console.log('[Fan DRS] Policy decision:', {
    verdict: policy.verdict,
    reason: policy.reason,
    confidence: analysis.confidence,
    critical: analysis.critical,
    Q,
    framesCount: n
  });

  // Build "Why" bullets from evidence
  const whyBullets = [
    `Captured ${n} keyframes for the selected window.`,
    `Quality score Q=${Math.round(Q*100)}%.`,
  ];

  // Add event candidate info (if detected) - separate from verdict
  if (state.eventCandidate) {
    whyBullets.push(`⚡ Event detected at ${formatTime(state.eventCandidate.ts)} (confidence: ${Math.round(state.eventCandidate.confidence * 100)}% - event locator, not dismissal verdict)`);
  }

  // Add evidence explanations
  analysis.evidenceList.forEach(ev => {
    if (ev.notes) whyBullets.push(ev.notes);
  });

  whyBullets.push(`Policy: ${policy.reason}.`);
  whyBullets.push(`ℹ️ Stumping decision requires: bail-off + crease + foot position (${analysis.critical.hasBailOff ? '✓' : '✗'} bail-off, ${analysis.critical.hasCrease ? '✓' : '✗'} crease, ${analysis.critical.hasFoot ? '✓' : '✗'} foot)`);

  setVerdict(policy.verdict, analysis.confidence);
  setWhyBullets(whyBullets);

  // Save analysis state for this video
  if (state.ctx?.videoId) {
    await saveAnalysisState(state.ctx.videoId);
  }

  setDRSCard({
    pitching: "—",
    impact: "—",
    wickets: "—",
    official: "Official DRS parsing not implemented yet"
  });
  setWhyBullets([
    `Captured ${n} keyframes for the selected window.`,
    "Next: implement stumping (crease + bail-off + foot) and official DRS OCR.",
    "Confidence will rise when evidence is strong or user helps in Challenge Mode."
  ]);
  setStatus("Done (keyframes captured).");
  
  // Update timeline and legend
  renderTimeline();
  updateTimelineLegend();
});

$("btnAgree").addEventListener("click", () => $("feedbackText").textContent = "Thanks — recorded: Agree (local stub).");
$("btnDisagree").addEventListener("click", () => $("feedbackText").textContent = "Thanks — recorded: Disagree (local stub).");
$("btnNotSure").addEventListener("click", () => $("feedbackText").textContent = "Thanks — recorded: Not sure (local stub).");

// Bail-off picker
$("btnPickBailOff").addEventListener("click", () => {
  if (!state.keyframes || (state.keyframes.frames?.length ?? 0) < 10) {
    $("pickerStatus").textContent = "Please run Analyze first to capture keyframes.";
    $("bailOffPicker").style.display = "block";
    return;
  }
  showBailOffPicker();
});

$("btnClearBailOff").addEventListener("click", () => {
  clearBailOffSelection();
});

$("btnClosePicker").addEventListener("click", () => {
  $("bailOffPicker").style.display = "none";
});

function showBailOffPicker() {
  const frames = state.keyframes?.frames || [];
  if (frames.length < 10) {
    $("pickerStatus").textContent = "Not enough keyframes. Run Analyze to capture frames.";
    $("bailOffPicker").style.display = "block";
    return;
  }

  $("bailOffPicker").style.display = "block";
  $("pickerStatus").textContent = `Click the frame where the bail leaves the stumps (${frames.length} frames available).`;
  
  const grid = $("frameGrid");
  grid.innerHTML = "";
  
  frames.forEach((frame, idx) => {
    const div = document.createElement("div");
    div.className = "frameThumb";
    div.dataset.ts = frame.ts;
    div.dataset.frameId = `frame_${idx}`;
    
    const challenge = getChallenge();
    if (challenge.bailOffTs === frame.ts) {
      div.classList.add("selected");
    }
    
    const img = document.createElement("img");
    img.src = frame.jpeg;
    img.alt = `Frame at ${formatTime(frame.ts)}`;
    
    const tsLabel = document.createElement("div");
    tsLabel.className = "frameTs";
    tsLabel.textContent = formatTime(frame.ts);
    
    const check = document.createElement("div");
    check.className = "checkmark";
    check.textContent = "✓";
    
    div.appendChild(img);
    div.appendChild(tsLabel);
    div.appendChild(check);
    
    div.addEventListener("click", () => selectBailOffFrame(frame.ts, `frame_${idx}`));
    
    grid.appendChild(div);
  });
  
  updateSelectionInfo();
}

async function selectBailOffFrame(ts, frameId) {
  // Validate ts is within window
  const t0 = state.keyframes?.t0 ?? 0;
  const t1 = state.keyframes?.t1 ?? 0;
  
  if (ts < t0 || ts > t1) {
    $("pickerStatus").textContent = "Frame outside analysis window. Please select a frame within the captured range.";
    return;
  }
  
  if (!state.activeDismissal) {
    $("pickerStatus").textContent = "No active dismissal. Please run Analyze first.";
    return;
  }
  
  state.activeDismissal.challenge.bailOffTs = ts;
  state.activeDismissal.challenge.bailOffFrameId = frameId;
  state.activeDismissal.challenge.autoDetected = false;  // User override
  
  // Persist to storage
  if (state.ctx?.videoId) {
    try {
      const key = `fanDRS_bailOff_${state.ctx.videoId}`;
      await chrome.storage.local.set({
        [key]: {
          ts,
          frameId,
          createdAt: new Date().toISOString(),
        }
      });
      
      // Save full analysis state
      await saveAnalysisState(state.ctx.videoId);
    } catch (err) {
      console.warn('[Fan DRS] Failed to persist bail-off selection:', err);
    }
  }
  
  // Update UI
  document.querySelectorAll(".frameThumb").forEach(el => el.classList.remove("selected"));
  const selected = document.querySelector(`[data-ts="${ts}"]`);
  if (selected) selected.classList.add("selected");
  
  $("pickerStatus").textContent = "Bail-off frame selected! This will boost confidence on next analysis.";
  updateSelectionInfo();
  
  // Record metric (local)
  recordPickerMetric("selection_made", { ts, frameId });
}

async function clearBailOffSelection() {
  if (!state.activeDismissal) return;
  
  state.activeDismissal.challenge.bailOffTs = null;
  state.activeDismissal.challenge.bailOffFrameId = null;
  state.activeDismissal.challenge.autoDetected = false;
  
  // Remove from timeline
  removeTimelineEvent("bail_off");
  
  if (state.ctx?.videoId) {
    try {
      const key = `fanDRS_bailOff_${state.ctx.videoId}`;
      await chrome.storage.local.remove(key);
      
      // Update analysis state
      await saveAnalysisState(state.ctx.videoId);
    } catch (err) {
      console.warn('[Fan DRS] Failed to clear bail-off from storage:', err);
    }
  }
  
  document.querySelectorAll(".frameThumb").forEach(el => el.classList.remove("selected"));
  $("pickerStatus").textContent = "Selection cleared. Pick a frame to help with stumping analysis.";
  updateSelectionInfo();
  
  recordPickerMetric("selection_cleared");
}

function updateSelectionInfo() {
  const info = $("selectionInfo");
  const challenge = getChallenge();
  if (challenge.bailOffTs != null) {
    const method = challenge.autoDetected ? "(auto-detected)" : "(manual)";
    info.textContent = `Selected: ${formatTime(challenge.bailOffTs)} ${method} (+15 reliability boost)`;
  } else {
    info.textContent = "No bail-off selected yet.";
  }
}

async function loadBailOffForVideo(videoId) {
  if (!videoId) return;
  // Legacy single bail-off support - will be migrated to dismissals model
  try {
    const key = `fanDRS_bailOff_${videoId}`;
    const result = await chrome.storage.local.get(key);
    const data = result[key];
    
    if (data?.ts != null && state.activeDismissal) {
      state.activeDismissal.challenge.bailOffTs = data.ts;
      state.activeDismissal.challenge.bailOffFrameId = data.frameId;
    }
  } catch (err) {
    console.warn('[Fan DRS] Failed to load bail-off for video:', err);
  }
}

async function saveAnalysisState(videoId) {
  if (!videoId) return;
  try {
    // Save all dismissals for this video
    const key = `fanDRS_dismissals_${videoId}`;
    const dismissalsData = {
      dismissals: state.dismissals,
      activeDismissalId: state.activeDismissal?.id,
      lastSavedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [key]: dismissalsData });
    console.log('[Fan DRS] Saved', state.dismissals.length, 'dismissal(s) for', videoId);
  } catch (err) {
    console.warn('[Fan DRS] Failed to save analysis state:', err);
  }
}

async function loadAnalysisState(videoId) {
  if (!videoId) return;
  try {
    const key = `fanDRS_dismissals_${videoId}`;
    const result = await chrome.storage.local.get(key);
    const data = result[key];
    
    if (data?.dismissals) {
      state.dismissals = data.dismissals;
      
      // Restore active dismissal (most recent if not specified)
      if (data.activeDismissalId) {
        state.activeDismissal = state.dismissals.find(d => d.id === data.activeDismissalId);
      }
      if (!state.activeDismissal && state.dismissals.length > 0) {
        state.activeDismissal = state.dismissals[state.dismissals.length - 1];
      }
      
      // Render timeline for active dismissal
      if (state.activeDismissal) {
        renderTimeline();
      }
      
      console.log('[Fan DRS] Restored', state.dismissals.length, 'dismissal(s) from', data.lastSavedAt);
      updateDismissalList();
    }
  } catch (err) {
    console.warn('[Fan DRS] Failed to load analysis state:', err);
  }
}

function recordPickerMetric(event, data = {}) {
  // Store in local ring buffer (last 100 events)
  try {
    chrome.storage.local.get(["fanDRS_pickerMetrics"], (result) => {
      const metrics = result.fanDRS_pickerMetrics || [];
      metrics.push({
        event,
        data,
        timestamp: new Date().toISOString(),
      });
      // Keep last 100
      while (metrics.length > 100) metrics.shift();
      chrome.storage.local.set({ fanDRS_pickerMetrics: metrics });
    });
  } catch (err) {
    console.warn('[Fan DRS] Failed to record picker metric:', err);
  }
}

// Timeline event management
function addTimelineEvent(event) {
  if (!state.activeDismissal) return;
  // Remove existing event with same id, then add new one
  state.activeDismissal.timelineEvents = state.activeDismissal.timelineEvents.filter(e => e.id !== event.id);
  state.activeDismissal.timelineEvents.push(event);
  renderTimeline();
}

function removeTimelineEvent(eventId) {
  if (!state.activeDismissal) return;
  state.activeDismissal.timelineEvents = state.activeDismissal.timelineEvents.filter(e => e.id !== eventId);
  renderTimeline();
}

function clearTimeline() {
  if (!state.activeDismissal) return;
  state.activeDismissal.timelineEvents = [];
  renderTimeline();
}

function renderTimeline() {
  const bar = $("timelineBar");
  if (!bar) return;
  
  // Clear existing markers
  bar.innerHTML = "";
  
  if (!state.keyframes?.t0 || !state.keyframes?.t1) {
    return;
  }
  
  const t0 = state.keyframes.t0;
  const t1 = state.keyframes.t1;
  const duration = t1 - t0;
  
  if (duration <= 0) return;
  
  const events = getTimelineEvents();
  
  // Render each event as a marker
  events.forEach(event => {
    if (event.ts < t0 || event.ts > t1) return; // Skip events outside window
    
    const position = ((event.ts - t0) / duration) * 100;
    const marker = document.createElement("div");
    marker.className = "marker";
    marker.dataset.eventId = event.id;
    marker.dataset.ts = event.ts;
    marker.style.left = `${Math.max(0, Math.min(100, position))}%`;
    marker.style.background = event.markerColor || "rgba(255,204,0,0.85)";
    marker.title = `${event.description} (${formatTime(event.ts)})`;
    
    // Click handler for seeking
    marker.addEventListener("click", () => onMarkerClick(event));
    
    bar.appendChild(marker);
  });
  
  updateTimelineLegend();
}

function onMarkerClick(event) {
  console.log(`[Fan DRS] Timeline marker clicked:`, event);
  
  // Highlight selected marker
  document.querySelectorAll(".marker").forEach(m => m.classList.remove("selected"));
  const marker = document.querySelector(`[data-event-id="${event.id}"]`);
  if (marker) marker.classList.add("selected");
  
  // Send seek request to content script
  window.parent.postMessage({
    __fanDRS: true,
    type: "SEEK_VIDEO",
    payload: { ts: event.ts }
  }, "*");
  
  // Show frame thumbnail if available
  showEventFrame(event);
}

function showEventFrame(event) {
  // Find closest frame to event timestamp
  if (!state.keyframes?.frames) return;
  
  const frames = state.keyframes.frames;
  let closestFrame = null;
  let minDiff = Infinity;
  
  frames.forEach(frame => {
    const diff = Math.abs(frame.ts - event.ts);
    if (diff < minDiff) {
      minDiff = diff;
      closestFrame = frame;
    }
  });
  
  if (closestFrame && minDiff < 1.0) { // Within 1 second
    console.log(`[Fan DRS] Showing frame at ${formatTime(closestFrame.ts)} for event:`, event.description);
    // Could display frame in a modal or preview panel (future enhancement)
  }
}

function updateTimelineLegend() {
  const legendEl = $("timelineLegendEvents");
  if (!legendEl) return;
  
  const events = getTimelineEvents();
  if (events.length === 0) {
    legendEl.textContent = "No events yet.";
  } else {
    const eventNames = events.map(e => e.description).join(", ");
    legendEl.textContent = `Events: ${eventNames}`;
  }
}

// Helper to add placeholder events for testing timeline (optional)
function addPlaceholderEvents() {
  if (!state.keyframes?.t0 || !state.keyframes?.t1) return;
  
  const t0 = state.keyframes.t0;
  const t1 = state.keyframes.t1;
  const duration = t1 - t0;
  
  // Example: Add bounce event at 20% through window
  // addTimelineEvent({
  //   id: "bounce",
  //   ts: t0 + duration * 0.20,
  //   description: "Ball bounce (placeholder)",
  //   markerColor: "rgba(234,179,8,0.9)", // yellow
  //   evidence: { method: "placeholder" }
  // });
  
  // Example: Add impact event at 55% through window
  // addTimelineEvent({
  //   id: "impact",
  //   ts: t0 + duration * 0.55,
  //   description: "Impact (placeholder)",
  //   markerColor: "rgba(249,115,22,0.9)", // orange
  //   evidence: { method: "placeholder" }
  // });
}

// Event detection and hint display
async function detectAndShowEventHint(frames, window) {
  if (!state.ctx?.videoId) return;
  
  // Don't show if already dismissed for this video
  if (state.dismissedHints.has(state.ctx.videoId)) return;

  const detection = await detectWicketBreak(frames, {
    minFrames: 12,
    spikeThreshold: 8,
    prominenceRatio: 3.0,
  });

  if (!detection.triggered || detection.confidence < 0.75) {
    hideEventHint();
    return;
  }

  // Store event candidate (separate from verdict)
  state.eventCandidate = {
    ts: detection.eventTs,
    confidence: detection.confidence,
    type: 'wicket_break',
    evidence: detection.evidence,
  };

  // Show hint UI
  showEventHint(detection);
}

function showEventHint(detection) {
  const hint = $("eventHint");
  if (!hint) return;

  $("hintTitle").textContent = "Event detected";
  $("hintMessage").textContent = `Possible wicket-break at ${formatTime(detection.eventTs)}`;
  
  // Set confidence badge
  const badge = $("hintBadge");
  const conf = detection.confidence;
  if (conf >= 0.85) {
    badge.textContent = "HIGH";
    badge.className = "badge high";
  } else if (conf >= 0.75) {
    badge.textContent = "MED";
    badge.className = "badge med";
  } else {
    badge.textContent = "LOW";
    badge.className = "badge low";
  }

  hint.style.display = "block";
}

function hideEventHint() {
  const hint = $("eventHint");
  if (hint) hint.style.display = "none";
}

// Hint button handlers
$("btnUseHint")?.addEventListener("click", () => {
  if (!state.eventCandidate) return;

  const { ts } = state.eventCandidate;
  const t0 = Math.max(0, ts - 8);
  const t1 = ts + 3;

  // Update window display
  $("windowText").textContent = `Suggested window: ${formatTime(t0)} → ${formatTime(t1)} (centered on event)`;

  // Add timeline marker
  addTimelineEvent({
    id: "wicket_break_candidate",
    ts,
    description: `Event candidate (${Math.round(state.eventCandidate.confidence * 100)}%)`,
    markerColor: "rgba(234,179,8,0.9)", // yellow
    evidence: state.eventCandidate.evidence,
  });

  // Optionally preselect nearest frame as bail-off candidate (but NOT confirmed)
  // This would require checking state.keyframes.frames for nearest to ts
  
  hideEventHint();
  setStatus(`Using suggested window around ${formatTime(ts)}`);
});

$("btnDismissHint")?.addEventListener("click", () => {
  if (state.ctx?.videoId) {
    state.dismissedHints.add(state.ctx.videoId);
  }
  hideEventHint();
});

// Dismissal list management
function updateDismissalList() {
  // Future: Add UI to show list of dismissals and switch between them
  // For now, just update console log
  if (state.dismissals.length > 1) {
    console.log(`[Fan DRS] ${state.dismissals.length} dismissals for this video. Active:`, state.activeDismissal?.id);
  }
}

function switchDismissal(dismissalId) {
  const dismissal = state.dismissals.find(d => d.id === dismissalId);
  if (dismissal) {
    state.activeDismissal = dismissal;
    renderTimeline();
    updateSelectionInfo();
    console.log('[Fan DRS] Switched to dismissal:', dismissalId);
  }
}

requestContext();
setVerdict("—", 0, "WAITING");
loadMode();

// Poll for buffer status every 500ms
function requestBufferStatus() {
  window.parent.postMessage({ __fanDRS: true, type: "REQUEST_BUFFER_STATUS" }, "*");
}

// Start polling when sidebar loads
let bufferPollInterval = setInterval(requestBufferStatus, 500);
requestBufferStatus(); // Initial request
