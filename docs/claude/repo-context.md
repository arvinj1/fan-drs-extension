# Fan DRS Extension - Repository Context

**Version:** 0.1.1  
**Type:** Chrome Extension (Manifest V3)  
**Purpose:** Fan-style DRS review for cricket dismissals on YouTube

---

## Architecture Overview

This is a **client-first Chrome extension** that provides cricket dismissal analysis (stumping + official DRS extraction + LBW calibration) for YouTube videos. The extension operates entirely in the browser without external API calls in Phase 1.

### Core Components
```
fan-drs-extension/
├── manifest.json              # Extension manifest (MV3)
├── assets/                    # Icons (16x16, 48x48, 128x128)
├── src/
│   ├── background/
│   │   └── service_worker.js  # MV3 service worker (minimal in Phase 1)
│   ├── content/
│   │   └── content_script.js  # YouTube page injection + frame capture
│   ├── sidebar/
│   │   ├── sidebar.html       # Analysis UI (iframe)
│   │   ├── sidebar.css        # Styling
│   │   └── sidebar.js         # Controller + orchestration
│   └── analyzers/
│       ├── stumping/
│       │   └── index.js       # Stumping analyzer (bail-off + crease + foot)
│       ├── policy.js          # Verdict policy thresholds (modes A/B/C)
│       └── triggers/
│           └── wicket_break_trigger.js  # Event detection
└── docs/
    └── claude/                # AI-assisted development docs
```

---

## How It Works

### 1. Cricket Video Detection
- Content script monitors YouTube watch pages
- Detects cricket videos via keyword matching (title + description)
- Keywords: cricket, ipl, t20, wicket, lbw, stumping, drs, etc.
- **Requires 2+ keyword hits** (or 1 if "stumping" present)
- **Dev override:** `?fan_drs=1` query parameter forces activation

### 2. Button & Sidebar Injection
- "Fan DRS Review" button injected under YouTube player
- Sidebar (420px iframe) slides in from right when opened
- Persistent handle visible when sidebar closed

### 3. Rolling Keyframe Buffer
**Client-first design:** No seeking required
- Captures frames from `<video>` element at 250ms intervals
- Maintains ring buffer of last ~90 frames (~22.5s)
- Uses `requestVideoFrameCallback` (fallback to `setInterval`)
- Downscales to 320px width, JPEG @ 0.6 quality
- Buffer only active when sidebar is open

### 4. Analysis Window Selection
- **Default:** Last 12 seconds from current playback time
- User can mark custom start/end points (Phase 2)
- Requests keyframes from buffer for selected window

### 5. Analysis Pipeline
```
Request Keyframes (t0 → t1)
    ↓
Quality Check (min 6 frames)
    ↓
Event Detection (wicket_break_trigger)
    ↓
Stumping Analysis (bail-off + crease + foot)
    ↓
Policy Application (mode A/B/C thresholds)
    ↓
Verdict Display + Evidence Bullets
```

### 6. Challenge Mode (Optional Boost)
- User can manually select bail-off frame (+15 confidence boost)
- Frame picker shows thumbnails with timestamps
- Selections persist per video in `chrome.storage.local`
- Auto-detected bail-off events shown in timeline
---

## Key Modules

### `content_script.js`
**Responsibilities:**
- Inject button & sidebar into YouTube DOM
- Capture rolling keyframe buffer
- Bridge messages between host page ↔ sidebar iframe
- Provide playback context (videoId, currentTime, duration)

**Key Functions:**
- `isLikelyCricketVideo()` - Detection heuristic
- `startCaptureLoop()` - Frame capture via RVFC
- `getKeyframesForWindow(t0, t1, maxFrames)` - Extract frames from buffer
- `postContextToSidebar()` - Send video metadata

**Message Protocol:**
```javascript
// Host → Sidebar
{ __fanDRS: true, type: "CONTEXT", payload: {...} }
{ __fanDRS: true, type: "KEYFRAMES_RESPONSE", payload: {...} }
{ __fanDRS: true, type: "BUFFER_STATUS", payload: {...} }

// Sidebar → Host
{ __fanDRS: true, type: "REQUEST_CONTEXT" }
{ __fanDRS: true, type: "REQUEST_KEYFRAMES", payload: { t0, t1, maxFrames } }
{ __fanDRS: true, type: "SEEK_VIDEO", payload: { ts } }
{ __fanDRS: true, type: "CLOSE_REQUEST" }
```

---

### `sidebar.js`
**Responsibilities:**
- UI controller & state management
- Orchestrate analysis pipeline
- Manage timeline events & dismissal state
- Persist selections to `chrome.storage.local`

**State Structure:**
```javascript
{
  ctx: { videoId, url, title, channel, currentTime, duration, paused },
  keyframes: { t0, t1, frames: [{ ts, jpeg }], quality: {...} },
  activeDismissal: {
    id: "videoId_t0_t1",
    window: { t0, t1 },
    challenge: { bailOffTs, bailOffFrameId, autoDetected },
    timelineEvents: [{ id, ts, description, markerColor, evidence }]
  },
  dismissals: [...],  // All dismissals for current video
  mode: "A" | "B" | "C",  // Policy strictness
  bufferStatus: { totalFrames, recentFrames, capturing, currentTime },
  eventCandidate: { ts, confidence, type, evidence }  // From trigger detector
}
```

**Key Functions:**
- `requestKeyframes(t0, t1, maxFrames)` - Request from content script
- `runStumping({ frames, window, challenge, mode })` - Run analyzer
- `applyPolicy({ mode, confidence, qualityQ, ... })` - Get verdict
- `addTimelineEvent(event)` - Add marker to timeline
- `selectBailOffFrame(ts, frameId)` - User challenge selection
- `detectAndShowEventHint(frames, window)` - Show event detection hint

---

### `analyzers/stumping/index.js`
**Responsibilities:**
- Orchestrate bail-off, crease, and foot detection
- Compute overall confidence score
- Return evidence list for UI display

**Expected Interface:**
```javascript
async function runStumping({ frames, window, challenge, mode }) {
  return {
    confidence: 0.0-1.0,
    critical: { hasBailOff: bool, hasCrease: bool, hasFoot: bool },
    bailOff: { ts, method: 'auto'|'manual', confidence },
    evidenceList: [{ notes: "..." }, ...],
    // Future: crease, footPosition, ballContact, etc.
  };
}
```

---

### `analyzers/policy.js`
**Responsibilities:**
- Apply mode-specific thresholds to determine verdict
- Modes: A (Ultra-Conservative), B (Conservative), C (Aggressive)

**Mode Thresholds:**
```javascript
MODE_THRESHOLDS = {
  A: { out: 0.88, inconclusive: 0.65, label: "ULTRA-CONSERVATIVE" },
  B: { out: 0.80, inconclusive: 0.55, label: "CONSERVATIVE" },  // default
  C: { out: 0.70, inconclusive: 0.45, label: "AGGRESSIVE" }
}
```

**Logic:**
- If `critical.hasBailOff && critical.hasCrease && critical.hasFoot`:
  - `confidence >= mode.out` → OUT
  - `confidence <= (1 - mode.out)` → NOT OUT
  - Otherwise → INCONCLUSIVE
- If missing critical evidence → INCONCLUSIVE (with reason)
- Quality penalties applied for low frame count or low Q score

---

### `analyzers/triggers/wicket_break_trigger.js`
**Responsibilities:**
- Detect sudden visual change events (wicket-break)
- Return event timestamp + confidence
- Used for **event hints only** (not verdict)

**Algorithm Sketch:**
```javascript
async function detectWicketBreak(frames, { minFrames, spikeThreshold, prominenceRatio }) {
  // 1. Compute frame-to-frame difference (histogram or pixel diff)
  // 2. Detect sharp spikes above threshold
  // 3. Verify prominence (spike / local baseline)
  // 4. Return { triggered: bool, eventTs, confidence, evidence }
}
```

**Output:**
```javascript
{
  triggered: true,
  eventTs: 12.34,
  confidence: 0.85,
  evidence: { spikeHeight, baseline, prominenceRatio }
}
```
---

## Timeline Feature

### Purpose
Visual representation of key events during dismissal analysis window.

### Components
1. **Timeline Bar** - Horizontal bar spanning analysis window (t0 → t1)
2. **Markers** - Vertical bars positioned at event timestamps
3. **Legend** - Text summary of detected events

### Marker Types
- **Bail-off** (red) - User-selected or auto-detected bail removal
- **Event candidate** (yellow) - Wicket-break trigger detection
- **Future:** Bounce, impact, crease crossing, etc.

### Interactions
- **Click marker** → Seek video to event timestamp
- **Hover** → Show event description tooltip
- **Selected state** → Highlight clicked marker

### Data Structure
```javascript
timelineEvent = {
  id: "bail_off",  // unique within dismissal
  ts: 12.34,
  description: "Bail-off (auto 85%)",
  markerColor: "rgba(220,38,38,0.9)",
  evidence: { method: "auto", confidence: 0.85 }
}
```

---

## Storage & Persistence

### Chrome Storage (Local)
```javascript
// Per-video dismissal state
fanDRS_dismissals_{videoId} = {
  dismissals: [{ id, window, challenge, timelineEvents, createdAt }],
  activeDismissalId: "...",
  lastSavedAt: "2025-01-28T..."
}

// Legacy: Single bail-off per video (migrating to dismissals model)
fanDRS_bailOff_{videoId} = {
  ts: 12.34,
  frameId: "frame_42",
  createdAt: "2025-01-28T..."
}

// Global settings
fanDRS_mode = "A" | "B" | "C"

// Metrics ring buffer (last 100 events)
fanDRS_pickerMetrics = [
  { event: "selection_made", data: {...}, timestamp: "..." },
  ...
]
```

---

## Running the Extension

### Development Setup
1. Clone repository
2. Open Chrome → `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select extension root folder

### Testing
1. Navigate to YouTube cricket video
2. Extension auto-detects if 2+ cricket keywords present
3. Or force-enable: `?fan_drs=1` query parameter
4. Click "Fan DRS Review" button or floating "DRS" handle
5. Let sidebar buffer frames for ~3 seconds
6. Click "Analyze" to run stumping analysis

### Debug Console
- **Content script:** Right-click page → Inspect → Console
- **Sidebar:** Right-click sidebar → Inspect frame → Console
- **Service worker:** `chrome://extensions/` → Extension details → Inspect views: service worker

---

## Development Workflow

### Adding a New Detector
1. Create analyzer in `src/analyzers/{type}/` (e.g., `lbw/`, `edge/`)
2. Implement interface matching `stumping/index.js` pattern
3. Return `{ confidence, critical, evidenceList, ... }`
4. Import and call from `sidebar.js` analysis pipeline
5. Update `policy.js` if new critical requirements needed

### Adding Timeline Events
1. Detect event in analyzer (e.g., ball bounce at ts=X)
2. Return event metadata in analyzer response
3. Call `addTimelineEvent({ id, ts, description, markerColor, evidence })` in `sidebar.js`
4. Marker automatically renders and enables seeking

### Modifying Policy Thresholds
1. Edit `MODE_THRESHOLDS` in `analyzers/policy.js`
2. Adjust `out`, `inconclusive` thresholds per mode
3. Test across modes A/B/C with sample clips
---

## Future Enhancements (Phase 2+)

- **Official DRS OCR:** Extract pitching/impact/wickets from broadcast overlays
- **LBW ball tracking:** Predict trajectory after impact
- **Edge detection:** UltraEdge-style waveform analysis
- **Multi-dismissal tracking:** Compare multiple dismissals per video
- **Accuracy Boost API:** Optional server-side ML models (with user consent)
- **Feedback loop:** Collect user agreements/disagreements for calibration

---

## Common Issues

### Button not appearing
- Check cricket keyword detection: `isLikelyCricketVideo()` logs to console
- Force-enable with `?fan_drs=1` query parameter
- Ensure YouTube page fully loaded (waits 800ms, 2s, 4s retries)

### "Not enough keyframes" error
- Keep sidebar open for 2-3 seconds before clicking Analyze
- Check buffer status poll (logs `recentFrames` count)
- Verify video is playing (not paused) during buffering

### Timeline markers not clickable
- Ensure `state.keyframes.t0` and `t1` are set (run Analyze first)
- Check console for event registration errors
- Verify message bridge between sidebar ↔ content script

### Extension context invalidated after reload
- Chrome MV3 service workers can terminate between messages
- Storage operations wrapped in try-catch with warnings
- Reload extension in `chrome://extensions/` if sidebar stops responding

---

## Code Style

- **ES modules** (`import`/`export`) for analyzers
- **Vanilla JS** (no framework) for content script & sidebar
- **Async/await** for storage & analysis operations
- **Message-passing** for cross-context communication
- **Conservative by default:** Prefer INCONCLUSIVE over wrong calls
- **Comments:** Explain "why" not "what" for complex logic

---

## Contact & Contribution

This is a Phase 1 prototype. Future phases will add:
- More dismissal types (LBW, caught behind, run out)
- Official DRS overlay extraction
- Optional server-side accuracy boost
- User calibration & feedback loop

For questions or contributions, see repository issues or discussions.