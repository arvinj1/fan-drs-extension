# Detector Interface Contract

**Purpose:** Standardized types and interfaces for all vision-based detectors in the Fan DRS extension.

**Version:** 1.0.0 (Phase 1)

---

## Core Types

### Frame
Represents a single video frame from the rolling buffer.

```typescript
interface Frame {
  ts: number;        // Timestamp in seconds (relative to video start)
  jpeg: string;      // Base64-encoded JPEG data URL
}
```

**Example:**
```javascript
{
  ts: 12.345,
  jpeg: "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```

---

### KeyframesPayload
Batch of frames returned from content script for analysis.

```typescript
interface KeyframesPayload {
  t0: number;        // Window start time (seconds)
  t1: number;        // Window end time (seconds)
  frames: Frame[];   // Array of frames in window
  quality: QualityMetadata;
}

interface QualityMetadata {
  thumbWidth: number;       // Captured thumbnail width (e.g., 320)
  intervalMs: number;       // Capture interval (e.g., 250)
  videoWidth: number | null;   // Original video width
  videoHeight: number | null;  // Original video height
  bufferedFrames: number;   // Total frames in rolling buffer
}
```

---

### AnalysisWindow
Time window being analyzed (typically last 12 seconds).

```typescript
interface AnalysisWindow {
  t0: number;  // Start time (seconds)
  t1: number;  // End time (seconds)
}
```

---

### ChallengeState
User-provided assistance (Challenge Mode).

```typescript
interface ChallengeState {
  bailOffTs: number | null;       // User-selected bail-off timestamp
  bailOffFrameId: string | null;  // Frame ID (e.g., "frame_42")
  autoDetected: boolean;           // Was bail-off auto-detected (vs manual)?
  
  // Future Challenge Mode fields:
  creaseLine?: { x1: number, y1: number, x2: number, y2: number };
  impactPoint?: { x: number, y: number, ts: number };
  ballTrajectory?: Array<{ x: number, y: number, ts: number }>;
}
```

---

### Evidence
Single piece of evidence supporting a verdict.

```typescript
interface Evidence {
  type: string;           // Evidence type (e.g., "bail_displacement", "foot_position")
  notes: string;          // Human-readable explanation
  confidence?: number;    // Evidence-specific confidence (0.0-1.0)
  frames?: number[];      // Related frame timestamps
  metrics?: Record<string, any>;  // Quantitative metrics
}
```

**Examples:**
```javascript
// Bail displacement evidence
{
  type: "bail_displacement",
  notes: "Bail moved 42px left between 12.2s and 12.3s",
  confidence: 0.85,
  frames: [12.2, 12.3],
  metrics: {
    displacement: 42,
    threshold: 25,
    direction: "left"
  }
}

// Foot position evidence
{
  type: "foot_position",
  notes: "Foot 8px behind crease at 12.34s",
  confidence: 0.90,
  frames: [12.34],
  metrics: {
    distanceFromCrease: -8,  // Negative = behind crease
    creaseConfidence: 0.75
  }
}
```

---

### CriticalFlags
Binary flags indicating presence of critical evidence.

```typescript
interface CriticalFlags {
  // Stumping-specific
  hasBailOff?: boolean;
  hasCrease?: boolean;
  hasFoot?: boolean;
  
  // LBW-specific
  hasPitching?: boolean;
  hasImpact?: boolean;
  hasTrajectory?: boolean;
  
  // Edge detection-specific
  hasEdge?: boolean;
  hasDeviation?: boolean;
  hasSoundSpike?: boolean;
}
```

---

### DebugOutput
Optional debug information for development and tuning.

```typescript
interface DebugOutput {
  annotatedFrames?: AnnotatedFrame[];
  intermediateSteps?: any[];  // Detector-specific intermediate results
  warnings?: string[];        // Warnings about data quality or edge cases
  metrics?: Record<string, any>;  // Internal metrics for tuning
}

interface AnnotatedFrame {
  frameId: string;
  ts: number;
  jpeg: string;  // Original frame
  annotations: Annotation[];
}

interface Annotation {
  type: 'bbox' | 'line' | 'point' | 'polygon' | 'text';
  label: string;
  coords: any;  // Type-specific coordinates
  color: string;  // RGBA string
}
```

---

## Detector Output Interface

All detectors (stumping, LBW, edge, etc.) return this structure:

```typescript
interface DetectorResult {
  // Core verdict
  confidence: number;  // 0.0-1.0 (after quality penalties)
  
  // Critical evidence flags (type-specific)
  critical: CriticalFlags;
  
  // Human-readable evidence list
  evidenceList: Evidence[];
  
  // Type-specific detection results (optional)
  bailOff?: BailOffResult;
  crease?: CreaseResult;
  footPosition?: FootPositionResult;
  
  // Debug outputs (optional, only if debug=true)
  debug?: DebugOutput;
}
```

---

## Detector Input Interface

All detectors accept these parameters:

```typescript
interface DetectorInput {
  frames: Frame[];              // Input frames (from KeyframesPayload.frames)
  window: AnalysisWindow;       // Time window being analyzed
  challenge?: ChallengeState;   // Optional user-provided hints
  mode?: 'A' | 'B' | 'C';      // Policy mode (default: 'B')
  config?: any;                 // Detector-specific config (thresholds, etc.)
  debug?: boolean;              // Enable debug output (default: false)
}
```

---

## Type-Specific Result Interfaces

### BailOffResult
```typescript
interface BailOffResult {
  ts: number;           // Timestamp of bail-off event
  method: 'auto' | 'manual' | 'hybrid';
  confidence: number;   // Detection confidence (0.0-1.0)
  displacement?: number;  // Pixel displacement (if auto-detected)
  frameId?: string;     // Associated frame ID
}
```

### CreaseResult
```typescript
interface CreaseResult {
  detected: boolean;
  line?: {
    x1: number, y1: number,
    x2: number, y2: number
  };
  confidence: number;
  method: 'hough' | 'edge_detection' | 'manual';
}
```

### FootPositionResult
```typescript
interface FootPositionResult {
  detected: boolean;
  position?: { x: number, y: number };
  distanceFromCrease?: number;  // Pixels (negative = behind crease)
  confidence: number;
  ts: number;  // Timestamp of foot position
}
```

---

## Example: Stumping Detector

```javascript
// src/analyzers/stumping/index.js

/**
 * Stumping analyzer - orchestrates bail-off, crease, and foot detection
 */
export async function runStumping(input) {
  const { frames, window, challenge, mode = 'B', config, debug = false } = input;
  
  // 1. Run sub-detectors
  const bailOffResult = await detectBailOff(frames, config?.bailOff, debug);
  const creaseResult = await detectCrease(frames, config?.crease, debug);
  const footResult = await detectFootPosition(frames, creaseResult, config?.foot, debug);
  
  // 2. Merge evidence lists
  const evidenceList = [
    ...bailOffResult.evidenceList,
    ...creaseResult.evidenceList,
    ...footResult.evidenceList
  ];
  
  // 3. Compute combined confidence
  let rawConfidence = 0.0;
  
  if (bailOffResult.critical.hasBailOff && 
      creaseResult.critical.hasCrease && 
      footResult.critical.hasFoot) {
    
    const weights = { bailOff: 0.4, crease: 0.3, foot: 0.3 };
    rawConfidence = 
      weights.bailOff * bailOffResult.confidence +
      weights.crease * creaseResult.confidence +
      weights.foot * footResult.confidence;
  } else {
    rawConfidence = 0.30;
  }
  
  // 4. Apply quality penalties
  const Q = computeQualityQ({ frames, quality: {...} });
  const framePenalty = computeFrameCountPenalty(frames.length);
  const finalConfidence = rawConfidence * Q * framePenalty;
  
  // 5. Build result
  return {
    confidence: finalConfidence,
    critical: {
      hasBailOff: bailOffResult.critical.hasBailOff,
      hasCrease: creaseResult.critical.hasCrease,
      hasFoot: footResult.critical.hasFoot
    },
    evidenceList,
    bailOff: bailOffResult.bailOff,
    crease: creaseResult.crease,
    footPosition: footResult.footPosition,
    debug: debug ? {
      annotatedFrames: [
        ...bailOffResult.debug?.annotatedFrames ?? [],
        ...creaseResult.debug?.annotatedFrames ?? [],
        ...footResult.debug?.annotatedFrames ?? []
      ]
    } : undefined
  };
}
```

---

## Policy Application Interface

```javascript
// src/analyzers/policy.js

export function applyPolicy(input) {
  const { mode, confidence, qualityQ, framesCount, critical } = input;
  const thresh = MODE_THRESHOLDS[mode];
  
  // 1. Check critical gates
  if (critical.hasBailOff === false) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'No bail-off detected (critical requirement)',
      confidence: 0.30
    };
  }
  
  // 2. Apply quality penalties
  const framePenalty = computeFrameCountPenalty(framesCount);
  const adjustedConfidence = confidence * qualityQ * framePenalty;
  
  // 3. Apply mode thresholds
  if (adjustedConfidence >= thresh.out) {
    return { verdict: 'OUT', reason: 'Strong evidence', confidence: adjustedConfidence };
  }
  if (adjustedConfidence <= (1 - thresh.out)) {
    return { verdict: 'NOT OUT', reason: 'Evidence against OUT', confidence: adjustedConfidence };
  }
  
  return { 
    verdict: 'INCONCLUSIVE', 
    reason: 'Evidence present but not conclusive', 
    confidence: adjustedConfidence 
  };
}
```

---

## Timeline Event Interface

```typescript
interface TimelineEvent {
  id: string;              // Unique ID within dismissal (e.g., "bail_off")
  ts: number;              // Timestamp (seconds)
  description: string;     // Human-readable label
  markerColor?: string;    // RGBA color for timeline marker
  evidence?: any;          // Related evidence data
}
```

---

## Storage Schema

### Per-Video Dismissals
```typescript
interface DismissalData {
  dismissals: Dismissal[];
  activeDismissalId: string | null;
  lastSavedAt: string;  // ISO timestamp
}

interface Dismissal {
  id: string;  // "{videoId}_{t0}_{t1}"
  window: AnalysisWindow;
  challenge: ChallengeState;
  timelineEvents: TimelineEvent[];
  createdAt: string;  // ISO timestamp
}
```

**Storage key:** `fanDRS_dismissals_{videoId}`

---

## Usage Examples

### Basic Stumping Analysis
```javascript
import { runStumping } from './analyzers/stumping/index.js';
import { applyPolicy } from './analyzers/policy.js';

// 1. Get frames from content script
const keyframes = await requestKeyframes(t0, t1, 60);

// 2. Run detector
const result = await runStumping({
  frames: keyframes.frames,
  window: { t0, t1 },
  challenge: { bailOffTs: null, bailOffFrameId: null, autoDetected: false },
  mode: 'B',
  debug: false
});

// 3. Apply policy
const policy = applyPolicy({
  mode: 'B',
  confidence: result.confidence,
  qualityQ: computeQualityQ(keyframes),
  framesCount: keyframes.frames.length,
  critical: result.critical
});

// 4. Display verdict
console.log('Verdict:', policy.verdict);
console.log('Evidence:', result.evidenceList);
```

### With Challenge Mode
```javascript
// User selected bail-off frame
const challenge = {
  bailOffTs: 12.34,
  bailOffFrameId: "frame_42",
  autoDetected: false
};

const result = await runStumping({
  frames: keyframes.frames,
  window: { t0, t1 },
  challenge,  // Boosts confidence
  mode: 'B'
});

// Add timeline marker
addTimelineEvent({
  id: "bail_off",
  ts: challenge.bailOffTs,
  description: "Bail-off (manual)",
  markerColor: "rgba(220, 38, 38, 0.9)"
});
```

---

## Testing Checklist

For each new detector:

- [ ] Implements `DetectorResult` interface
- [ ] Accepts `DetectorInput` parameters
- [ ] Validates inputs (returns graceful errors)
- [ ] Returns `critical` flags (binary gates)
- [ ] Returns `evidenceList` with human-readable notes
- [ ] Applies quality penalties (Q, frame count)
- [ ] Supports debug mode (`debug: true`)
- [ ] Works with all policy modes (A/B/C)
- [ ] Handles edge cases (empty frames, missing data)
- [ ] Includes unit tests for core functions

---

## Summary

This contract ensures:
1. **Consistency** - All detectors follow same patterns
2. **Interoperability** - Detectors can be combined/chained
3. **Debuggability** - Debug mode reveals internal state
4. **Extensibility** - Easy to add new dismissal types
5. **Type safety** - Clear contracts reduce bugs