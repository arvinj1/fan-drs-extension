# Fan DRS Review

A Chrome extension (Manifest V3) for reviewing close cricket dismissals on YouTube. It keeps the last few seconds of a cricket video ready, and when you review a moment it shows what the frames can prove: when the wicket broke, where the crease is, and whether that settles the call.

**It is evidence, not an official decision.** OUT or NOT OUT appears only when the moment the wicket broke is pinned down to two frames in the same shot, and you've confirmed whether bat or body was grounded behind the crease. Otherwise the result is Inconclusive, with the missing evidence named. The design is in [`docs/SPEC.md`](docs/SPEC.md).

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Open a YouTube cricket video. A chip appears next to the like button.

## Use

- **● DRS ready** means capture is running (cricket was detected, or you turned it on). **DRS off** means it isn't; clicking it turns capture on for that video.
- **Review a moment** in any of three ways: click the chip, press **Alt+Shift+R** (change it in `chrome://extensions/shortcuts`), or seek back a few seconds and pause. The card opens on the 12 seconds before that point, already analyzed.
- **Check, don't operate.** The card marks the last frame with the bail on and the first with it off, and draws the crease if it found one. Correct either if needed: select a frame and mark it, or click two points on the crease. Then answer one question: was bat or body grounded behind the crease at that moment?
- **Copy evidence** puts a JSON record of the review (`fan-drs.evidence/1`, no images) on the clipboard, ready for a chat, a teammate or a bug report.
- **Remember for this channel** keeps capture on or off for every video from that channel.

## Privacy and cost

- Capture runs only on videos detected as cricket, or where you turned it on: about 4 frames per second at 480 px, at most 90 frames and 8 MiB per tab. Ads are never captured.
- Frames stay in the tab. The extension makes no network requests and uploads nothing.
- It stores only your per-channel on/off choices (`chrome.storage.local`), and has access only to `https://www.youtube.com/*`.

## Develop and verify

Requires Node 20+. No runtime dependencies.

```sh
npm install          # dev tooling only (playwright-core for the browser smoke test)
npm run verify       # static checks + unit tests
CHROME_PATH=/path/to/chrome npm run smoke   # browser smoke test on local fixture pages
```

`npm run smoke` needs Chrome for Testing or Chromium (branded Google Chrome ignores `--load-extension`). It serves `test/browser/fixtures/watch.html` at youtube.com URLs through request routing, so the production manifest runs unchanged. The clips are synthetic and generated with ffmpeg: a test pattern, and a side-on stumping where the bail comes off at exactly 6.0 s (see the comment in `watch.html`). Screenshots and `results.json` go to `test/browser/out/`.

The fixtures are not YouTube. Before a release, also test by hand on a real public replay, and record the Chrome version, OS, clip and results in `docs/receipts/`.

## Layout

| Path | Role |
|---|---|
| `extension/src/shared/core.js` | Frame ring, capture session, windows, coverage, bridge protocol. |
| `extension/src/shared/review.js` | Cricket detection, capture policy, replay gesture, bracket check, verdict rule, evidence packet. |
| `extension/src/shared/vision.js` | Detectors on grayscale frames: cuts, stumps, bail-off, crease, grounding hint. |
| `extension/src/content/content_script.js` | Page integration: chip, capture policy, review triggers, card mounting, bridge host. |
| `extension/src/sidebar/` | The review card (an extension page in an iframe). |
| `extension/src/background/service_worker.js` | The Alt+Shift+R command. |
| `test/*.test.js` | Unit tests (`node --test`). |
| `test/browser/` | Chromium smoke test and fixtures. |
| `scripts/check.js` | Syntax, manifest reference, icon size and permission checks. |

## Known limitations

- Detectors are heuristics. They are built for a clear side-on view and abstain often on real broadcasts. Every result can be corrected in the card.
- No LBW, run-out, ball tracking or reading of the broadcast DRS graphic.
- Toolbar icons are 1×1 placeholders (`npm run check` reports them as known).
