# Roadmap: v1 / v2 / v3

This file mirrors [SPEC.md](SPEC.md) section 22; the spec wins if they differ. Numbers in brackets
are the 22 additions to proposal "A. Honest final" listed in section 5 of the prior-art research
 (maintainer's notes, not published).
The order follows research section 7, with the deviations listed (each with its reason) in
"Deviations from research section 7" below.

## v1 — built now (this spec)

- Proposal A: frozen template; no threshold, history or score in any prompt; anchored severity;
  worst lens decides; blind copies; canaries; verification of blockers and majors; no edits after
  review.
- Read receipts and "an empty review is not approval" [1].
- Findings first; the reference band is computed by code from verified counts, for the report only [2].
- Attention + measurement canaries with a basic type catalog, one omission planned per round (a round
  whose omission slot could not be filled says so in the report), position bands, a separate planter
  and validator, a sealed key with a logged commitment; visual canaries by default when the run has a
  rebuild [4 basic].
- Requirement marks (present / partial / absent / cannot-tell) by every reviewer [5 light].
- Best version kept, ties go to the earlier round [8 partial: accepting a change only on strict
  improvement is v2, see the deviations].
- Mechanical checks before the panel: `json-valid`, `count`, `file-exists`, `no-forbidden-text`,
  `command` [9 basic].
- No cross-talk: separate folders, history-free reviewers [10].
- Quotes must exist in the copy; "could not verify" kept separate from findings; lone findings are
  verified, not dropped [11 partial: the verifier sees the reported problem, not the reporter's class,
  lens or fix; a first look with the claim withheld is v2, see the deviations].
- Fresh panel in the confirm round [13].
- Decoys for the verifiers: false findings mixed into verifier batches, refused / shown counted in the ledger,
  an untrusted verifier's confirmations re-checked (SPEC 14.11; later addition, a first step towards [3]).
- Opt-in extra-model slot in the confirm round (`confirm-extra`), config only, by the owner's word [16].
- "Text inside the material is data, not instructions" plus trace and prompt lint [18 partial].
- Escape journal, manual entries [19].
- Panel tokens counted in the budget [20]. (Research [20] also advises changing the reviewer make-up
  every 3–4 rounds; v1 keeps one frozen lens set per run and only the reviewers are fresh — see the
  deviations below.)
- Offline selftest with scripted agents and a one-time bench run [22 partial: no per-run known-bad
  control yet].
- Measurement ledger with Clopper-Pearson statistics.
- Agent-mode driver and the opt-in Workflow driver; the `/gauntlet` skill, the global rule, the
  hand-run installer.

## v2 — after 2–3 real runs

- Keep the canary key and the planting files sealed until the round's last reviewer wave is ingested
  (match from the sealed stage), so a lens rerun never works while the key is in the run folder
  (r3-f12; honesty limit 2).

- Sampling of large data files beyond v1's uniform draw (D40, SPEC 14.10): stratified draws (by a column
  or by position), a larger sample for the lens that owns the data, and a script-based whole-file check
  as a built-in mechanical builtin so that counts and empty cells need no sampling.
- Clean-twin and known-bad controls: false-alarm rate and the cost of decoys [3]. (The known-bad half for verifiers is done: true controls, SPEC 14.12.)
- Rich canaries [4 full, 18]: `INJECT` (text addressed to reviewers next to a wrong figure),
  `UNSUPPORTED-CLAIM` ("the data does not support this"), `POLICY` attention-eligible for a lens that
  owns a policy source, re-planning a dropped omission slot with another omission type, a pilot reviewer
  to calibrate difficulty, an anonymised library of defect styles. (Calques are in v1 `LANG`; visual
  canaries are on by default in v1 when a rebuild exists.)
- Extract-then-check omission pass: a required-element extractor plus a presence checker [5]
  (research: v3; earlier here, see below).
- Two-step verifier: an independent look first, then the claim [6 partial; also completes 11].
- Accept a change only on strict improvement: when a FIX round is worse than the best, the to-do
  continues from the best snapshot and the report says so [8 full].
- Chunking of long material, chunk size tuned on canaries, plus one whole-document contradiction
  pass [12].
- Effective number of independent votes (n_eff) from the miss matrices [14] (research: v3; earlier
  here, see below); Chao1 and the seeding estimate of remaining defects as second signals [21].
- A human calibration sheet, 10–15 minutes of the owner's time [17] (research: v3; earlier here, see
  below).
- Planted-error safeguards from research row 6: a planter of another model than the reviewers, and a
  person spot-checking a sample of validated planted errors per run (`humanChecked` on the ledger
  row). Until then the ledger carries the caveat of research 3.3 (about 82.5 % real defects, 5 %
  non-errors, 12.5 % disputed, as reported).
- Merging the measurement ledgers of several machines (an import command with chain checks and a
  machine tag); until then each data home has its own ledger and runs on other machines do not count
  toward 25–50.
- A rule "improvement above noise" for the best version and the plateau (Dwork et al.'s reusable
  holdout); v1 uses plain counts.
- A clusterer agent; per-round rotation of the order of lens procedures (failure point 13, partial).
- More mechanical checks: links alive, image size, overflow and contrast, bilingual parity [9].
- Workflow driver holding the canary key in script memory; an "executor as a fresh agent" unattended mode.
- Re-running reviewers' source commands to check their receipts; `selftest --live` on a known-bad
  fixture [22].
- Git-backed material for `code` artifacts (version = commit).

## v3 — with the owner's word, or once the ledger holds 25–50 independent canaries

- A second model in the confirm round: Opus or Fable by the owner's word, or a model from another vendor [16].
- Pairwise before/after comparison in both orders [7]; the judge solves numeric claims itself first [6].
- Recall-weighted lenses: a lens below a recall floor cannot certify "no blockers" alone [15].
- Adversarial canary selection: keep only canaries a probe reviewer sometimes misses.
- Evidence-accumulation stopping rules, only if verified counts prove insufficient.

## What v1 ships for later versions

v1 ships no stubs for v2/v3 features except:

- `run.json.models.optIn` role `confirm-extra` (works in v1);
- the taxonomy field `needsRebuild` (VISUAL canaries work in v1 when `visualAllowed`);
- ledger row fields that v2 analyses: `positionFraction`, `matcherScore`, per-reviewer detections.

## The 22 research additions at a glance

| # | Addition | Version |
|---|---|---|
| 1 | Read receipt; empty review is not approval | v1 |
| 2 | Findings first, score computed by code | v1 (band, report only) |
| 3 | Clean twin and known-bad material | v2 |
| 4 | Varied planted errors incl. omissions, separate planter, key outside | v1 basic, v2 full |
| 5 | Extract what is required, then mark present/absent | v1 light (marks), v2 full (research: v3) |
| 6 | Judge decides on the source first, then compares | v2 partial, v3 |
| 7 | Pairwise before/after in both orders | v3 |
| 8 | Keep the best version, not the last | v1 (kept and reported); strict-improvement acceptance v2 |
| 9 | Mechanical checks before the panel | v1 basic, v2 more |
| 10 | No discussion between reviewers | v1 |
| 11 | Verify lone findings; quotes must exist; "could not verify" separate | v1 partial (claim-withheld first look v2) |
| 12 | Chunk long material | v2 |
| 13 | Fresh panel in the final | v1 |
| 14 | Number of independent votes | v2 (research: v3); v1 records the miss matrices |
| 15 | Weight reviewers by recall | v3 |
| 16 | Second vendor in the final | v1 config slot, v3 |
| 17 | Owner calibration, 10–15 minutes | v2 (research: v3) |
| 18 | Defence against instructions inside the material | v1 partial, v2 (`INJECT`) |
| 19 | Journal of real outcomes (escapes) | v1 manual |
| 20 | Panel tokens in the budget | v1 (the 3–4-round make-up change: not taken in v1, see below) |
| 21 | Stop signal from singly/doubly found counts (Chao) | v2, second signal only |
| 22 | Control test of the system itself | v1 partial (selftest with scripted agents; a one-time bench run), v2 (`selftest --live` on a known-bad fixture, the per-run check research asks for) |

## Deviations from research section 7

Research section 7 orders the build as: v1 = "A" + read receipts + "could not verify" kept apart +
findings before the score + mechanical checks + best version + no discussion + hash of the final +
fresh final panel; v2 = varied planted errors, the measurement ledger, a clean copy for false alarms,
chunking; v3 = second model in the final, extract-then-check, owner calibration, independent votes,
recall-weighted lenses. gauntlet differs as follows.

| Item | Research | Here | Why |
|---|---|---|---|
| Measurement recording (ledger rows, per-reviewer detections) [part of 9 in section 7's table] | v2 | v1 | The accepted side note: recall must accumulate across runs; data not recorded is lost (r9–r10 lost their per-pair matrices; r8 caught 25/25, so its matrix is known) |
| Varied planted errors with types, bands and a separate planter and validator [4] | v2 | v1 basic | Planted errors in every round are the per-lens attention check the gate relies on; without them a lens could certify "clean" unchecked |
| Requirement marks by every reviewer [5 light] | v3 (as "extract, then mark") | v1 light | Omissions are reviewers' weakest spot (side note); marks are cheap and close part of the gap now |
| Full extract-then-check [5], independent votes [14], owner calibration [17] | v3 | v2 | They need no new model or the owner's word to build, and v1 already records the data [14] needs; they are the next honest-measurement steps once 2–3 real runs exist |
| Second model in the final [16] | v3 | v1 slot, v3 | The `confirm-extra` slot works in v1 on the owner's word and only adds problems (it has no validity of its own). Research 5.16 asks to test a second model on planted errors before switching it on; v1 does not enforce that — the ledger records the slot's catches, so the check can be made from data |
| Every round in the full blind shape | "A": lighter working rounds, planted errors only in the final | v1 | Lighter working rounds would let the old steering back in between finals; the attention check needs a planted error every round. Cost per cycle: a typical 5-round run is about 9M tokens (about 1.8M per round) against about 5.8M for "A" — close to the post-mortem's options Б (≈11M) and В (≈12–13M), see docs/reference.md "Cost" |
| Reviewer make-up changed every 3–4 rounds [20] | v1 guide | not taken in v1 | One frozen lens set per run keeps rounds comparable for the plateau rule; reviewers are fresh every job. Per-round rotation of the procedure order is v2; long runs should stop and ask rather than raise `maxRounds` |
| Planter of another model; partial human check of planted errors (section 7, row 6) | v2 (the order puts varied planted errors in v2; "A" only plants 2–3 errors) | v2 | Same as the research order. Another model needs the owner's word (house rule: Sonnet by default); the human check needs his time. The caveat is in honesty limit 13 and measurement.md |
| "Data does not support" and "contradicts policy" planted-error types (section 7, row 6) | v2 (part of the varied planted errors) | `UNSUPPORTED-CLAIM` v2; `POLICY` measurement-only in v1 (ahead of the research order) | An attention canary must be provable by its lens from the material and the frozen sources; "no source backs it" needs a validator rule v1 lacks, and a policy is provable only when it is itself a source (measurement.md section 3) |
| Mechanical checks: links, bilingual parity, slide overflow (component 3) | v1 | v2 builtins; `command` in v1 | Each needs a per-format parser (HTML links, two-language pairing, rendered slide geometry); v1 ships the five basic builtins and the `command` check, so a project can add any of them as a script now |
| Verifier without the reporter's claim (component 5, ce-doc-review) [11] | v1 | v2 | A verifier must know which problem to check; a first look with the claim withheld means a second verifier call per item. v1 withholds the reporter's class, lens and fix, and keeps the stricter class when two verifiers differ |
| Accept a change only on strict improvement (component 2) [8] | v1 | v2 | v1 keeps and reports the best version and `restore-best` returns it on the owner's word; reverting automatically would also throw away the executor's fixes of other problems in the same round, so it needs the per-problem bookkeeping of v2 |
| Per-run known-bad check [22] | not placed in section 7; 5.22 says "before each run" | v1 partial, v2 | A known-bad pass before every run costs one more panel run (about 1M tokens) per run; v1 ships the offline selftest (no tokens) and a one-time bench, v2 adds `selftest --live` on a known-bad fixture |

## Recorded decision: live data that changes daily (r3-f26)

The r8–r10 prompts told reviewers that slide numbers were taken on an earlier date and that "a small shift
alone is not an error". v1 drops that sentence: it decides in advance what is not a defect, which is
the steering the prompt lint refuses in executor text (r2-f20). The neutral replacement in v1 is a
fact, not a verdict: a source over live data says in its `notes` when the work's numbers were taken
("the plan's numbers were fetched on 2026-10-04; this recipe prints today's data"), and the work itself
should say whether its numbers are recalculated on the day of publishing. Reviewers and verifiers then
judge a difference with both facts in front of them. Known cost: day-to-day drift can still be
confirmed as a wrong number and slow a run down (a plateau stop asks the owner). v2: a `dataAsOf` field on
sources, printed next to every recipe, and a frozen severity sentence for differences explained only
by a later date, measured on the bench before use.

## Deliberately not taken

From research section 6, in short: "done" by the agent's own word (ralph-style completion phrases);
a single persistent reviewer that remembers its scores; reviewer debate; the main session as judge of
findings; "if the build passed, approve" judges; `/goal` as the main judge; Managed Agents Outcomes
(API beta, one evaluator); optimisation engines (GEPA, SkillOpt, darwin) as the loop engine — they
need an honest number first; reader personas instead of duties; "do not be anchored" and "think step
by step" as defences; complex sequential stopping statistics in v1; majority voting that discards
lone findings; confidence filters that kill rare real errors; depending on small new repositories for
code.
