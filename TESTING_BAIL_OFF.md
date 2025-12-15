# Testing Bail-Off Detection Features

## How to Test

### 1. Load the Extension

1. Open Chrome/Edge
2. Go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `extension` folder
6. Force-enable on any YouTube video by adding `&fan_drs=1` to the URL

### 2. Test Auto-Detection

1. Open any YouTube video with `&fan_drs=1` parameter
2. Click "Fan DRS Review" button
3. Click "Analyze" in the sidebar
4. **Check the browser console** (F12 → Console tab) for logs:
   ```
   [Fan DRS] Bail-off detection result: {bailOffTs: ..., confidence: ..., method: ...}
   [Fan DRS] Auto-detected bail-off at ...
   [Fan DRS] Policy decision: {verdict: ..., reason: ...}
   ```

**Expected Results:**
- If auto-detection succeeds (confidence ≥ 65%):
  - Status shows "Bail-off auto-detected at X:XX (XX% confidence)"
  - Timeline marker appears at detected position (green marker)
  - Verdict should be **OUT** (if confidence > 75-85% depending on mode)
  - "Why" tab shows "Bail-off auto-detected at X:XX"
  
- If auto-detection fails (low confidence):
  - Status shows "Bail-off not confidently detected. Use Challenge Mode"
  - Verdict stays **INCONCLUSIVE** with reason "Missing bail-off moment"
  - Console shows `[Fan DRS] Auto-detection failed - use manual picker`

### 3. Test Manual Picker

1. Click the "Challenge" tab
2. Click "Pick frame" button
3. You should see a grid of thumbnail frames
4. Click any frame to select it
5. Selected frame gets:
   - Green border
   - Checkmark overlay
   - Timestamp shown at bottom

**Expected Results:**
- Selection persists across page refresh (same video)
- "Selected: X:XX (manual) (+15 reliability boost)" appears
- Timeline marker updates to show selected position
- On next "Analyze", verdict should be **OUT** (assuming confidence > threshold)
- Console shows: `[Fan DRS] Using existing bail-off selection: X.XXs`

### 4. Test Clear Selection

1. In Challenge tab with picker open
2. Click "Clear selection"

**Expected Results:**
- Green border and checkmark disappear
- Timeline marker hides
- "No bail-off selected yet" message shown
- Next analysis will try auto-detection again

### 5. Check Policy Logic

Open browser console and look for:
```javascript
[Fan DRS] Policy decision: {
  verdict: "OUT",  // or "INCONCLUSIVE"
  reason: "...",
  confidence: 0.85,  // should be 0.70-0.85 when bail-off detected
  critical: { hasBailOff: true, hasCrease: false, hasFoot: false }
}
```

**Phase 1 Logic:**
- ✅ Only bail-off required (crease/foot disabled for testing)
- ✅ Confidence boosted to 70-85% when bail-off detected
- ✅ Mode B threshold: 85% (Mode C: 75%, Mode A: 90%)
- ✅ Returns "OUT" as stub verdict for testing

## Troubleshooting

### Still says INCONCLUSIVE?

Check console logs to see which gate is blocking:

1. **"Too few frames"** → Wait 2-3 seconds before analyzing
2. **"Low video quality"** → Video resolution too low (< 854px width)
3. **"Missing bail-off moment"** → Auto-detection failed, try manual picker
4. **"Below decision threshold"** → Confidence < 85% (try Mode C for 75% threshold)

### Auto-detection not working?

The heuristic looks for:
- **Spike in ROI pixel changes** (bail moving/falling)
- **Conservative threshold** (k=8 MAD from median)
- **Camera cut rejection** (whole-frame delta check)

Videos with lots of camera movement or cuts may fail. Use manual picker as fallback.

### Timeline marker not showing?

- Make sure you ran "Analyze" to capture keyframes first
- Check if `state.keyframes.t0` and `t1` are set (console log)
- Marker position calculated as: `((bailOffTs - t0) / (t1 - t0)) * 100%`

## What Success Looks Like

✅ **Auto-detection working:**
- Console shows detection result with confidence
- Timeline green marker appears
- Verdict changes from INCONCLUSIVE to OUT
- Status message confirms detection

✅ **Manual picker working:**
- Frame grid renders all thumbnails
- Click selects frame (visual feedback)
- Selection persists across refresh
- Metrics logged to storage

✅ **Both integrated:**
- Auto-detection tries first
- Manual picker available as fallback
- Both update timeline marker
- Both boost confidence → verdict OUT

## Next Steps (Phase 2)

Once bail-off is working:
1. Implement crease line detection/manual selection
2. Implement foot position detection
3. Re-enable all 3 critical signals in policy
4. Actual stumping logic (foot behind/beyond crease at bail-off moment)
