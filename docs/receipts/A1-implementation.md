# Receipt · A1 implementation

| Field | Value |
|---|---|
| Run ID | `a1-2026-11-20` |
| Slice / issues | A1 · #1 button, #2 panel, #3 playback context, #4 window selection, #5 keyframe capture |
| Base | `main` @ `a90be83ccc76d050e94f80d4be9dcf99ece45128` (remote head checked; matches the audit, no new commits) |
| Result | branch `slice-a1-capture-bridge`: `908e391` (implementation), `0c031be` (review fixes), `d819582` (second-review nits). Receipts commit follows `d819582`. |
| Reference | `origin/phase1` @ `f33c526` read only; nothing transplanted (its timeline and detectors belong to slices B and C) |
| Environment | Linux 6.18 container, Node v22.23.5, Chrome for Testing 153.0.8010.12 (headless), playwright-core 1.56 |
| Author | Claude Opus 5.5 (Claude Code harness), operator Aravind |
| Window | 2026-11-20, about 20:47–21:45 America/New_York |

## Plan vs. actual

Planned: split slice A into A1/A2/A3; ship A1 as one PR covering spec items 2, 3, 5 and the bridge in item 4.

| File | Change |
|---|---|
| `extension/src/shared/core.js` | **New.** Frame ring (90 frames / 8 MiB, media-time dedupe), capture session (generation, real cancellation, ad and readiness gating, error codes), window validation, endpoint-preserving sampling, measured coverage and gaps, protocol validation, RPC client (correlation, deadlines, supersede, cancel). |
| `extension/src/content/content_script.js` | Rewritten around the core: lazy panel, MessageChannel bridge to the extension origin, player and route reconciliation (`yt-navigate-finish`, popstate, rAF-coalesced observer), `emptied` handling, unmount off `/watch`, real-button reopen handle, focus return, `box-sizing` fix for 390 px. |
| `extension/src/sidebar/*` | Port handshake, fresh-time marks with clear, validated windows with explanations, coverage meter, frame-tick and gap timeline, stale-result protection, honest copy for unimplemented features, tab ARIA basics, focus-visible, reduced motion. |
| `extension/manifest.json` | 0.2.0, honest description, `core.js` loaded first. Permissions and host scope unchanged. |
| `extension/src/background/service_worker.js` | Comment no longer describes future server calls. |
| `scripts/check.js`, `package.json`, `.gitignore` | Static checks and `npm run verify` / `npm run smoke`. Dev dependency: playwright-core only. |
| `test/core.test.js` | 29 unit tests. |
| `test/browser/*` | 17-step smoke test; fixture page and synthetic clip. |
| `README.md` | Install, behavior, privacy, verification, limitations. |

## Decisions

- **Bridge:** MessageChannel port, authenticated by a nonce in the iframe URL fragment, with the iframe inside a closed shadow root. The first version (908e391) relied on origin and source checks and **lost the connect race to a hostile page every time** in review. See spec v2, slice A item 4.
- **Frames survive close/reopen on the same video** (capture stops; frames stay) so a user can close the panel, reopen it and still analyze. Frames are cleared on video, element or source change and when leaving `/watch`.
- **Seeks keep frames.** Frames are keyed by media time, so a backward seek to replay the moment adds frames instead of invalidating valid ones. Gaps are measured, not inferred.
- **`web_accessible_resources` narrowed to `sidebar.html`.** The browser smoke test proves the sidebar still loads its CSS and scripts, and `scripts/check.js` enforces the rule.
- **Max window 20 s** so the longest window fits in the 90-frame ring at 1x. Slow playback can still evict the start of a window, and the panel says so.
- **Keyframe responses carry metadata only.** Image data stays in the content script until slice B's frame rail needs it.
- **Fixture routing, not test-only permissions.** The smoke test routes `https://www.youtube.com/watch` to a local page, so the production manifest is what runs.

## Commands

| Command | Exit | Result |
|---|---|---|
| `git status --short; git log --all --oneline --decorate` (operator clone, via device shell) | 0 | clean; refs match audit |
| `npm run verify` (at d819582) | 0 | 4 JS files and 7 manifest references; 0 failing, 3 known (1×1 icons, A2); 33/33 unit tests |
| `CHROME_PATH=/usr/bin/google-chrome npm run smoke` ×4 (at d819582) | 0 | 21/21 each run |
| new smoke against 908e391 (worktree) | 1 | 15/20: hijack, missing-player and blocked-capture steps fail, proving the new tests detect the reviewed bugs |
| `git diff --cached --check` | 0 | clean |

Earlier smoke runs failed and drove fixes, recorded here because they changed the result:
1. 390 px panel overflowed by the 1 px border → `box-sizing: border-box` (product bug).
2. Analyze at time 0 said "end mark is before start mark" → source-aware message (product bug).
3. Routed media didn't support Range requests, so seeks snapped to 0 and the marks test **passed vacuously**. The fixture now loads the clip as a blob, and the test asserts the exact mark values (harness bug).
4. Two harness races (reading text before an async mark resolved; stale result read) and blob URLs counted as network traffic (harness bugs).

## Checks not run

| Check | Status | Reason |
|---|---|---|
| Live YouTube smoke | **pending** | No signed-in, real-YouTube browser session in this run. The fixture does not certify live DOM, ads, or cross-origin canvas behavior. |
| Performance budget (≤50 ms tasks, p95 < 2 s to first evidence) | **pending (A3)** | Needs a named reference machine. Smoke shows first evidence well under 2 s on the fixture, but that is not a benchmark. |
| CI | **pending (A3)** | No workflow yet. |
| Blocked-capture smoke step | **flaky, 1 of ~7 runs** | Failed once before the final fixes; 0 failures in the 6 runs since. Cause not confirmed. The step now prints video state on failure. |

## Rollback

`git checkout main`, or reload the previous unpacked `extension/` from `a90be83`. A1 adds no storage, so there is no data to migrate.

## Follow-ups

A2 and A3 as in spec v2. Slice B can now build the frame rail on `selectWindow` results (frame IDs, media times, generation).
