# Fan DRS Review · Review foundation spec (v3)

Status: implemented on branch `review-foundation` (A1 + this spec); revised in 0.3.1 after independent review (`docs/receipts/BC-review.md`) and in 0.3.2 after the PR #18 review (`docs/receipts/PR18-review.md`): **the beta never decides OUT or NOT OUT.** Supersedes the slice B/C sections of `fan-drs-modernization-spec.v2.md`. Slice A1 stays as specified there.

## 1. The problem

A fan watching a close stumping on YouTube has one question: *was that out?* Today they get two bad answers. The broadcast replay shows the moment but not the reasoning, and tools that print OUT or NOT OUT with a confident percentage are guessing from blurry, compressed frames.

The first live test of 0.2.0 (Chrome on macOS, Cricbuzz "Best Fails of DRS", 2026-11-21) showed the capture layer works on real YouTube: 90 frames buffered, 45 collected, 100% coverage, frames readable. It also showed the workflow was the problem. You had to open a panel, choose a window and press Analyze, and the window label drifted while the result stayed put. Nobody does that mid-match.

## 2. The answer, in three parts

| Part | What it does | Why |
|---|---|---|
| **Always ready** | Capture starts by itself on videos that are clearly cricket, with a one-click override on any video. | A question can only be answered from footage that was already captured. |
| **One action to review** | Press **Review** (chip, `Alt+Shift+R`, or seek back and pause). The card opens already analyzed around that moment. | Replaying the moment is the natural gesture; the tool follows it. |
| **Evidence, not a verdict** | Detectors propose a *candidate* bail-off interval and a crease line. Nothing a detector proposes counts until the viewer confirms it. The finding is always Inconclusive in the beta; it lists what's been observed, what's still open, and what frames can't establish. | A stumping depends on facts a frame strip can't give. Showing the evidence honestly is worth more than a call that looks certain. |

Every review also produces an **evidence packet**: a small JSON record of what was seen. It is the foundation for "ask the video": a future assistant answers from the packet, not from guesses about pixels.

## 3. The viewer's journey

1. **Watching.** On a cricket video, a chip beside the like button reads **● DRS ready**. On other videos it reads **DRS off**; one click turns capture on for that video, and the card can remember the choice for the channel.
2. **Something close happens.** The viewer seeks back a few seconds and pauses, or presses the chip, or presses `Alt+Shift+R`.
3. **The card opens, already working.** It shows the 12 seconds before that moment as a frame strip, the detected bail-off interval highlighted, and the frame just before the wicket broke enlarged.
4. **They check the evidence.** The detector's bail-off pair is a *candidate*. The viewer confirms both frames with one click, or marks their own. They can set the crease with two clicks and answer one question: *in the bail-on and bail-off frames, was bat or body grounded behind the crease?*
5. **The finding.** Always Inconclusive in the beta, with three lists: what's been observed, what's still open, and what these frames can't establish. **Copy evidence** puts the packet on the clipboard for a bot, a teammate or a bug report.

## 4. Behaviour

### 4.1 Capture policy

Capture runs on a `/watch` page when the decision is **on**:

| Order | Rule | Decision |
|---|---|---|
| 1 | The viewer toggled capture for this video | their choice |
| 2 | A saved preference exists for the channel | that preference |
| 3 | Title, channel or description looks like cricket | on |
| 4 | Otherwise | off |

Cricket detection scores the title, channel and the first 500 characters of the description, and errs toward off: a missed cricket video costs one click, while a false positive costs capture on a video that isn't cricket.
- **Definite** terms only mean cricket (*stumping, stumped, LBW, IPL, BBL, T20, wicketkeeper, third umpire, Test match, Cricbuzz, ESPNcricinfo, BCCI*). One in the title or channel is enough, and so is an IPL franchise fixture (*KKR vs MI*).
- **Ambiguous** terms also mean other things (*cricket* the phone carrier, *Ashes of Creation*, *DRS* in F1, *ICC* colour profiles, *PSL* the console, *run out* of time, *ODI*). Two distinct signals are needed. A national fixture (*Ind v Aus*) and *Test* with *Day N* each count as one. An ambiguous word only in the channel name counts as half.
- Words and digits are split, so *#IPL2025* matches *IPL*. The cases are a table in `test/review.test.js`.

Limits are unchanged from A1: 90 frames, 8 MiB, ads never captured, no network. Frames are now 480 px wide, up from 320, to give the detectors more pixels. Measured in the smoke test, the ring stays under the byte cap.

Channel preferences live in `chrome.storage.local` under `channelPrefs` as `{ "<channel name>": "on" | "off" }`. Nothing else is stored.

### 4.2 Review triggers

- Clicking the chip (when capture is off, the chip turns it on first and says so).
- `Alt+Shift+R` (a Chrome extension command; can be changed in `chrome://extensions/shortcuts`).
- **Replay pause:** a pause within 15 s after a backward seek of at least 2 s while capture is on and the card is closed. Ordinary pauses don't open anything, and the gesture never replaces a review the viewer is looking at.
- **Review again** in the card (trigger `card`), which turns capture on if needed.

The review window is the 12 s ending at the playback time when review was triggered. For a replay pause it ends at the later of the pause time and the position the viewer seeked back from, so pausing just before the incident still covers it. The card states that window and never updates it under a finished result. Reviewing again replaces it.

### 4.3 The card

One screen, no tabs:

- **Header:** capture state with the override toggle, a channel "remember" option, close.
- **Strip:** thumbnails of the window's frames (up to 48), keyboard and pointer selectable. The last-bail-on and first-bail-off frames are marked, and so are frames after a camera cut. (Capture gaps are reported in the packet, not drawn.)
- **Stage:** the selected frame enlarged, with the crease line overlaid when known. Click two points to set the crease.
- **Grounding question:** about both bracket frames: *Behind in both* / *Not behind in both* / *They differ, or can't see*. The detector's suggestion is shown as text and never preselected. Changing the bracket or the crease clears the answer, because it referred to other frames or another line.
- **Bracket:** a detector bracket is labelled *Candidate* everywhere (text, strip, stage) until the viewer presses **Confirm both frames** or marks frames themselves.
- **Finding:** always *Inconclusive*, with *What's been observed*, *Still open* and *Not established by these frames*. **Copy evidence** and **Review again**.

### 4.4 Detectors

All detectors are pure functions over grayscale pixel arrays (`{ width, height, data: Uint8ClampedArray }`), so they run in Node unit tests with synthetic frames. Decoding happens in the sidebar.

| Detector | Method | Abstains when |
|---|---|---|
| **Shot cut** | Whole-frame mean absolute difference against a robust baseline (median + k·MAD). | n/a; marks cut indices |
| **Stumps ROI** | Column-wise vertical edge energy; three near-equal-spaced strong columns. | Fewer than three columns, or spacing inconsistent |
| **Bail-off** | Local change in the region just above the stumps: brightness-normalised difference, minus twice the change in a same-size reference strip beside the stumps (so exposure steps, flicker and camera jerks cancel). The largest spike above median + k·MAD, not on a cut, that stays different from a baseline a few frames earlier. Ported from phase1 `bail_detection.js` (frame-diff, MAD spike, cut rejection). | No spike, a spike on a cut, a change that returns to baseline (a passing glove), or two similar spikes. Known gap: a glove that stays over the bails can't be told from bails coming off; the viewer sees both frames. |
| **Crease** | Strongest straight bright line in the whole frame, excluding the stumps, over angles −80°…80° from vertical. That covers side-on views; an end-on view's near-horizontal crease isn't searched. | Peak not clearly above the runner-up. Scoreboards and return creases can win; the viewer can set the line. |
| **Grounding hint** | Non-turf mass (pixels far from the grayscale median of the lower frame, an idea from phase1 `foot_detection.js`) on each side of the crease line, low in the frame near the line. | Always a *hint*, capped at 0.6; never preselected, never decides the call |

### 4.5 Finding (no verdict in the beta)

```
bracket    = last frame with bail on, first frame with bail off
candidate  = proposed by the detector; supports nothing until the viewer confirms both frames
confirmed  = marked by the viewer, or a candidate the viewer confirmed
valid      = both frames exist, same shot (no cut between), gap ≤ 400 ms
crease     = located (detected, or set by the viewer)
grounded   = the viewer's answer about BOTH bracket frames (the hint never decides)

finding    = INCONCLUSIVE, always
observed   = a confirmed valid bracket; the crease (saying whether the viewer set it); the viewer's grounding answer
open       = every missing or unconfirmed piece (NO_BRACKET, UNCONFIRMED_BRACKET, BRACKET_*, CUT_IN_BRACKET, NO_CREASE, GROUNDING_*)
not established, always:
  - a legal delivery (no-ball can't be ruled out)
  - a fair break by the keeper, with the ball, with no other fielder involved
  - whether a run was attempted (run out, not stumped)
  - grounding at the instant the wicket broke, between the two sampled frames
```

**Why there's no OUT / NOT OUT.** A stumping (MCC Laws 29, 30, 39) needs all of the above, and capture samples about every 250 ms, so the actual instant is never seen. A detector bracket is pixel change near the bails, which a keeper's glove that stays over them reproduces (a regression test covers this). A future decision mode needs evidence for each "not established" item, not more confidence in the pixels.

## 5. Evidence packet (`fan-drs.evidence/1`)

```json
{
  "schema": "fan-drs.evidence/1",
  "generatedAt": "2026-11-21T20:40:00.000Z",
  "video": { "id": "vyfLCDq79iE", "title": "…", "channel": "…" },
  "window": { "t0": 64.44, "t1": 76.44, "trigger": "chip" },
  "capture": { "frames": 45, "coverage": 1, "gaps": [] },
  "frames": [{ "id": 12, "t": 64.51 }],
  "bracket": { "lastOn": { "id": 30, "t": 71.02 }, "firstOff": { "id": 31, "t": 71.27 }, "gapMs": 250, "sameShot": true, "source": "detector", "confidence": 0.86, "confirmed": true },
  "crease": { "line": { "x1": 0.41, "y1": 0.55, "x2": 0.47, "y2": 0.98 }, "source": "viewer" },
  "grounded": { "value": "unknown", "source": "none", "frames": [30, 31], "hint": { "value": "behind", "confidence": 0.42 } },
  "finding": { "call": "INCONCLUSIVE", "observations": ["…"], "open": ["GROUNDING_UNKNOWN"], "notEstablished": ["…"] }
}
```

Coordinates are normalized to the frame (0–1). `grounded.frames` lists the frame IDs the answer covers. `bracket.confirmed` is false for an unconfirmed detector candidate. `finding.call` is always `INCONCLUSIVE` in the beta; `finding.open` holds stable codes. `video` is the identity of the video the frames came from, captured with the frames. Images are never included. The packet is produced only on Review and only leaves the tab when the viewer presses Copy.

## 6. Out of scope

The assistant itself (network, API keys, consent). LBW and run-out. Reading the broadcast DRS graphic. Ball tracking. Uploads or accounts.

## 7. Verification

- Unit tests for every pure function: cricket scoring, capture policy, cut, stumps, bail-off, crease, grounding hint, verdict rule, packet builder.
- Browser smoke on a synthetic stumping clip (ffmpeg-drawn stumps, bail and batter) served at a youtube.com URL. It asserts auto-capture on, the chip, review by chip, by shortcut command and by replay pause, the detected bracket matching the clip's scripted bail-off time, crease set by clicks, verdict transitions, and packet contents.
- A live check on real YouTube by the maintainer, recorded in the receipt.
- An independent review by a separate agent, labelled as such. A human review is still required before release.

## 8. What this unlocks

Once every review leaves a structured record of what was seen, three things become cheap. An assistant can answer "was that out?" with the frames to back it. Detectors can be measured against viewer corrections. And the same card can take LBW and run-out without another redesign.
