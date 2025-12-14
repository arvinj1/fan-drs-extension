# Fan DRS — Phase 1–3 GitHub Issues (Feature Template Aligned)

> Copy one issue at a time into GitHub → New Issue → Feature.

## PHASE 1 — Chrome Extension Core

### Issue 1 — Inject “Fan DRS Review” button on YouTube watch pages  
**Labels:** `phase-1`, `frontend`, `good-first-issue`

## Goal
Expose a clear entry point for Fan DRS on YouTube cricket videos.

## User experience
When viewing a YouTube `/watch` page, a **“Fan DRS Review”** button appears near Like / Share actions and feels native.

## Technical approach
- Content script detects `/watch` pages
- Observe SPA navigation changes
- Inject button once (defensive selectors)

## Acceptance criteria
- [ ] Button appears on `/watch`
- [ ] No duplicates on navigation
- [ ] Doesn’t break layout

## Notes
Prefer mutation observers over load events.

---

### Issue 2 — Sidebar injection and open/close behavior  
**Labels:** `phase-1`, `frontend`, `ux`

## Goal
Provide an in-page analysis panel without redirecting users.

## User experience
Clicking the button slides in a sidebar; a small handle remains visible when closed.

## Technical approach
- Fixed-position host div
- Sidebar as iframe (web_accessible_resource)
- Maintain open/close state

## Acceptance criteria
- [ ] Sidebar opens/closes smoothly
- [ ] Close button works
- [ ] Handle appears when closed

## Notes
Use CSS transforms to avoid jank.

---

### Issue 3 — Read YouTube playback context  
**Labels:** `phase-1`, `frontend`

## Goal
Understand what the user is watching and where the dismissal occurs.

## User experience
Sidebar shows title, channel, and time (current/duration).

## Technical approach
- Read `<video>` state
- Extract `videoId` from URL
- Handle seek/pause/play

## Acceptance criteria
- [ ] Timestamp updates correctly
- [ ] Works after navigation
- [ ] Handles seek and pause

## Notes
Re-query the `<video>` element defensively.

---

### Issue 4 — Dismissal window selection  
**Labels:** `phase-1`, `frontend`, `ux`

## Goal
Define the time window to analyze.

## User experience
Defaults to last 12 seconds; user can mark start/end (later).

## Technical approach
- Store window state in sidebar
- Compute t0/t1 relative to playback time

## Acceptance criteria
- [ ] Last-12s works by default
- [ ] UI reflects chosen window
- [ ] Clear feedback

## Notes
Keep MVP simple; no complex scrubbing yet.

---

### Issue 5 — Client-side keyframe capture via Canvas  
**Labels:** `phase-1`, `frontend`, `cv`

## Goal
Extract analysis frames without downloading the video file.

## User experience
Invisible; runs on Analyze and returns quickly.

## Technical approach
- Rolling ring-buffer of thumbnails (last ~20s) while sidebar open
- Capture every ~250ms using `requestVideoFrameCallback` (fallback interval)
- Return frames in [t0,t1] with timestamps

## Acceptance criteria
- [ ] Reliable frame capture
- [ ] No disruptive seeking
- [ ] Bounded memory (max frames)

## Notes
Ring buffer is key to good UX.

---

### Issue 6 — Heuristic detection of official DRS overlay  
**Labels:** `phase-1`, `frontend`, `cv`

## Goal
Detect when broadcast DRS graphics are likely present.

## User experience
“Checking for official DRS…” appears during analysis.

## Technical approach
- Cheap layout/color heuristics on keyframes
- Return likelihood score

## Acceptance criteria
- [ ] Boolean + confidence output
- [ ] Low false positives preferred
- [ ] No heavy ML

## Notes
This gates Phase 3 OCR work.

---

### Issue 7 — Local analysis pipeline wiring (stubs)  
**Labels:** `phase-1`, `frontend`

## Goal
Create a clean interface for plugging in analyzers.

## User experience
Analyze runs end-to-end (stub output OK).

## Technical approach
- Define analyzer input/output schema
- Wire sidebar → content script (frames) → analyzer
- Keep outputs UI-friendly (verdict/confidence/evidence)

## Acceptance criteria
- [ ] Single analysis entry point
- [ ] Easy to swap stub for real logic
- [ ] UI handles Loading/Done/Error

## Notes
Avoid baking model assumptions into UI.

---

## PHASE 2 — Stumping Analyzer

### Issue 8 — Detect batting crease line (auto)  
**Labels:** `phase-2`, `cv`

## Goal
Identify the popping crease reliably.

## User experience
Crease line highlighted on replay.

## Technical approach
Edge detection + line fitting + stability scoring.

## Acceptance criteria
- [ ] Crease polyline returned
- [ ] Stability score included
- [ ] Graceful failure

## Notes
Manual override comes via Challenge Mode.

---

### Issue 9 — Detect stumps and bail-off frame  
**Labels:** `phase-2`, `cv`

## Goal
Find the moment wicket is broken.

## User experience
Replay freezes at bail-off.

## Technical approach
Detect sudden change near stumps top; support slow-motion.

## Acceptance criteria
- [ ] Bail-off timestamp correct
- [ ] Confidence score returned

## Notes
First bail detachment matters.

---

### Issue 10 — Foot segmentation near crease  
**Labels:** `phase-2`, `cv`

## Goal
Determine if foot is grounded behind crease at bail-off.

## User experience
Foot outline shown relative to crease.

## Technical approach
Segmentation/contours + grounded test + margin distance.

## Acceptance criteria
- [ ] Foot mask/outline produced
- [ ] Grounded boolean + margin returned
- [ ] Conservative on blur

## Notes
Prefer INCONCLUSIVE over guesses.

---

### Issue 11 — Stumping verdict logic and confidence  
**Labels:** `phase-2`, `cv`

## Goal
Produce defensible OUT/NOT OUT/INCONCLUSIVE.

## User experience
Verdict + confidence label.

## Technical approach
Combine crease + bail + foot signals with conservative thresholds.

## Acceptance criteria
- [ ] No overconfident close calls
- [ ] Confidence reflects evidence quality
- [ ] INCONCLUSIVE on ambiguity

## Notes
Sets trust model for the product.

---

### Issue 12 — Render stumping overlays  
**Labels:** `phase-2`, `frontend`, `ux`

## Goal
Make the decision visually obvious.

## User experience
Crease + foot overlay on freeze-frame at bail-off.

## Technical approach
Overlay rendering synced to timestamps.

## Acceptance criteria
- [ ] Clear overlays
- [ ] Not cluttered
- [ ] Doesn’t obscure evidence

## Notes
Overlay style should be consistent across features.

---

### Issue 13 — Challenge Mode: manual bail-off picker  
**Labels:** `phase-2`, `frontend`, `ux`

## Goal
Let users refine the analysis.

## User experience
User selects exact bail-off frame; confidence boosts.

## Technical approach
Frame scrubber selection → rerun verdict.

## Acceptance criteria
- [ ] Easy to use
- [ ] Confidence increases when used
- [ ] Rerun is fast

## Notes
This also produces high-quality labels.

---

## PHASE 3 — Official DRS Extraction

### Issue 14 — Detect broadcast DRS panels  
**Labels:** `phase-3`, `cv`

## Goal
Recognize official DRS graphics layouts.

## User experience
Badge appears: OFFICIAL DRS FOUND.

## Technical approach
Template matching + ROI scanning on keyframes.

## Acceptance criteria
- [ ] Works across broadcasters (best-effort)
- [ ] Detection confidence returned

## Notes
Prefer precision over recall.

---

### Issue 15 — OCR Pitching/Impact/Wickets text  
**Labels:** `phase-3`, `cv`

## Goal
Extract official DRS fields from the panel.

## User experience
DRS Card auto-fills with official results.

## Technical approach
OCR on detected panel regions; normalize labels.

## Acceptance criteria
- [ ] Correct text extraction
- [ ] OCR confidence returned
- [ ] Raw OCR retained for debugging

## Notes
OCR errors must reduce confidence, not flip verdicts.

---

### Issue 16 — Show Official DRS badge and card  
**Labels:** `phase-3`, `frontend`, `ux`

## Goal
Surface official decisions clearly.

## User experience
Official DRS is shown before Fan DRS analysis when present.

## Technical approach
Badge + populate DRS Card fields.

## Acceptance criteria
- [ ] Clear visual priority
- [ ] Trust-building language

## Notes
Never bury official decisions.

---

### Issue 17 — Reconcile Official DRS vs Fan DRS  
**Labels:** `phase-3`, `cv`

## Goal
Explain agreement/mismatch honestly.

## User experience
Clear “why” bullets if mismatch happens.

## Technical approach
Compare outputs; attach reasons and uncertainty.

## Acceptance criteria
- [ ] No unexplained contradictions
- [ ] Default to trusting official DRS
- [ ] INCONCLUSIVE if evidence weak

## Notes
Transparency > bravado.

