/**
 * Fan DRS Review - Sidebar Controller
 * Phase 1: Context + keyframe request + stub analysis output
 */
const state = {
  ctx: null,
  keyframes: null,
};

function $(id){ return document.getElementById(id); }

function setVerdict(verdict, confidence, modePillText) {
  $("verdictValue").textContent = verdict;
  $("meterFill").style.width = `${Math.round((confidence || 0)*100)}%`;
  $("meterValue").textContent = confidence ? `${Math.round(confidence*100)}%` : "—";
  $("modePill").textContent = modePillText || "FAN";
}

function setStatus(text) { $("statusText").textContent = text; }

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

  if (ev.data.type === "CONTEXT") {
    state.ctx = ev.data.payload;
    $("ctxTitle").textContent = state.ctx.title || "—";
    $("ctxChannel").textContent = state.ctx.channel || "—";
    $("ctxTime").textContent = `${formatTime(state.ctx.currentTime)} / ${formatTime(state.ctx.duration)}`;
  }
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
  setVerdict("—", 0, "WAITING");
  setDRSCard({});
  setWhyBullets([
    "We haven’t analyzed this clip yet.",
    "Click Analyze to capture keyframes and begin.",
    "We’ll stay conservative on close calls."
  ]);
  setStatus("Ready.");
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
  $("windowText").textContent = `Analyzing ${formatTime(t0)} → ${formatTime(t1)} (last 12s)`;

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

  setStatus("Running Fan DRS (stub analysis)…");
  await new Promise(r => setTimeout(r, 450));

  setVerdict("INCONCLUSIVE", 0.42, "FAN SIM");
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
});

$("btnAgree").addEventListener("click", () => $("feedbackText").textContent = "Thanks — recorded: Agree (local stub).");
$("btnDisagree").addEventListener("click", () => $("feedbackText").textContent = "Thanks — recorded: Disagree (local stub).");
$("btnNotSure").addEventListener("click", () => $("feedbackText").textContent = "Thanks — recorded: Not sure (local stub).");

requestContext();
setVerdict("—", 0, "WAITING");
