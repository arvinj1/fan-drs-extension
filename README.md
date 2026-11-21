# Fan DRS Review

A Chrome extension (Manifest V3) for reviewing cricket replays on YouTube. Open a video, open the panel, replay the moment, and see which frames were actually captured for the window you chose.

**This version reports evidence only.** It shows coverage and gaps for a window. It doesn't decide OUT or NOT OUT, and it doesn't read the broadcast DRS graphic.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Open a YouTube `/watch` page and click **Fan DRS Review** under the player.

## How it works

- Frames are captured only while the panel is open: about 4 per second at 320 px wide, up to 90 frames and 8 MiB per tab. Nothing is captured while the panel is closed.
- **Last 12s** reviews the 12 seconds before the current playback time. **Mark start** and **Mark end** use the player time at the moment you click. Windows can be at most 30 seconds.
- If the window starts before capture began, the timeline shows the gap. Replay that part with the panel open to fill it. Analyze never seeks the video.
- Frames are tied to one video. Opening another video, or a source change on the same player, clears them. Ads are never captured.

## Privacy

Everything runs in the YouTube tab. The extension makes no network requests, uploads nothing, and stores no frames. It has access only to `https://www.youtube.com/*`.

## Develop and verify

Requires Node 20+. No runtime dependencies.

```sh
npm install          # dev tooling only (playwright-core for the browser smoke test)
npm run verify       # static checks + unit tests
CHROME_PATH=/path/to/chrome npm run smoke   # browser smoke test on a local fixture page
```

`npm run smoke` needs Chrome for Testing or Chromium (branded Google Chrome ignores `--load-extension`). It serves `test/browser/fixtures/watch.html` at a youtube.com URL through request routing, so the production manifest runs unchanged. The clip is a synthetic ffmpeg `testsrc2` pattern generated for this repository. Screenshots and `results.json` go to `test/browser/out/`.

The fixture is not YouTube. Before a release, also smoke test by hand on a real public replay and record the Chrome version, OS, clip and results.

## Layout

| Path | Role |
|---|---|
| `extension/src/shared/core.js` | Pure logic: frame ring, capture session, windows, coverage, bridge protocol. Unit tested. |
| `extension/src/content/content_script.js` | Page integration: button, panel, player binding, SPA navigation, bridge host. |
| `extension/src/sidebar/` | Panel UI (extension page in an iframe). |
| `test/core.test.js` | Unit tests (`node --test`). |
| `test/browser/` | Chromium smoke test and fixtures. |
| `scripts/check.js` | Syntax, manifest reference, icon size and permission checks. |

## Known limitations

- Toolbar icons are 1×1 placeholders (`npm run check` reports them as known).
- Feedback buttons don't save anything.
- Challenge mode, the DRS card and automatic decisions are not implemented yet.
