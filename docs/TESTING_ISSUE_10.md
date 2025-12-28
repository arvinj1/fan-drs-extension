# Testing Guide: Issue #10 - Stump & Bail-off Detection

## Overview
This guide covers manual testing for the newly implemented stump detection and enhanced bail-off detection features with debug visualization.

## Prerequisites
- Chrome with extension loaded in developer mode
- Access to YouTube stumping videos (see recommended videos below)
- DevTools console open (F12)

## Recommended Test Videos
1. **Clear stumping (MS Dhoni classic)**: Search "dhoni stumping slow motion"
2. **Low contrast stumping**: Search "stumping night match"
3. **Angled camera**: Search "stumping behind wicket view"
4. **Multiple stumpings compilation**: Search "best stumpings 2023"

## Test Scenarios

### Scenario 1: Basic Stump Detection

**Objective**: Verify stump detection works on clear front-on camera angles

**Steps**:
1. Load a YouTube video with clear stumping
2. Set window to cover stumping (e.g., 10s-15s)
3. Click "Analyze" in Fan DRS sidebar
4. Check console for log: `[Stumping] Detected X stumps with Y% confidence`
5. Verify in Challenge tab evidence list:
   - Evidence bullet: "Detected 3 stumps with 75% confidence" (or similar)
   - Critical flag `hasStumps: true` if confidence ≥ 50%

**Expected Results**:
- 3 stumps detected with 60-85% confidence on clear videos
- 2 stumps detected if one is occluded (confidence 50-70%)
- <150ms execution time (check console timing)

**Manual Console Test**:
```javascript
// Test stump detection directly
const { detectStumps, createStumpDebugVisualization } = 
  await import(chrome.runtime.getURL('src/analyzers/stumping/stump_detection.js'));

const frames = window.frames[0].state.keyframes.frames;
const result = await detectStumps(frames, { debugMode: true });
console.log('Stump detection result:', result);

// Show visualization
const canvas = createStumpDebugVisualization(result.artifacts);
document.body.appendChild(canvas);
canvas.style.position = 'fixed';
canvas.style.top = '10px';
canvas.style.right = '10px';
canvas.style.zIndex = '9999';
```

**Artifacts to verify**:
- `result.stumps`: Array of 2-3 objects with `{x, confidence}`
- `result.confidence`: 0.50-0.90 range
- `result.frameIndex`: Index of best frame
- Visualization: 3 panels (ROI | Edges | Detected Lines)

---

### Scenario 2: Bail-off Detection with Debug

**Objective**: Verify bail-off spike detection and delta heat maps

**Steps**:
1. Load stumping video
2. Analyze with window covering bail-off moment
3. Check console for: `[Stumping] Bail-off detected at Xs (Y% confidence)`
4. Open Challenge tab → Debug Controls panel
5. Click "Show visualization"
6. Re-analyze if needed

**Expected Results**:
- Bail-off detected within ±0.1s of actual moment
- 65-95% confidence on clear videos
- <100ms execution time

**Manual Console Test**:
```javascript
// Test bail-off detection with debug
const { detectBailOff, createBailOffDebugVisualization } = 
  await import(chrome.runtime.getURL('src/analyzers/stumping/bail_detection.js'));

const frames = window.frames[0].state.keyframes.frames;
const result = await detectBailOff(frames, { 
  debugMode: true,
  spikeThreshold: 8,
  cutThreshold: 0.35
});
console.log('Bail-off result:', result);

// Show visualization
if (result && result.artifacts) {
  const canvas = createBailOffDebugVisualization(result.artifacts, result.frameIndex);
  if (canvas) {
    document.body.appendChild(canvas);
    canvas.style.position = 'fixed';
    canvas.style.top = '10px';
    canvas.style.left = '10px';
    canvas.style.zIndex = '9999';
  }
}
```

**Artifacts to verify**:
- `result.frameIndex`: Index of spike frame
- `result.artifacts.deltaMasks`: Array of heat map ImageData
- `result.artifacts.deltas`: Timeline of frame deltas
- Visualization: Delta graph + heat map of spike frame
- Red spike marker on timeline graph
- Heat map shows high-change pixels in red/yellow

---

### Scenario 3: Debug Controls Tuning

**Objective**: Verify debug sliders work and affect detection

**Steps**:
1. Load video with difficult lighting (low contrast stumps)
2. Analyze → likely fails to detect stumps
3. Open Debug Controls panel
4. Adjust **Stump Detection** sliders:
   - Lower "Angle Tolerance" to 5° (more strict)
   - Lower "Min Line Length" to 25px (shorter lines OK)
5. Click "Show visualization" to see edges
6. Re-analyze
7. Check if detection improves

**Expected Results**:
- Sliders update values in real-time
- Console logs: `[Fan DRS Debug] stumpAngleTolerance = 5`
- Detection behavior changes after re-analysis
- Reset button restores defaults

**Slider Ranges**:
- Stump Angle Tolerance: 5-20° (default: 10°)
- Stump Min Line Length: 20-80px (default: 40px)
- Bail Spike Threshold (k): 5-12 (default: 8)
- Bail Cut Guard Threshold: 0.2-0.6 (default: 0.35)

---

### Scenario 4: Multi-Dismissal Compilation

**Objective**: Verify detection works on multiple stumpings in one video

**Steps**:
1. Load "best stumpings compilation" video
2. For each stumping:
   - Set dismissal window (e.g., 5s-10s, 15s-20s, etc.)
   - Click "Analyze"
   - Check stump + bail-off detection
3. Navigate between dismissals using sidebar controls
4. Verify each has isolated detection results

**Expected Results**:
- Each dismissal window analyzed independently
- Stump/bail-off confidence varies per clip
- No cross-contamination between dismissals
- Total execution <300ms per dismissal

---

### Scenario 5: Failure Modes

**Objective**: Verify graceful degradation on unsuitable footage

**Test Cases**:

**A) Angled camera (side-on view)**:
- Expected: Stumps not detected (confidence <50%)
- Evidence: "Stumps not detected. Camera angle may be unsuitable."

**B) Occluded stumps (keeper blocking)**:
- Expected: 1-2 stumps detected instead of 3
- Confidence: 40-60% range
- Evidence: "Detected 2 stumps with 55% confidence"

**C) Camera cut during bail-off**:
- Expected: Bail-off detection fails (anti-cut guard)
- No false positive spike from scene change

**D) Very short window (<1s)**:
- Expected: Low confidence or no detection
- <30 frames not enough data

**Console Commands**:
```javascript
// Check critical flags
const result = await window.frames[0].state.activeDismissal.analysis;
console.log('Critical signals:', result.critical);
// Should show: {hasStumps: false, hasBailOff: false, hasCrease: ?, ...}

// Check evidence list
console.log('Evidence:', result.evidenceList.map(e => e.text));
```

---

## Performance Benchmarks

**Target Performance**:
- Stump detection: <150ms (60 frames)
- Bail-off detection: <100ms (60 frames)
- Crease detection: <50ms (60 frames)
- Total stumping analysis: <300ms

**Measure Performance**:
```javascript
// In stumping analyzer
console.time('Stump Detection');
const stumpResult = await detectStumps(frames, config);
console.timeEnd('Stump Detection');
```

**Warnings**:
- If >80 frames: Consider adding warning in UI
- If total >500ms: Frame subsampling recommended

---

## Debug Visualization Checklist

### Stump Detection Visualization
- [ ] 3 panels displayed (ROI | Edges | Lines)
- [ ] ROI shows bottom-center crop of frame
- [ ] Edges panel shows vertical edge features
- [ ] Lines panel overlays detected verticals in green
- [ ] Clustered stumps highlighted in yellow boxes
- [ ] Confidence score displayed

### Bail-off Detection Visualization
- [ ] Delta timeline graph displayed
- [ ] X-axis: Frame index, Y-axis: Delta magnitude
- [ ] Spike frame marked with red circle
- [ ] Heat map panel shows 64x64 ROI
- [ ] Hot pixels (high change) in red/yellow
- [ ] Cool pixels (low change) in blue
- [ ] ROI box labeled (e.g., "STUMPS ROI")

---

## Known Limitations

1. **Camera angle**: Works best on front-on views (0-30° from horizontal)
   - Side-on angles (60-90°) will fail stump detection
   
2. **Occlusion**: Detection degrades with:
   - Keeper blocking stumps
   - Batsman's body covering bail area
   
3. **Lighting**: Low contrast or night matches may need threshold tuning

4. **Frame rate**: Works best with 30-60 FPS source
   - <15 FPS may miss bail-off moment
   
5. **Video compression**: Heavy compression artifacts reduce edge quality

---

## Regression Tests

**Before merging, verify**:
1. Crease detection still works (Issue #9)
2. Manual challenge mode selections work
3. Multi-dismissal navigation works
4. Evidence bullets appear correctly
5. Confidence calculation includes all 3 signals (stumps, bail-off, crease)

---

## Reporting Issues

If detection fails or produces unexpected results:

1. **Console logs**: Copy relevant logs (search for `[Stumping]`)
2. **Video URL**: Share YouTube link + timestamp
3. **Detection results**: 
   ```javascript
   console.log(JSON.stringify(result, null, 2));
   ```
4. **Screenshot**: Debug visualization if available
5. **Debug config**: Share slider values used

**File issues** at: [GitHub Issues](https://github.com/your-repo/issues)

---

## Success Criteria

Issue #10 is complete when:
- [x] Stump detection module created (`stump_detection.js`)
- [x] Bail-off detection enhanced with debug artifacts
- [x] Debug UI controls added to sidebar
- [x] Integration into stumping analyzer
- [x] Visualization functions for both modules
- [x] Performance <300ms total execution
- [ ] Manual testing on 5+ videos (all scenarios)
- [ ] No regressions in existing features

