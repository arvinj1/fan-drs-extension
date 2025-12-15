# Testing Visual Timeline Feature

## Overview

The timeline provides visual context for dismissal analysis with interactive markers for key events.

## Features Implemented

### ✅ Timeline Data Model
- `TimelineEvent` objects with id, timestamp, description, color, and evidence
- Stored in `state.timelineEvents` array
- Automatically rendered on timeline bar

### ✅ Event Types & Colors
- **Bail-off**: Red (`rgba(220,38,38,0.9)`) - auto-detected or manual
- **Ball bounce**: Yellow (`rgba(234,179,8,0.9)`) - placeholder for future
- **Impact**: Orange (`rgba(249,115,22,0.9)`) - placeholder for future
- **Custom**: Any color for future event types

### ✅ Interactive Features
- **Hover**: Markers scale up and brighten
- **Click**: Seeks YouTube player to event timestamp
- **Selection**: Clicked marker highlights with glow effect
- **Tooltips**: Show event description and timestamp on hover

### ✅ Dynamic Rendering
- Markers positioned based on `(ts - t0) / (t1 - t0)` relative to analysis window
- Events outside window are hidden
- Legend updates to show active events

## How to Test

### 1. Basic Timeline Display

1. Load extension and open a YouTube cricket video
2. Add `&fan_drs=1` to URL to force enable
3. Click "Fan DRS Review" button
4. Click "Analyze" button
5. **Expected**: Timeline bar shows in Replay panel (empty if no events)

### 2. Test Bail-Off Auto-Detection Timeline

1. After clicking "Analyze", check console for:
   ```
   [Fan DRS] Auto-detected bail-off at X.XXs
   ```
2. **Expected**:
   - Red marker appears on timeline at detected position
   - Tooltip shows "Bail-off (auto XX%)" with timestamp
   - Legend shows "Events: Bail-off (auto XX%)"

### 3. Test Manual Bail-Off Selection Timeline

1. Go to "Challenge" tab
2. Click "Pick frame" button
3. Select any frame from grid
4. **Expected**:
   - Red marker appears on timeline
   - Tooltip shows "Bail-off (manual)" with timestamp
   - Legend updates to show event

### 4. Test Timeline Seeking

1. With bail-off marker visible on timeline
2. Click the red marker
3. **Expected**:
   - Console shows: `[Fan DRS] Timeline marker clicked: ...`
   - Console shows: `[Fan DRS] Seeked to X.XXs`
   - YouTube player jumps to that timestamp
   - Marker highlights with glow effect

### 5. Test Clear & Reset

**Clear bail-off:**
1. In Challenge tab, click "Clear selection"
2. **Expected**: Red marker disappears from timeline

**Reset analysis:**
1. Click "Reset" button in Replay tab
2. **Expected**: Timeline clears completely, legend shows "No events yet."

### 6. Test with Multiple Events (Future)

To test multiple markers, uncomment the placeholder code in `addPlaceholderEvents()`:

```javascript
// In sidebar.js, find addPlaceholderEvents() and uncomment the examples
// Then call it after analysis: addPlaceholderEvents();
```

**Expected**: 
- Yellow marker at ~20% (bounce)
- Orange marker at ~55% (impact)  
- Red marker at detected position (bail-off)
- All clickable and seekable

## Visual Indicators

### Timeline States

**Empty State:**
```
┌─────────────────────────────────────┐
│                                     │ (empty bar)
└─────────────────────────────────────┘
Click markers to seek. No events yet.
```

**With Bail-Off Marker:**
```
┌─────────────────────────────────────┐
│                      |              │ (red marker at ~65%)
└─────────────────────────────────────┘
Click markers to seek. Events: Bail-off (auto 78%)
```

**With Multiple Events (Future):**
```
┌─────────────────────────────────────┐
│      │           │         |        │
│    yellow     orange      red       │
└─────────────────────────────────────┘
Events: Ball bounce, Impact, Bail-off
```

### Marker Interactions

**Default:** 4px wide, 20px tall, colored by type
**Hover:** Scales to ~6px wide, 26px tall, brightens
**Selected:** 26px tall, glowing shadow effect

## Console Debugging

Open browser console (F12) to see:

```javascript
// When auto-detection runs
[Fan DRS] Bail-off detection result: {bailOffTs: 245.3, confidence: 0.78, ...}

// When timeline event is added
addTimelineEvent({id: "bail_off", ts: 245.3, ...})

// When marker is clicked
[Fan DRS] Timeline marker clicked: {id: "bail_off", ts: 245.3, ...}
[Fan DRS] Seeked to 245.3s
```

## Test Videos

Use these cricket videos for testing (add `&fan_drs=1`):

### Stumping Compilations (Good for Timeline Testing)
1. **MS Dhoni Stumpings**: https://www.youtube.com/watch?v=-cx9NfaUzbI&fan_drs=1
   - Multiple stumping moments across the video
   - Test timeline at different timestamps

2. **Top 10 Stumpings**: https://www.youtube.com/watch?v=B5yI-mmB62g&fan_drs=1
   - Various angles and formats
   - Test auto-detection accuracy

3. **Controversial Stumping**: https://www.youtube.com/watch?v=EulOKkMHkJ4&fan_drs=1
   - Single event to test precise seeking

### DRS Explanation Videos (Good for UI Testing)
4. **DRS Explained**: https://www.youtube.com/watch?v=_0-V568Svh4&fan_drs=1
5. **Dismissals Explained**: https://www.youtube.com/watch?v=kjZEZa9nV90&fan_drs=1

## Expected Behavior by Tab

### Replay Tab
- Timeline visible with markers
- Legend shows active events
- Clicking markers seeks video
- Updates after each analysis

### Challenge Tab  
- Manual bail-off selection adds marker
- Clear selection removes marker
- Picker shows if marker clicked (future enhancement)

### Why Tab
- Shows which events were detected vs manual
- Lists confidence for auto-detected events

## Troubleshooting

### Markers Not Showing
**Check:**
- Are keyframes captured? (`state.keyframes.t0`, `t1` must exist)
- Is event timestamp within window? (`t0 <= ts <= t1`)
- Console: Look for "Auto-detected bail-off" or "selection made"

### Seeking Not Working
**Check:**
- Console shows "Seeked to X.XXs"?
- Video element accessible (same-origin policy)
- YouTube player is ready (not loading)

### Markers in Wrong Position
**Formula:** `position = ((ts - t0) / (t1 - t0)) * 100`
**Check:**
- Window is last 12 seconds from current time
- Marker should be near end if detected recently

### Timeline Styling Issues
**CSS Classes:**
- `.timelineBar` - container (32px tall, rounded)
- `.marker` - event markers (4px wide, 20px tall)
- `.marker:hover` - scales to 1.3x height
- `.marker.selected` - 26px tall with glow

## Future Enhancements

### Phase 2
- ✅ Bail-off detection (implemented)
- 🔜 Ball bounce detection (CV)
- 🔜 Impact detection (bat/pad contact)
- 🔜 Crease line detection
- 🔜 Foot position tracking

### Timeline Features
- 🔜 Frame thumbnail preview on marker hover
- 🔜 Drag timeline to scrub video
- 🔜 Zoom in/out on timeline
- 🔜 Export timeline events to JSON
- 🔜 Import official DRS overlay timestamps

## Success Criteria

✅ Timeline renders without layout breaks
✅ Markers positioned correctly relative to analysis window
✅ Click seeks to exact timestamp in YouTube player
✅ Hover tooltips show event details
✅ Manual bail-off selection creates marker
✅ Auto-detected bail-off creates marker
✅ Legend updates dynamically
✅ Reset/clear removes markers properly
✅ Multiple events render without overlap (with stacking for close events)
✅ Markers color-coded by event type

## Technical Notes

### Message Flow
```
Sidebar → Content Script (SEEK_VIDEO)
  ↓
Content Script → YouTube Video Element
  ↓
Video seeks to timestamp
```

### State Management
```javascript
state.timelineEvents = [
  {
    id: "bail_off",
    ts: 245.3,
    description: "Bail-off (auto 78%)",
    markerColor: "rgba(220,38,38,0.9)",
    evidence: { method: "auto", confidence: 0.78 }
  }
]
```

### Rendering Lifecycle
1. Analysis captures keyframes
2. Auto-detection adds bail-off event
3. `addTimelineEvent()` called
4. `renderTimeline()` creates DOM markers
5. `updateTimelineLegend()` updates text
6. User clicks marker → seeks video
