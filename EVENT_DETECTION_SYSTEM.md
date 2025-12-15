# Event Detection System - Technical Reference

## Overview

The wicket-break trigger detector is a **generic event locator** that identifies high-motion moments in cricket footage. It is explicitly designed to:
- ✅ Locate potential dismissal events (bail-off, edge, impact, etc.)
- ✅ Suggest analysis windows to reduce user friction
- ❌ **NEVER** make OUT/NOT OUT decisions
- ❌ **NEVER** satisfy critical stumping signals

## Architecture

### 1. Trigger Detector (`wicket_break_trigger.js`)

**Purpose:** Detect frame-delta spikes indicating sudden motion events

**Algorithm:**
1. Decode JPEG frames to ImageData via OffscreenCanvas
2. Extract ROI (region of interest) - dual zones: left-bottom + right-bottom
3. Downsample ROI to 64x64 grid for performance
4. Compute frame-to-frame delta using luma-based MAD (Mean Absolute Difference)
5. Calculate baseline using median(delta) and dispersion using MAD
6. Detect spikes: `delta[i] > baseline + k*MAD` where k=8-10
7. Apply cut guard: reject if full-frame delta too high (camera cut)
8. Map confidence based on prominence ratio and stability

**Performance:**
- Runtime: <300ms for ~60 frames
- Memory: Bounded via canvas reuse
- Code size: <200 LOC

**Output:**
```javascript
{
  triggered: true,
  eventTs: 3.75,
  confidence: 0.87,  // Capped at 0.9, never 1.0
  method: 'frame_delta_spike',
  evidence: {
    roiUsed: 'left',
    prominence: 4.2,
    peakDelta: 0.18,
    baseline: 0.042
  }
}
```

### 2. UI Integration (`sidebar.js`)

**Hint Display Rules:**
- Show hint **only if** `confidence >= 0.75`
- Display event timestamp + confidence badge (LOW/MED/HIGH)
- User can "Use suggested window" or "Dismiss"
- Dismissed hints don't re-appear for that videoId (session-based)

**Suggested Window:**
- Sets analysis window to `[eventTs - 8s, eventTs + 3s]`
- Adds timeline marker labeled "Event candidate"
- Does NOT auto-select bail-off frame (user must confirm)

### 3. Confidence Separation

**Two distinct confidence channels:**

| Channel | Purpose | Shown In |
|---------|---------|----------|
| **Event Confidence** | How certain we are an event occurred at `ts` | Hint badge, timeline marker |
| **Verdict Confidence** | How certain we are about OUT/NOT OUT | Verdict meter, policy decision |

**Critical Rule:** Event confidence **NEVER** directly contributes to verdict confidence.

**Policy Boundaries:**
```javascript
// ✅ ALLOWED
state.eventCandidate = { ts, confidence, type, evidence };
window = suggestWindowAroundEvent(ts);
timelineMarker = addCandidateMarker(ts);

// ❌ FORBIDDEN
critical.hasBailOff = eventCandidate.confidence > 0.8; // NO!
verdict = eventCandidate.confidence > 0.9 ? "OUT" : "NOT_OUT"; // NO!
```

### 4. "Why" Bullets Separation

**Event Detection Line (informational):**
```
⚡ Event detected at 12:34 (confidence: 87% - event locator, not dismissal verdict)
```

**Stumping Requirements Line (policy gate):**
```
ℹ️ Stumping decision requires: bail-off + crease + foot position (✓ bail-off, ✗ crease, ✗ foot)
```

This makes it crystal clear:
- Event detection found *something*
- But stumping verdict still needs critical signals

## Future Extensibility

### Repurposing for Other Events

The trigger detector is **mode-agnostic** and can detect:
- **Bail-off** - Already implemented
- **Edge detection** - Similar spike in different ROI (bat-ball contact zone)
- **Ball bounce** - Floor ROI with downward motion spike
- **Impact (pad)** - Mid-frame ROI with sudden color change
- **Catch** - Fielder hands ROI with convergence spike

**To add a new event type:**
1. Create `extension/src/analyzers/triggers/[event_name]_trigger.js`
2. Export `detect[EventName](frames, opts)` with same signature
3. Update sidebar to call detector for relevant dismissal modes
4. Add timeline marker color/type for new event

### Non-Cricket Use Cases

The algorithm can detect any sudden motion event:
- **Sports:** Goal moments, tackle impacts, collision detection
- **Surveillance:** Person entering/leaving frame, fall detection
- **Wildlife:** Animal appearance, movement tracking
- **Manufacturing:** Defect detection, assembly line anomalies

## Testing

**Test Scenarios:**
1. **High-motion clip** (actual wicket) → Should trigger with confidence ~0.8-0.9
2. **Camera cut** → Should reject (cut guard)
3. **Slow motion replay** → Should NOT trigger (no spike)
4. **Multiple events** → Should pick first major peak, reduce confidence if ambiguous

**Console Debug:**
```javascript
console.log('[Fan DRS] Event detection:', {
  triggered: true,
  eventTs: 3.75,
  confidence: 0.87,
  evidence: {...}
});
```

## Acceptance Criteria

### ✅ Trigger Detector
- [x] Detects bail-off in high-motion clips
- [x] Does NOT spam triggers on normal footage
- [x] Rejects camera cuts via full-frame delta guard
- [x] Returns usable timestamp when triggered
- [x] Runtime < 300ms for 60 frames

### ✅ UI Hint
- [x] Hint appears only when confidence >= 0.75
- [x] Shows event timestamp + confidence badge
- [x] "Use suggested window" updates timeline + window display
- [x] "Dismiss" hides hint and prevents re-show
- [x] No UI clutter when no event detected

### ✅ Policy Separation
- [x] Event confidence NEVER sets verdict OUT/NOT OUT
- [x] Event confidence NEVER satisfies critical signals
- [x] "Why" bullets clearly separate event vs verdict
- [x] Even 90% event confidence → INCONCLUSIVE if signals missing
- [x] Two distinct confidence channels displayed

## Migration Notes

**Before (Phase 1.0):**
- Bail-off detection was tightly coupled to stumping analysis
- No distinction between "found an event" and "confirmed bail-off"

**After (Phase 1.1):**
- Event detection is separate, reusable system
- Bail-off confirmation still requires manual selection or high-confidence CV
- Users can leverage event hints without auto-decisions

**Breaking Changes:** None - existing bail-off flow unchanged
