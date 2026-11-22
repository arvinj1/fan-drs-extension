# Receipt · B/C independent review

| Field | Value |
|---|---|
| Reviewer | Separate agent with a clean context. **Same underlying model as the author (Claude Opus 5.5).** A human maintainer review is still **pending**. |
| Reviewed | `d601179..6a699a9` (spec v3, detectors, review policy, card, 0.3.0) |
| Verdict | **Hold**: 2 blockers, 7 important, 9 nits. Security vs A1 intact. |
| Fixed in | 0.3.1 (this commit) |

## Blockers
| # | Finding | Fix | Test |
|---|---|---|---|
| B1 | An older or overlapping review could finish late and replace the current one; the packet took the *live* video identity, so it could pair one video's frames with another's ID | Review sequence token checked after every await; results from another capture generation rejected; the packet uses the video identity returned with the frames | Smoke: slowed decode + navigation mid-review leaves no stale result; chip then shortcut back-to-back keeps the newer review and the right `video.id` |
| B2 | The grounding answer survived bracket edits, so OUT/NOT OUT could describe frames the viewer never judged | Changing the bracket or the crease clears the answer | Smoke: OUT → move bracket → INCONCLUSIVE, no radio checked |

## Important
| # | Finding | Disposition |
|---|---|---|
| I1 | Bail-off fired on brightness steps, camera jerks, and lost a real event to a later jerk | **Fixed**: brightness-normalised difference minus 2× the change in a reference strip beside the stumps; persistence measured against noise, not spike size. Unit tests for exposure step, flicker, 3 px jerk, real event then jerk. A glove that *stays* over the bails remains a known gap (in SPEC 4.4). |
| I2 | Cricket detection turned on for Cricket Wireless, Ashes of Creation, DRS in F1, PSL (console), "run out of time", "ODI"; missed "#IPL2025", "KKR vs MI", "Ind v Aus · Test · Day 3" | **Fixed**: definite / ambiguous tiers, franchise and national fixtures, Test + Day N, channel-only ambiguous counts half, alphanumeric split. 23-row table test. |
| I3 | A replay pause just before the incident reviewed a window ending before it | **Fixed**: the window ends at the later of the pause time and the seek origin. Unit + smoke (the bracket is found from a replay pause). |
| I4 | The replay gesture could wipe a review being edited | **Fixed**: never auto-triggers while the card is open. Smoke step. Live scrubbing behaviour is still to be checked on YouTube. |
| I5 | One grounding answer wasn't tied to either frame; a call didn't need a crease | **Fixed**: the question covers both bracket frames ("Behind in both / Not behind in both / They differ, or can't see"); `NO_CREASE` blocks a call; the packet records `grounded.frames`. |
| I6 | Spec over-claimed: crease "behind view", search near the stumps, hint preselects, gaps drawn, "turf colour model" | **Fixed in SPEC**: it now says what the code does. |
| I7 | Weak tests: replay regex matched anything; shortcut step bypasses `chrome.commands` | **Fixed** the regex and added B1/B2 steps. The command step is renamed to what it tests (the message), since commands can't be pressed headless; `onCommand` goes in the live check. |

## Nits
N1 null-prototype channel prefs (`constructor` etc.) **fixed** · N2 `textContent` instead of `innerText` per tick **fixed** · N3 lagging YouTube metadata during SPA navigation **open** (the packet now uses metadata captured with the frames) · N4 package version **fixed** · N5 empty `aria-activedescendant` removed; one live announcement per verdict change **fixed** · N6 skipped-frames wording **fixed** · N7 the card's Review again refreshes time, turns capture on, and is in the spec **fixed** · N8 channel prefs keyed by display name **open** (documented) · N9 narrow stump spacing abstains **open** (README limitation).

Also fixed while verifying: focus return after closing the card flaked about 1 run in 3; the closed panel is now `inert`, which removes the race (4/4 clean afterwards).

## Reruns (author, at this commit)
`npm run verify`: exit 0, 58/58 unit tests. `npm run smoke`: 27/27 on 4 consecutive runs (Chrome for Testing 153, headless).
A second review pass on 0.3.1 has not been run yet.
