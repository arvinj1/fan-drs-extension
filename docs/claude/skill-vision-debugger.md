# Skill Vision Debugger - Debug-First Heuristics

**Purpose:** Enforce vision-based detector quality standards with adjustable confidence thresholds and evidence requirements.

**Philosophy:** Debug first, optimize later. Every detector must explain its reasoning and degrade gracefully under poor conditions.

---

## Core Principles

### 1. Evidence Over Confidence
- A detector that says "I don't know" is better than one that guesses
- Every verdict must be backed by explicit evidence items
- Confidence alone is not evidence — it's a summary metric

### 2. Quality-Aware Degradation
- Low frame count → Lower confidence ceiling
- Low resolution → More conservative thresholds
- Missing critical evidence → Automatic INCONCLUSIVE

### 3. Debug-First Implementation
**Every detector MUST provide:**
- Frame-by-frame debug logs (optional toggle)
- Visualized intermediate outputs (annotated frames)
- Evidence list with quantitative metrics
- Failure mode descriptions

### 4. Human-Interpretable Metrics
Avoid black-box scores. Use metrics a human could verify:
- ✅ "Bail displaced 42px between frames"
- ✅ "Foot 8px behind crease line at t=12.34s"
- ❌ "Neural network score: 0.87"

---

## Heuristic Framework

### Required Outputs
Every detector implements this interface:

```javascript
{
  // Core verdict
  confidence: 0.0-1.0,           // Overall confidence (after quality penalties)
  
  // Critical evidence flags (binary gates)
  critical: {
    hasBailOff: boolean,
    hasCrease: boolean,
    hasFoot: boolean,
    // ... other type-specific flags
  },
  
  // Evidence list (human-readable)
  evidenceList: [
    {
      type: "bail_displacement",
      notes: "Bail moved 42px left between frames 12.2s and 12.3s",
      confidence: 0.85,
      frames: [frameId1, frameId2],
      metrics: { displacement: 42, threshold: 25 }
    },
    // ... more evidence items
  ],
  
  // Debug outputs (if enabled)
  debug?: {
    annotatedFrames: [{ frameId, jpeg, annotations: [...] }],
    intermediateSteps: [...],
    warnings: ["Low contrast in crease region", ...]
  }
}
```

---

## Adjustable Thresholds

### Mode-Based Policy (Global)
Defined in `analyzers/policy.js`:

```javascript
MODE_THRESHOLDS = {
  // Ultra-Conservative: Minimal false positives
  A: {
    out: 0.88,              // Require 88%+ confidence for OUT
    inconclusive: 0.65,     // Below 65% → NOT OUT
    label: "ULTRA-CONSERVATIVE",
    description: "Only call OUT with extremely strong evidence"
  },
  
  // Conservative: Balanced (default)
  B: {
    out: 0.80,
    inconclusive: 0.55,
    label: "CONSERVATIVE",
    description: "Default: only call OUT when evidence is strong"
  },
  
  // Aggressive: More calls
  C: {
    out: 0.70,
    inconclusive: 0.45,
    label: "AGGRESSIVE",
    description: "Make more calls, higher risk of errors on close decisions"
  }
}
```

### Detector-Specific Thresholds
Each detector can define internal thresholds (passed as config):

```javascript
// Example: Bail-off detector
const BAIL_OFF_THRESHOLDS = {
  displacement: {
    min: 15,              // Minimum pixel movement (adjustable)
    confident: 35,        // Movement above this → high confidence
  },
  brightness: {
    minChange: 0.15,      // Minimum brightness delta (0-1)
    confidentChange: 0.30
  },
  frameDelta: {
    maxGap: 3,            // Max frames between pre/post (at 250ms intervals)
  }
};

// Usage in detector
function detectBailOff(frames, config = BAIL_OFF_THRESHOLDS) {
  // ... detection logic using config.displacement.min, etc.
}
```

---

## Quality Penalties

### Frame Count Penalty
```javascript
function computeFrameCountPenalty(n) {
  // Penalize if fewer than 24 frames (~6s at 250ms)
  if (n >= 24) return 1.0;
  if (n >= 12) return 0.85;
  if (n >= 6)  return 0.65;
  return 0.40;  // Below 6 frames: severe penalty
}
```

### Resolution Quality Factor (Q)
```javascript
function computeQualityQ(keyframesPayload) {
  const n = keyframesPayload.frames.length;
  const vw = keyframesPayload.quality.videoWidth;
  const vh = keyframesPayload.quality.videoHeight;
  
  const frameCoverage = Math.min(1.0, n / 24);
  const resScore = (vw >= 1280 && vh >= 720) ? 1.0 
                 : (vw >= 854) ? 0.8 
                 : 0.6;
  
  return 0.6 * frameCoverage + 0.4 * resScore;
}
```

### Combined Confidence Adjustment
```javascript
function applyQualityPenalties(rawConfidence, Q, frameCount) {
  const framePenalty = computeFrameCountPenalty(frameCount);
  const finalConfidence = rawConfidence * Q * framePenalty;
  
  return {
    confidence: finalConfidence,
    penalties: {
      qualityQ: Q,
      framePenalty,
      rawConfidence
    }
  };
}
```

---

## Critical Evidence Gates

### Stumping Example
```javascript
function applyStumpingPolicy({ confidence, critical, qualityQ, mode }) {
  const thresh = MODE_THRESHOLDS[mode];
  
  // Gate 1: Must have bail-off detection
  if (!critical.hasBailOff) {
    return {
      verdict: "INCONCLUSIVE",
      reason: "No bail-off detected (critical requirement)",
      confidence: 0.30
    };
  }
  
  // Gate 2: Must have crease detection
  if (!critical.hasCrease) {
    return {
      verdict: "INCONCLUSIVE",
      reason: "Crease not detected (critical requirement)",
      confidence: 0.35
    };
  }
  
  // Gate 3: Must have foot position
  if (!critical.hasFoot) {
    return {
      verdict: "INCONCLUSIVE",
      reason: "Foot position unclear (critical requirement)",
      confidence: 0.40
    };
  }
  
  // All gates passed → Apply mode thresholds
  if (confidence >= thresh.out) {
    return { verdict: "OUT", reason: "All criteria met", confidence };
  }
  if (confidence <= (1 - thresh.out)) {
    return { verdict: "NOT OUT", reason: "Evidence against OUT", confidence };
  }
  
  return {
    verdict: "INCONCLUSIVE",
    reason: "Evidence present but not conclusive",
    confidence
  };
}
```

---

## Debug Visualization

### Annotated Frames
Detectors should optionally return annotated debug frames:

```javascript
{
  debug: {
    annotatedFrames: [
      {
        frameId: "frame_42",
        ts: 12.34,
        jpeg: "data:image/jpeg;base64,...",  // Original
        annotations: [
          {
            type: "bbox",
            label: "Bail (pre-displacement)",
            coords: { x: 320, y: 180, w: 40, h: 10 },
            color: "rgba(255,0,0,0.6)"
          },
          {
            type: "line",
            label: "Crease line",
            coords: { x1: 100, y1: 300, x2: 540, y2: 302 },
            color: "rgba(0,255,0,0.8)"
          },
          {
            type: "point",
            label: "Foot position",
            coords: { x: 280, y: 310 },
            color: "rgba(255,255,0,1.0)"
          }
        ]
      }
    ]
  }
}
```

### Rendering (Future UI)
```javascript
// In sidebar.js or debug panel
function renderDebugFrame(annotatedFrame) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    
    // Draw annotations
    annotatedFrame.annotations.forEach(ann => {
      if (ann.type === 'bbox') {
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(ann.coords.x, ann.coords.y, ann.coords.w, ann.coords.h);
        ctx.fillStyle = ann.color;
        ctx.fillText(ann.label, ann.coords.x, ann.coords.y - 5);
      }
      // ... handle line, point, polygon, etc.
    });
  };
  
  img.src = annotatedFrame.jpeg;
  return canvas;
}
```

---

## Detector Checklist

Before shipping a new detector, verify:

### Required Functionality
- [ ] Returns `confidence` (0.0-1.0)
- [ ] Returns `critical` flags (binary gates)
- [ ] Returns `evidenceList` with human-readable notes
- [ ] Accepts config object for thresholds
- [ ] Applies quality penalties (Q, frame count)
- [ ] Handles missing data gracefully (no crashes)

### Debug Support
- [ ] Optionally returns `debug.annotatedFrames`
- [ ] Logs intermediate steps to console (if debug flag enabled)
- [ ] Includes quantitative metrics in evidence items
- [ ] Documents failure modes in comments

### Testing
- [ ] Tested with low frame count (n=6, 12, 24)
- [ ] Tested with low resolution (480p, 720p, 1080p)
- [ ] Tested with ambiguous cases (close calls)
- [ ] Tested with missing critical elements (e.g., no visible bail)
- [ ] Verified evidence bullets are accurate

### User Experience
- [ ] Evidence bullets use cricket terminology (not CV jargon)
- [ ] Confidence thresholds tuned to minimize false positives
- [ ] INCONCLUSIVE returned when appropriate (not "guessing")
- [ ] Works with all three policy modes (A/B/C)

---

## Threshold Tuning Workflow

### 1. Collect Test Cases
- Gather 10-20 clips per dismissal type
- Include clear, ambiguous, and incorrect dismissals
- Label ground truth (OUT / NOT OUT / INCONCLUSIVE)

### 2. Run with Debug Mode
```javascript
const results = [];
for (const testCase of testCases) {
  const result = await detectBailOff(testCase.frames, config, true);
  results.push({
    videoId: testCase.videoId,
    groundTruth: testCase.label,
    predicted: result.confidence >= 0.80 ? "OUT" : "INCONCLUSIVE",
    confidence: result.confidence,
    evidence: result.evidenceList
  });
}
```

### 3. Analyze False Positives/Negatives
```javascript
const falsePositives = results.filter(r => 
  r.predicted === "OUT" && r.groundTruth !== "OUT"
);

const falseNegatives = results.filter(r => 
  r.predicted !== "OUT" && r.groundTruth === "OUT"
);

console.log('False Positives:', falsePositives.length);
console.log('False Negatives:', falseNegatives.length);

// Review debug frames for failure cases
falsePositives.forEach(fp => {
  console.log(`FP: ${fp.videoId}`, fp.evidence);
  // Display fp.debug.annotatedFrames
});
```

### 4. Adjust Thresholds
```javascript
// If too many false positives → Increase thresholds
config.displacement.min = 20;  // was 15
config.displacement.confident = 40;  // was 35

// If too many false negatives → Decrease thresholds
config.displacement.min = 12;
config.displacement.confident = 30;

// Re-run and iterate
```

### 5. Validate Across Modes
Ensure detector works well with all policy modes:
- Mode A: Should have ~0% false positives, may have false negatives
- Mode B: Balanced trade-off
- Mode C: More calls, acceptable false positive rate

---

## Common Pitfalls

### ❌ Confidence Without Evidence
```javascript
// BAD: Just returns a score
return { confidence: 0.85 };
```

```javascript
// GOOD: Explains why
return {
  confidence: 0.85,
  critical: { hasBailOff: true },
  evidenceList: [
    { notes: "Bail displaced 42px at t=12.3s (threshold: 25px)" }
  ]
};
```

### ❌ Ignoring Quality Factors
```javascript
// BAD: Fixed confidence regardless of input quality
return { confidence: 0.80 };
```

```javascript
// GOOD: Penalizes low quality
const Q = computeQualityQ(keyframes);
const framePenalty = computeFrameCountPenalty(keyframes.frames.length);
const adjustedConfidence = rawConfidence * Q * framePenalty;

return { confidence: adjustedConfidence, penalties: { Q, framePenalty } };
```

### ❌ Crashing on Missing Data
```javascript
// BAD: Assumes frames[10] exists
const displacement = frames[10].data - frames[9].data;
```

```javascript
// GOOD: Defensive checks
if (frames.length < 10) {
  return {
    confidence: 0.0,
    critical: { hasBailOff: false },
    evidenceList: [{ notes: "Insufficient frames for bail-off detection (need 10+)" }]
  };
}
```

---

## Summary

**Debug-first vision heuristics = Better UX + Faster iteration**

Every detector:
1. Returns explicit evidence (not just scores)
2. Degrades gracefully under poor conditions
3. Supports adjustable thresholds
4. Provides debug visualizations
5. Uses human-interpretable metrics

**When in doubt, return INCONCLUSIVE.** Better to say "I don't know" than guess wrong.