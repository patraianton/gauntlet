# Measurement: canaries, the ledger, and how (not) to read the numbers

This file explains [SPEC.md](SPEC.md) section 14 (and the report phrases of 16.2). The spec is
normative.

## 1. The rule in one paragraph

A **canary** is a planted error: a small, natural-looking edit to the review copy that is provably
wrong. Every round carries some. In **one run** they are only a **gross-failure check** — "were the
reviewers awake?" — never a measurement of how well they catch errors. How well reviewers catch
errors (recall) is read **only from the cross-run measurement ledger**, always as `k/n` with an
interval, and only once enough canaries have accumulated (25–50). Even then it is an **upper bound**:
planted errors are easier to find than real ones, and reviewers are worst at noticing that something
required is missing.

### Where this rule comes from

A side note accepted by the project owner on proposal "A. Honest final":

- Catching all 2–3 planted errors in the blind round proves little. 3 of 3 caught means the true
  recall could be anywhere from 29 % to 100 %. To say "they catch more than 80 %" with confidence you
  need about 14 of 14.
- Planted errors are much easier to find than real ones (one paper, numbers not re-checked by us:
  F1 0.847 on inserted errors against 0.066 on real ones, arXiv 2606.15689, as reported by our
  research). Reviewers are worst at noticing that something required is missing (judges find what was
  added at 0.79–0.94 but what is absent at 0.50–0.63, arXiv 2608.31016, as reported).
- So: treat planted errors in one run only as a gross-failure check, and accumulate recall in a shared
  ledger across runs until 25–50 planted errors.

The spec builds that in: per-run catches gate lens validity but are never reported as recall; every
canary outcome of every run is written to the ledger; `ledger stats` prints intervals and says
"insufficient" until the numbers carry weight.

## 2. Two kinds of canaries

| Kind | How many | What it does |
|---|---|---|
| **Attention** | one per lens per round (`attentionPerLens` = 1) | Aimed at one lens's duty. If that lens does not catch it (at or above the severity floor), the lens is **not valid** this round: the round cannot be clean, the lens is re-run once with a fresh reviewer, and a lens that misses twice is `unreliable` (never DONE; with nothing else open, `STOP_INCONCLUSIVE`). |
| **Measurement** | 1 per working round, 2 per confirm round | Never gates anything. Exists only to feed the ledger: different types, positions, omissions. |

At least one canary per round is **planned** as an **omission** (something required removed), because
omissions are the weakest spot and the ledger needs them. If the planter and the validator fail twice on
that slot, the slot is dropped: the round then has no planted omission, report section 8 says so, and for
the confirm round the summary says so too (DONE is not refused for it; v2 re-plans the slot with another
omission type). A lens with no attention-eligible canary type is
`unguarded`: its answer counts in FIX rounds but it can never certify clean (the setup summary warns).

## 3. Canary types (v1)

From `taxonomy/canary-types.json`:

| Type | Definition | Attention-eligible | Omission |
|---|---|---|---|
| FACT-NUM | wrong number or arithmetic, provable from the material or a source | yes | no |
| FACT-CLAIM | a claim the material or a source contradicts | yes | no |
| CONTRA | two places in the work contradict each other | yes | no |
| LANG | grammar, spelling, diacritics, wrong script, calque (RU/LV/EN) | yes | no |
| PATH | broken step to the goal: call-to-action word, link target, form reference | yes | no |
| BRIEF | violates an explicit line of the owner's task | yes | no |
| POLICY | contradicts a stated rule, site policy, platform rule or law | no | no |
| OMIT-REQ | a required element removed (deliverable, call to action, item of a required series) | yes, only for a lens that lists it | yes |
| OMIT-CAVEAT | a required caveat, disclaimer or source attribution removed | no | yes |
| VISUAL | rendered defect (missing logo, overlap, contrast); needs `rebuild` and `visualAllowed` | yes if `visualAllowed` | no |

Why `POLICY` is measurement-only in v1: an attention canary must be provable by its target lens from
the material and the frozen sources alone; a contradiction with a site policy, platform rule or law is
provable only when that rule is itself a source, which v1 cannot guarantee per lens. It still enters the
ledger as a measurement canary. `LANG` covers calques in v1.

v2 adds `INJECT` (text addressed to reviewers next to a wrong figure) to measure obedience to
persuasion inside the material, and `UNSUPPORTED-CLAIM` ("the data does not support this", research
5.4/section 7 row 6): a claim no source backs, as opposed to `FACT-CLAIM`, a claim a source contradicts.
It needs a validator rule for "no source backs it" that v1 does not have. `POLICY` becomes
attention-eligible for a lens that owns a policy source, once the ledger shows such canaries are provable.

Bench runs (`canaries.fixedKey`) write every ledger row as contaminated: the key is known in advance and
reused every round, so no bench row ever counts toward the 25–50.

## 4. How a canary is made (no one who benefits writes it)

1. **The script chooses the slots** (`slots.mjs`): type, target lens, position band (start, middle,
   end third of the reading order) and severity floor. Types with the fewest ledger detections for
   this artifact type and instrument are preferred, so the ledger fills evenly; a confirm round prefers
   types not used in its candidate round; bands are balanced against the ledger and no two slots of a
   small round share a band. A seed commitment is logged; the seed is revealed in the key.
2. **A separate planter agent** proposes 2 candidates per slot. It sees the task, the pre-canary copy
   and its own slots — never lenses, checklists, templates or findings (a planter who knows the tests
   makes easy canaries: in one public kit a blind author's catalog was caught 12/20 against 26/26 for
   an author who knew the tests, as reported by our research). Rules: an honest-looking mistake in the
   work's own language and style; no markers or meta-text; provably wrong from the material or a
   source; not on text that is already wrong (real defects go to `incidental`).
3. **Code checks** each candidate: `before` occurs exactly once; size limits; inside the band; far
   enough from other edits; JSON still parses; no giveaway characters added; omission edits remove at
   least one sentence or item; in a large data file (reviewed through a sample, SPEC 14.10) the edit lies
   inside one sampled row and keeps that row's shape. Such a file therefore holds planted errors only in
   rows the reviewers were shown, indistinguishable from the others, so a catch or a miss there measures
   attention to the sampled rows, not to the whole file.
4. **A separate validator agent** judges each candidate: original correct, a real defect, provable,
   natural (1–5), no giveaway, its class. Code keeps the first candidate per slot that passes both.
5. **Code applies** the edit, preserving the file's BOM and line endings.
6. **Commitment:** the key is written to `<dataHome>/sealed/<runId>/<round>.key.json` and
   `hashJson(key)` is logged (`canary-commit`) before any reviewer prompt exists. **Reveal** only after
   every reviewer answer of the wave is ingested and hashed; the hash is re-checked (mismatch → exit 3).

## 5. Matching and outcomes

Stage 1 is code (`match.mjs`): a finding in the canary's file is a candidate match if its quote
overlaps the canary's `after` text (≥ 60 % of the shorter string, or a shared substring of ≥ 8
characters containing changed characters), or the locators are equal; for omissions, if the quote is
within 200 characters of the removal point or the finding is an omission/requirement mark overlapping
the removed text. If the finding text also contains a distinctive changed token, code decides it.
Everything unclear goes to a **matcher** agent (score ≥ 3 of 5 = same defect), which sees only the
canary descriptions and findings, after all answers are hashed. This two-stage design follows the
matching method reported in arXiv 2606.19749.

Outcome per (canary × reviewer job):

| Outcome | Meaning |
|---|---|
| `caught` | matched, and the reviewer's severity ≥ the canary's floor |
| `seen_underclassified` | matched, but below the floor ("noticed it, called it minor") — counts as a miss for lens validity |
| `missed` | not matched |

Matched findings are removed from the real-issue pipeline unless the matcher marks them `alsoReal`.

## 6. What one run's numbers mean

The report's section 8 shows, per lens: own attention canary caught / re-run / unreliable, and
"поймано X из Y пар" (pairs = canary × reviewer). Fixed sentences (not paraphrased):

- «Для проверки внимания в копию подложили N ошибок, по одной на каждый взгляд. Это проверка, что
  проверяющие не спали, а не замер того, насколько хорошо они ловят ошибки.»
- «Поймано K из N. При таком малом числе настоящая доля пойманного может быть где угодно от LO до HI
  из 100.»
- «Ещё M ошибок подложили для замера…» for the measurement errors of the round.
- «Справочно: поймано X из Y пар…» — a diagnostic only: each planted error targets one lens, so a
  healthy lens-focused panel can catch a small share of pairs (r3-f22).
- «Больше половины взглядов не нашли свою подложенную ошибку: в этом круге панель работала плохо» when
  fewer than half of the lenses caught their own attention error.
- «Подложенную ошибку «…» не нашёл ни один проверяющий.» for a unanimous miss.

Section 9 then shows the cross-run numbers for this instrument, or «данных пока мало (N из 25)», and
always: «Подложенные ошибки находить легче настоящих, поэтому настоящая зоркость проверяющих ниже этих
чисел. Хуже всего проверяющие замечают, что чего-то нужного в работе нет.»

## 7. The measurement ledger

Files in `<dataHome>/measurements/`, all hash-chained:

| File | One line per | Key fields |
|---|---|---|
| `runs.jsonl` | run end | runId, project, artifactType, instrumentId, lensSetId, models per role, lenses, rounds, confirms, decision, tokens, tokensEstimated, durationMin, seeded, fixedKey, contaminated |
| `canaries.jsonl` | canary | runId, round, roundKind, purpose, type, targetLens (id, title, lens sha), band, positionFraction, intended and validator severity, planterModel, planterIndependent, prePlanted, artifactType, instrumentId, lensSetId, materialChars, contaminated |
| `detections.jsonl` | canary × reviewer job | runId, round, canary, lens, attempt, reviewerModel, instrumentId, lensSetId, templateSha, outcome, stage, matcherScore, severityGiven, contaminated |
| `decoys.jsonl` | decoy × verifier job shown it | runId, round, roundKind, decoy, kind, claimedSeverity, wave, pass, job, outcome (rejected, confirmed, undecided, no-answer), verdict, batchTainted, verifierModel, instrumentId, artifactType, contaminated |
| `controls.jsonl` | true control × verifier job shown it | runId, round, roundKind, control, canary, plantedSeverity, wave, pass, job, outcome (kept, dismissed, downgraded, undecided, no-answer), verdict, severityGiven, batchTainted, verifierModel, instrumentId, artifactType, contaminated |
| `verdicts.jsonl` | verified item | runId, round, roundKind, clusterOrigin, claimedSeverity, finalStatus, finalSeverity, verdicts, lenses, nFinders, kind, grounded |
| `escapes.jsonl` | manual entry | runId, description, severity, lens, foundBy, ts |

**`instrumentId`** = hash of the reviewer template and the severity text: the frozen reviewer
instrument. It is the key of the cross-run series, so every run with the same templates adds to one
pool — which is what the accepted side note asks for (25–50 planted errors across runs). The lens set
is written fresh for every run and is kept as a sub-group, `lensSetId` (hash of the run's
`lenses.json`); the artifact type and the reviewer model are on every row and split in the stats.
Change the reviewer template or the severity text and you start a new series. `ledger stats`
reports per instrument and prints a pooled view across instruments separately, with a warning.

Report section 9 and the slot planner (which balances canary types by how few the ledger holds) both
read this cross-run series for the run's instrument and artifact type.

**Contaminated rows are kept but never counted:** legacy imports, and every canary of a fixed key
(`prePlanted:true`, e.g. the bench), with its detections and the run row. A fixed key was
planted by someone who knew the material and, for the bench, the lens set was written after the key
was known (three checklist lines point at C3, C4 and C5), so those catches are not independent.

## 8. `ledger stats`

```powershell
node bin/gauntlet.mjs ledger stats --md [--instrument <id>] [--artifact-type <t>]
```

Split by lens title, canary type, band, artifact type and reviewer model:

1. **Own-lens recall** (primary). Unit: attention canary; caught by its target lens's first attempt.
   Reruns are reported separately.
2. **Panel recall.** Unit: canary; caught by at least one reviewer of the round; split attention /
   measurement.
3. **Pair recall** (reviewer × canary). Diagnostic only, printed with "pairs are not independent; no
   interval": the five reviewers of one round read the same copy and share a model, so 25 pairs are
   not 25 independent trials.
4. **Knows-but-passes:** seen_underclassified / (caught + seen_underclassified) — reviewers who saw the
   problem and called it minor (failure point 11).
5. **Unanimous-miss rate:** canaries missed by every reviewer of the round — the shared blind spot of
   a same-model panel.
6. **Verifier rejection rate:** dropped / submitted blocker+major items; downgrade rate (final class
   below claimed) — how often reviewers raise false or inflated alarms.
7. **Escapes** by severity and lens — real problems found after "done".
8. **Decoy rejection:** decoys the verifier refuted / decoys shown to a verifier that answered, and the share
   it accepted — whether verifiers can say "no" (section 8b below).
8c. **True controls dismissed:** real planted problems the verifier refuted / shown to a verifier that answered, and
   the share it confirmed below the planted class — whether verifiers keep real problems alive (section 8c below).

Every proportion is printed as `k/n` with a two-sided 95 % Clopper-Pearson interval and, for claims
"recall above X", the one-sided 95 % lower bound. A cell with n < 10 prints "insufficient" (owner
report: «мало данных») instead of an interval. The headline own-lens recall says
"insufficient data (N of 25)" until n ≥ 25. Contaminated legacy rows appear only in their own table.

## 8b. Decoys: do the verifiers ever say "no"?

On two early runs the verifiers confirmed 55 of 66 and 103 of 108 items and, while the system was built, rejected none.
That can mean the reviewers were right, or that the verifiers are lenient; the existing numbers cannot tell
the two apart. So every round the program mixes **decoys** into the verifier batches: reports of problems that
are not there, written by a separate agent, each with a quote from the copy that proves it false, checked by
code, sealed from the executor until the round closes, and shaped exactly like real items.

- **Unit:** one decoy shown to one verifier job that answered. `rejected` = the verifier refuted it. `confirmed` =
  accepted. `unverifiable` = undecided. A job that gave no answer is not counted.
- **Read it like a canary rate:** `k/n` with the exact 95 % interval from n = 10; the first runs print
  "insufficient". Decoys of one verifier job, and one decoy shown to two jobs, are not independent trials.
- **What it is not:** a decoy is easier to refute than a subtle real error, so the rate is an upper bound on
  how often a verifier refuses a wrong *real* item. A low rate is a hard warning; a high one proves only that
  verifiers can say "no".
- **What the program does with it:** a verifier job that confirms a decoy is untrusted; its other confirmations
  in that batch are re-checked by a fresh verifier before they count; the report says «Перепроверка отклонила X
  из Y заведомо ложных замечаний» and lists nothing about decoys as problems.
- **Not counted:** bench runs (contaminated) and runs that use no decoys.

## 8c. True controls: do the verifiers keep real problems alive?

Decoys show that a verifier can say "no". A verifier that refuted everything would pass that test and still acquit
real problems. So every round the program also mixes **true controls** into the verifier batches: the reviewer
findings that the matcher matched to a planted error (the edit is the program's own, so the problem is certainly in
the copy). They are shown in the reviewer's own words, shaped exactly like real items, and sealed from the executor
until the round closes, like the decoys.

- **Unit:** one control shown to one verifier job that answered. `kept` = confirmed at the planted class or above.
  `dismissed` = refuted. `downgraded` = confirmed in a class below the planted one. `undecided` = unverifiable, or confirmed without a class. A job
  that gave no answer is not counted.
- **Read it like a canary rate:** `k/n` with the exact 95 % interval from n = 10; the first runs print "insufficient".
  Controls of one verifier job, and one control shown to two jobs, are not independent trials.
- **What it is not:** a control is easier to confirm than a defect nobody noticed (a reviewer already pointed at the
  place), so the dismissal rate is a lower bound of the real acquittals. A high rate is a hard warning; a low one proves
  only that verifiers do not acquit what a reviewer has already found.
- **What the program does with it:** a verifier job that refutes or downgrades a control is untrusted for its
  refutations and for its confirmations that make a serious item cosmetic: those items are re-checked by a fresh verifier
  before they count (its other confirmations stand). The
  report says in plain Russian how many real planted problems the verifiers wrongly dismissed.
- **Not counted:** bench runs (contaminated) and runs that use no controls.

## 9. Clopper-Pearson, and why small numbers say little

The Clopper-Pearson interval is the exact interval for a proportion from `k` successes in `n`
independent trials. It is conservative (it never claims more certainty than the data give) and it
behaves well at the edges (`k = n`, `k = 0`), where catches usually are. `lib/measure/stats.mjs`
computes it by bisection on the exact binomial distribution; these values are pinned by tests:

| k/n | two-sided 95 % | one-sided 95 % lower bound |
|---|---|---|
| 3/3 | 0.292 – 1.000 | 0.368 |
| 5/5 | 0.478 – 1.000 | 0.549 |
| 10/10 | 0.692 – 1.000 | 0.741 |
| 14/14 | 0.768 – 1.000 | 0.807 |
| 29/29 | 0.881 – 1.000 | 0.902 |
| 18/20 | 0.683 – 0.988 | 0.717 |
| 19/25 | 0.549 – 0.906 | 0.580 |
| 13/25 | 0.313 – 0.722 | 0.341 |
| 5/25 | 0.068 – 0.407 | 0.082 |
| 45/50 | 0.782 – 0.967 | 0.801 |
| 0/5 | 0.000 – 0.522 | 0.000 |
| 2/10 | 0.025 – 0.556 | 0.037 |

How the side note's numbers fall out of it:

- **3/3 caught** → the true recall is somewhere between **29 % and 100 %**. A run with 3 attention
  canaries all caught is consistent with reviewers who miss two thirds of errors.
- To claim **"above 80 %"** (one-sided lower bound > 0.80), you need:

| Claim | 0 misses | 1 miss | 2 misses |
|---|---|---|---|
| above 50 % | 5/5 | 7/8 | 9/11 |
| above 70 % | 9/9 | 13/14 | 17/19 |
| above 80 % | **14/14** | 21/22 | 28/30 |
| above 90 % | 29/29 | 45/46 | 59/61 |

  (computed with the same method; one-sided 95 %.)

- **25 independent canaries** separate a broken panel from a working one: at 5/25 the interval is
  0.07–0.41, at 19/25 it is 0.55–0.91, and they do not overlap. (The blind-experiment numbers "5/25" and "19/25"
  were **pairs**: 5 planted errors × 5 reviewers. Pairs are not independent, so no interval belongs on
  them; the blind-experiment own-lens figures, 2/5 → 0.05–0.85 and 4/5 → 0.28–0.99, overlap.) 25 canaries still
  cannot tell two similar panels apart. Hence the target of **25–50** canaries per instrument, and at
  least 10 per canary type before reading a type's number.

## 10. How not to over-read the numbers

- **One run is not a measurement.** Section 8 of the report is a smoke alarm, not a gauge.
- **Planted ≠ real.** Every recall in the ledger is an upper bound on recall for real problems.
  Escapes are the only real-error signal.
- **Omissions are hardest.** Read omission recall separately; the legacy data has none ("omission
  recall: no data").
- **Pairs are not independent.** Never put an interval on pair recall; never multiply reviewers into
  sample size. Nine judges from seven vendors gave only about two independent votes (arXiv
  2605.29800: ≈ 2.18–2.48 effective votes, as reported); five reviewers of one model are probably worth
  fewer — not measured.
- **Different instruments are different series.** A change of the reviewer template or the severity
  text starts a new `instrumentId`; a different lens set does not (it is a `lensSetId` sub-group).
  The pooled view across instruments is a hint, not a result.
- **Contaminated rows** (legacy, `planterIndependent:false`) were planted by someone who knew the
  checklists; they flatter recall.
- **Token numbers are what the panel's own agents spent, not what the turn spent.** In Workflow mode the
  script reads `budget.spent()` (the whole turn's counter: panel agents, other workflows and the window's
  own coding) right before and after each of its own agent batches and clerk calls, and reports the sum of
  those differences with `--usage-delta`. Never the turn total: in a long early run the total
  was reported and the first record of a round swallowed the window's own 50 minutes of work (1.57 M,
  3.58 M, 5.26 M for a planter step that cost 0.34 M in round 1); the run stopped at "panel token budget
  would be exceeded" with 16.0 M counted against about 6-7 M real. Remaining limits: (1) tokens that the
  window's main loop spends WHILE a batch runs (the window works concurrently) are inside that batch's
  difference; (2) the last clerk call of an invocation is not reported; (3) in Agent mode the numbers are
  still self-reported. A single usage record above 2 x `limits.roundTokenEstimate` is written with
  `suspect: true` and shown as such in `status` and in the report's cost section ("выглядят завышенными");
  it is still counted, because the token stop must err on the safe side, but read the run's token total
  and any `nextEstimate` derived from a suspect round with caution. `tokens` in `runs.jsonl` is that total.
- **Seeded runs** (`GAUNTLET_TEST=1` with a fixed seed) are test runs; the report warns about them.
- **Bench runs** (`prePlanted:true`) reuse the same 5 known canaries with a lens set written after
  they were known; their rows are marked contaminated and stay out of the clean series. They check the
  template, they do not measure it.
- **Planted errors were not checked by a person.** The validator is an agent of the same model as the
  planter and the reviewers. Research section 3.3 reports, for agent-planted errors, about 82.5 % real
  defects, 5 % non-errors and 12.5 % disputed (as reported). A missed non-error lowers recall; a
  non-error used as an attention check can mark a lens unreliable. A human spot check of a sample per
  run (`humanChecked` on the ledger row) is v2; until then read recall with this caveat.

## 11. Legacy data (contaminated)

`bench/legacy-2026-10.json`, imported with `ledger import-legacy`, flagged `contaminated:true`
(the planter knew the checklists) and `planterIndependent:false`; no omission canaries. Per-pair
matrices exist for the two blind-experiment arms and for r8; r9 and r10 kept per-lens counts only.

| Series | Pairs noticed, any class (diagnostic, no interval) | Own-lens caught | Own-lens 95 % interval |
|---|---|---|---|
| blind experiment, old prompt | 5/25 (4 caught at full class + 1 seen but filed as minor: old-risk K4) | 2/5 | 0.053 – 0.853 |
| blind experiment, new template | 19/25 | 4/5 | 0.284 – 0.995 |
| r8 | 25/25 | 5/5 | 0.478 – 1.000 |
| r9 | 20/25 | 4/5 | 0.284 – 0.995 |
| r10 | 13/25 | 5/5 | 0.478 – 1.000 |

Even pooled, the four new-template series give own-lens 18/20 → 0.683–0.988 — and that is
contaminated, Russian-template, same-material data. It is why the English templates must pass the
bench run before first use, and why the clean ledger starts from zero.

## 12. Escapes

`ledger add-escape --run <runId> --description <text> --severity blocker|major --lens <id|none>
--owner-quote <the owner's words> --question <the exact question you asked the owner> [--found-by owner|production|later-run]` records a real problem found after "done", on the owner's word and with the question the owner answered.
It is the only direct measure of what the panel lets through, and it grows slowly. Record every one.

## 13. What comes later (v2/v3)

Effective number of independent votes (n_eff) from the miss matrices; Chao1 and the seeding estimate
of remaining defects as second signals; clean-twin and known-bad controls for false alarms; a human
calibration sheet; recall-weighted lenses (a lens below a recall floor cannot certify alone);
adversarial canary selection. See [roadmap.md](roadmap.md). v1 already records the fields these need
(`positionFraction`, `matcherScore`, per-reviewer detections).
