# Fan DRS Review · Review foundation spec (v3)

Status: implemented on branch `review-foundation` (A1 + this spec). Supersedes the slice B/C sections of `fan-drs-modernization-spec.v2.md`. Slice A1 stays as specified there.

## 1. The problem

A fan watching a close stumping on YouTube has one question: *was that out?* Today they get two bad answers. The broadcast replay shows the moment but not the reasoning, and tools that print OUT or NOT OUT with a confident percentage are guessing from blurry, compressed frames.

The first live test of 0.2.0 (Chrome on macOS, Cricbuzz "Best Fails of DRS", 2026-11-21) showed the capture layer works on real YouTube: 90 frames buffered, 45 collected, 100% coverage, frames readable. It also showed the workflow was the problem. You had to open a panel, choose a window and press Analyze, and the window label drifted while the result stayed put. Nobody does that mid-match.

## 2. The answer, in three parts

| Part | What it does | Why |
|---|---|---|
| **Always ready** | Capture starts by itself on cricket videos, with a one-click override on any video. | A question can only be answered from footage that was already captured. |
| **One action to review** | Press **Review** (chip, `Alt+Shift+R`, or seek back and pause). The card opens already analyzed around that moment. | Replaying the moment is the natural gesture; the tool follows it. |
| **Evidence, then a verdict** | Detectors propose the bail-off interval and crease, and suggest grounding. A verdict appears only when the interval is clear and the viewer has confirmed grounding with one tap; otherwise Inconclusive with the missing piece named. | A call that is rarely wrong is worth more than a call that is always present. |

Every review also produces an **evidence packet**: a small JSON record of what was seen. It is the foundation for "ask the video": a future assistant answers from the packet, not from guesses about pixels.

## 3. The viewer's journey

1. **Watching.** On a cricket video, a chip beside the like button reads **● DRS ready**. On other videos it reads **DRS off**; one click turns capture on for that video, and the card can remember the choice for the channel.
2. **Something close happens.** The viewer seeks back a few seconds and pauses, or presses the chip, or presses `Alt+Shift+R`.
3. **The card opens, already working.** It shows the 12 seconds before that moment as a frame strip, the detected bail-off interval highlighted, and the frame just before the wicket broke enlarged.
4. **They check, not operate.** If the detector got it right there is nothing to do. If not, they pick the bail-off frame, set the crease with two clicks, or answer one question: *at the moment the wicket broke, was bat or body grounded behind the crease?*
5. **The finding.** OUT, NOT OUT or INCONCLUSIVE, with the reasons and the assumptions it rests on. **Copy evidence** puts the packet on the clipboard for a bot, a teammate or a bug report.

## 4. Behaviour

### 4.1 Capture policy

Capture runs on a `/watch` page when the decision is **on**:

| Order | Rule | Decision |
|---|---|---|
| 1 | The viewer toggled capture for this video | their choice |
| 2 | A saved preference exists for the channel | that preference |
| 3 | Title, channel or description looks like cricket | on |
| 4 | Otherwise | off |

Cricket detection is a keyword score over title, channel and the first 500 characters of the description (for example *cricket, wicket, stumping, stumped, DRS, LBW, Test, ODI, T20, IPL, BBL, PSL, Ashes, run out*). Title matches count more than description matches. Generic words alone (*Test*, *ODI*) need a second signal. It errs toward off: a missed cricket video costs one click, while a false positive costs CPU on a non-cricket video.

Limits are unchanged from A1: 90 frames, 8 MiB, ads never captured, no network. Frames are now 480 px wide, up from 320, to give the detectors more pixels. Measured in the smoke test, the ring stays under the byte cap.

Channel preferences live in `chrome.storage.local` under `channelPrefs` as `{ "<channel name>": "on" | "off" }`. Nothing else is stored.

### 4.2 Review triggers

- Clicking the chip (when capture is off, the chip turns it on first and says so).
- `Alt+Shift+R` (a Chrome extension command; can be changed in `chrome://extensions/shortcuts`).
- **Replay pause:** a pause within 15 s after a backward seek of at least 2 s while capture is on. Ordinary pauses don't open anything.

The review window is the 12 s ending at the playback time when review was triggered. The card states that window and never updates it under a finished result. Reviewing again replaces it.

### 4.3 The card

One screen, no tabs:

- **Header:** capture state with the override toggle, a channel "remember" option, close.
- **Strip:** thumbnails of the window's frames (up to 48), keyboard and pointer selectable. The last-bail-on and first-bail-off frames are marked; gaps are drawn.
- **Stage:** the selected frame enlarged, with the crease line overlaid when known. Click two points to set the crease.
- **Grounding question:** Behind / Not behind / Can't see, preset from the detector's suggestion when it has one.
- **Finding:** the call, reasons and assumptions. **Copy evidence** and **Review again**.

### 4.4 Detectors

All detectors are pure functions over grayscale pixel arrays (`{ width, height, data: Uint8ClampedArray }`), so they run in Node unit tests with synthetic frames. Decoding happens in the sidebar.

| Detector | Method | Abstains when |
|---|---|---|
| **Shot cut** | Whole-frame mean absolute difference against a robust baseline (median + k·MAD). | n/a; marks cut indices |
| **Stumps ROI** | Column-wise vertical edge energy; three near-equal-spaced strong columns. | Fewer than three columns, or spacing inconsistent |
| **Bail-off** | Per-pair change inside the region just above the stumps; the largest spike above median + k·MAD, not on a cut, followed by sustained change. Ported from phase1 `bail_detection.js` (frame-diff, MAD spike, cut rejection). | No spike, spike on a cut, or the two largest spikes are close in score |
| **Crease** | Strongest straight edge line through the stumps' foot region (gradient-weighted line search over angles −80°…80° from vertical, which covers side-on and behind views). | Peak not clearly above the runner-up |
| **Grounding hint** | Foreground mass (difference from the turf colour model, an idea from phase1 `foot_detection.js`) on each side of the crease line, low in the frame near the line. | Always reported as a *hint*; never decides the call alone |

### 4.5 Verdict rule

```
bracket   = last frame with bail on, first frame with bail off
valid     = both frames exist, same shot (no cut between), gap ≤ 400 ms
grounded  = the viewer's answer (the hint only preselects it; it never decides alone)

OUT          valid ∧ grounded = not-behind
NOT OUT      valid ∧ grounded = behind
INCONCLUSIVE otherwise, with every failing condition listed
```

Assumptions are always listed: legal delivery, the wicket was put down by the keeper with the ball, and the camera shows the popping crease. These are things a frame strip can't establish. Laws referenced: MCC Laws 29 (wicket is down), 30 (batter out of ground), 39 (stumped).

## 5. Evidence packet (`fan-drs.evidence/1`)

```json
{
  "schema": "fan-drs.evidence/1",
  "generatedAt": "2026-11-21T20:40:00.000Z",
  "video": { "id": "vyfLCDq79iE", "title": "…", "channel": "…" },
  "window": { "t0": 64.44, "t1": 76.44, "trigger": "chip" },
  "capture": { "frames": 45, "coverage": 1, "gaps": [] },
  "frames": [{ "id": 12, "t": 64.51 }],
  "bracket": { "lastOn": { "id": 30, "t": 71.02 }, "firstOff": { "id": 31, "t": 71.27 }, "gapMs": 250, "sameShot": true, "source": "detector", "confidence": 0.86 },
  "crease": { "line": { "x1": 0.41, "y1": 0.55, "x2": 0.47, "y2": 0.98 }, "source": "viewer" },
  "grounded": { "value": "unknown", "source": "none", "hint": { "value": "behind", "confidence": 0.42 } },
  "verdict": { "call": "INCONCLUSIVE", "reasons": ["…"], "assumptions": ["…"] }
}
```

Coordinates are normalized to the frame (0–1). Images are never included. The packet is produced only on Review and only leaves the tab when the viewer presses Copy.

## 6. Out of scope

The assistant itself (network, API keys, consent). LBW and run-out. Reading the broadcast DRS graphic. Ball tracking. Uploads or accounts.

## 7. Verification

- Unit tests for every pure function: cricket scoring, capture policy, cut, stumps, bail-off, crease, grounding hint, verdict rule, packet builder.
- Browser smoke on a synthetic stumping clip (ffmpeg-drawn stumps, bail and batter) served at a youtube.com URL. It asserts auto-capture on, the chip, review by chip, by shortcut command and by replay pause, the detected bracket matching the clip's scripted bail-off time, crease set by clicks, verdict transitions, and packet contents.
- A live check on real YouTube by the maintainer, recorded in the receipt.
- An independent review by a separate agent, labelled as such. A human review is still required before release.

## 8. What this unlocks

Once every review leaves a structured record of what was seen, three things become cheap. An assistant can answer "was that out?" with the frames to back it. Detectors can be measured against viewer corrections. And the same card can take LBW and run-out without another redesign.
