# Multi-Dismissal Architecture

## Overview

The extension now supports **multiple dismissals per video**, allowing users to analyze different stumping/dismissal moments in compilation videos without losing previous work.

## Key Changes

### State Model

**Before (Phase 1.0):**
```javascript
state = {
  challenge: { bailOffTs, bailOffFrameId, autoDetected },  // Global per video
  timelineEvents: [],  // Global per video
}
```

**After (Phase 1.1):**
```javascript
state = {
  activeDismissal: {
    id: "videoId_t0_t1",     // Unique per window
    window: { t0, t1 },
    challenge: { bailOffTs, bailOffFrameId, autoDetected },
    timelineEvents: [],
    createdAt: ISO timestamp
  },
  dismissals: [...]  // All dismissals for current video
}
```

### Storage Model

**Before:**
- Key: `fanDRS_analysis_${videoId}`
- Value: Single analysis state (overwrites on re-analyze)

**After:**
- Key: `fanDRS_dismissals_${videoId}`
- Value: Array of all dismissals + active dismissal ID
- Each dismissal has its own challenge state and timeline events

### Dismissal ID Generation

```javascript
const dismissalId = `${videoId}_${Math.floor(t0)}_${Math.floor(t1)}`;
```

- Unique per analysis window
- Stable across re-analyses of same window
- Example: `i3tcsO277qs_34_46` (video at 34-46s)

## User Workflow

### Single Dismissal (Current Video)
1. User seeks to dismissal moment
2. Clicks Analyze → creates dismissal instance
3. Picks bail-off → updates that dismissal's challenge state
4. Timeline markers are dismissal-specific

### Multiple Dismissals (Compilation)
1. User analyzes first dismissal (0:34-0:46) → `dismissal_1`
2. Seeks to second dismissal (2:15-2:27) → `dismissal_2` created
3. Each has independent:
   - Bail-off selection
   - Timeline events
   - Confidence scores
4. Switch between dismissals (future UI feature)

## Backward Compatibility

### Helper Functions
```javascript
function getChallenge() {
  return state.activeDismissal?.challenge || { bailOffTs: null, ... };
}

function getTimelineEvents() {
  return state.activeDismissal?.timelineEvents || [];
}
```

All existing code uses these helpers → no breaking changes.

### Legacy Storage
- Old `fanDRS_bailOff_${videoId}` still loaded for migration
- Will be deprecated in Phase 2

## Implementation Details

### Auto-Create Dismissal on Analyze
```javascript
// In btnAnalyze handler:
const window = { t0, t1 };
const dismissalId = `${videoId}_${Math.floor(t0)}_${Math.floor(t1)}`;

let dismissal = state.dismissals.find(d => d.id === dismissalId);
if (!dismissal) {
  dismissal = { id: dismissalId, window, challenge: {}, timelineEvents: [], createdAt: ... };
  state.dismissals.push(dismissal);
}
state.activeDismissal = dismissal;
```

### Save All Dismissals
```javascript
async function saveAnalysisState(videoId) {
  const data = {
    dismissals: state.dismissals,
    activeDismissalId: state.activeDismissal?.id,
    lastSavedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [`fanDRS_dismissals_${videoId}`]: data });
}
```

### Load All Dismissals
```javascript
async function loadAnalysisState(videoId) {
  const result = await chrome.storage.local.get(`fanDRS_dismissals_${videoId}`);
  if (result?.dismissals) {
    state.dismissals = result.dismissals;
    state.activeDismissal = state.dismissals.find(d => d.id === result.activeDismissalId)
                         || state.dismissals[state.dismissals.length - 1];
  }
}
```

## Future Enhancements

### Phase 2: Dismissal Selector UI
```
┌─ Dismissals (3) ─────────────┐
│ ○ 0:34 - Stumping            │ ← Click to switch
│ ● 2:15 - Stumping (active)   │
│ ○ 4:52 - Run-out             │
└───────────────────────────────┘
```

### Phase 3: Dismissal Comparison
- Side-by-side confidence comparison
- Export multiple dismissals
- Batch analysis mode

### Phase 4: Full Video Scan
- Auto-detect all dismissals in video
- Create dismissal candidates automatically
- User reviews and confirms each

## Testing Checklist

- [x] Single dismissal works (backward compat)
- [x] Multiple dismissals created per video
- [x] Each dismissal has independent challenge state
- [x] Each dismissal has independent timeline
- [x] Storage persists all dismissals
- [x] Load restores most recent dismissal as active
- [ ] UI shows dismissal count (future)
- [ ] UI allows switching dismissals (future)

## Migration Notes

### For Users
- Existing single-dismissal data still works
- New analyses create separate dismissal instances
- No data loss on upgrade

### For Developers
- Replace `state.challenge` → `getChallenge()`
- Replace `state.timelineEvents` → `getTimelineEvents()`
- All timeline/challenge mutations check `state.activeDismissal`
- Use `saveAnalysisState()` after any dismissal modification

## Performance Considerations

- Each dismissal stores ~60 keyframe references (not actual JPEGs)
- Storage limit: ~100 dismissals per video before cleanup needed
- UI pagination recommended at 10+ dismissals

## Security & Privacy

- All data stored locally (chrome.storage.local)
- No server communication
- Each video's dismissals isolated by videoId
- Clear data: Delete `fanDRS_dismissals_*` keys
