# Receipt · PR #18 review at 494e4b2

| Field | Value |
|---|---|
| Reviewer | ChatGPT (an external model), relayed by the maintainer. Not a human code review; the human review is still **pending**. |
| Reviewed | PR #18 head `494e4b2` |
| Verdict | **Hold**: keep the capture and review workflow; fix the verdict path first. |
| Fixed in | 0.3.2 (this commit) |

## Findings
| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | A detector guess became a confirmed wicket break. The bail-off detector looks for sustained pixel change near the bails (a glove that stays over the bails fools it, as the B/C receipt admits), yet the card treated its output as the bracket and only asked about grounding. | Detector brackets are **candidates** (`confirmed: false`), labelled "Candidate" in the text, strip and stage. They support nothing until the viewer presses **Confirm both frames**; brackets the viewer marks are confirmed by construction. | Unit: a glove that arrives and stays makes the detector return a bracket (the known gap), and the finding reports no bail observation, flags `UNCONFIRMED_BRACKET`, makes no timing claim, and the packet carries `confirmed: false`. Smoke: the candidate is labelled; nothing about the bails appears in "observed" until it's confirmed. |
| 2 | The policy could say OUT without establishing a stumping: legal delivery and a fair break by the keeper were only assumptions, attempting a run wasn't checked, and two samples can't show grounding at the instant. | `decideVerdict` is replaced by `decideFinding`, which is **always INCONCLUSIVE** and has no OUT/NOT OUT path. It returns what's been observed, what's open (stable codes), and what's not established: legal delivery, a fair break by the keeper, a run attempt (run out vs stumped), and grounding between the two frames. The packet has `finding` instead of `verdict`. Spec 4.5 explains why. | Unit: every grounding answer with a fully confirmed bracket stays INCONCLUSIVE, and the not-established list includes all four items. Smoke: the verdict never reads OUT or NOT OUT for any answer, and the packet has no `verdict` field. |

## Other notes from the review
- **"Mergeable: false".** Rechecked after fetching: GitHub reports `mergeable: true, mergeable_state: clean`, and `main` is unchanged at `a90be83`. The earlier `false` was most likely GitHub still computing mergeability, which it does lazily.
- **No status checks.** Correct: the repo has no CI workflow yet (slice A3).
- **Smoke not rerun by the reviewer.** Noted; the author's runs are below. Live YouTube, including the real `Alt+Shift+R` command, is still **pending**.

## Reruns (author, at this commit)
`npm run verify`: exit 0, 60/60 unit tests, 3 known icon warnings. `npm run smoke`: 27/27 on 5 consecutive runs (Chrome for Testing 153, headless). `git diff --check`: clean.
