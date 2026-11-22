# Receipt · A1 independent review

| Field | Value |
|---|---|
| Reviewer | Separate agent with a clean context. **Same underlying model as the author (Claude Opus 5.5)**, so this is independent of the author's context, not of the model. A human maintainer review is still **pending**. |
| Inputs | `fan-drs-modernization-spec.md`, `git diff a90be83..908e391`, then `git diff 908e391..0c031be` |
| Method | Worked in its own clone (`/tmp/review-a1`); reran verify and the smoke; wrote its own adversarial Playwright probes (`probe.mjs` race/missing/jank/reuse, `probe2.mjs` blocked capture, `probe3.mjs` main-world attacks on the bridge) |

## Round 1 · 908e391 → **hold**

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Blocker | A page script that spams `connect` wins the race for the sidebar port 4/4 times (origin and source can't tell the page from the content script). The smoke step that claimed protection ran after the real handshake, so it tested nothing. | **Fixed in 0c031be**: closed shadow root + nonce handshake; a hostile-page smoke step attacks from before the panel exists. |
| 2 | Important | No player → SESSION_RESET every 500 ms with untrue "frames cleared" copy. | **Fixed**: `session.unbind()` once; PLAYER_MISSING copy; sentinel smoke step. |
| 3 | Important | A capture error emitted before the port connects is lost forever. | **Fixed**: the error is context state; cross-origin first-open smoke step. |
| 4 | Important | A 30 s max window can't fit in the 90-frame ring (~22.5 s at 1x). | **Fixed**: max 20 s; eviction-aware copy. |
| 5 | Important | Challenge tab claimed a model and confidence boosts. | **Fixed**: honest copy, badges removed. |
| 6 | Important | No live-stream handling. | **Fixed**: live note (also on the zero-frame path, d819582). |
| 7 | Nit | Double reset on same-element navigation. | **Fixed** (generation-based, d819582). |
| 8 | Nit | Result generation not checked. | **Fixed**. |
| 9 | Nit | Observed capture intervals not recorded. | **Deferred** to slice B (the frame rail consumes them). |
| 10 | Nit | `formatPreciseTime(1.996)` showed `0:01.99`. | **Fixed**; test added. |
| 11 | Nit | Over-broad `web_accessible_resources`. | **Fixed**; enforced by `check.js`. |
| 12 | Nit | Three smoke steps asserted nothing real. | **Fixed**: strengthened or renamed to what they check; ordering is covered by unit tests. |
| 13 | Nit | Keyframe responses shipped ~1.5 MB of unused JPEGs. | **Fixed**: metadata only. |
| 14 | Nit | Focus moved to an element being removed on unmount; observer never disconnected. | Focus **fixed**; observer **kept by design** (needed to remount on return to /watch; rAF-coalesced). |

## Round 2 · 0c031be → **ship**

The reviewer reran `npm run verify` (exit 0, 33/33) and the smoke twice (exit 0, 20/20 each). Main-world attacks on the bridge failed: patching `attachShadow` never saw the call, `window.length` is 0 for the page, the fragment is unreadable, and guessed-nonce connects are ignored. Remaining nits:

| # | Nit | Disposition |
|---|---|---|
| 1 | Live note missing when no frames were captured | **Fixed** in d819582 |
| 2 | Marks set while paused survived a same-URL source change | **Fixed** in d819582. The new smoke step also caught a regression in the first version of this fix, corrected before commit. |
| 3 | The nonce comparison is only unit-tested, because the page can't reach the iframe at all | **Accepted.** The browser can't exercise it from the page; `isAuthenticConnect` has 6 unit assertions. |
| 4 | A page can pre-create an element with our id to block mounting, or frame `sidebar.html` itself as a lookalike | Blocking **fixed** (stored references). Lookalike **accepted**: no more than the page could draw on its own. |
| 5 | Inaccurate comment | **Fixed** |

## Reruns after the fixes (author)

At d819582: `npm run verify` exit 0, 33/33; smoke 21/21 on 4 consecutive runs. A third review pass on d819582 was not run; the nit commit is small and fully covered by the reruns above.

**Decision:** ship A1 to a local beta once the live YouTube smoke is recorded. That gate is still pending.
