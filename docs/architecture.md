# Architecture

This is a trimmed, readable view of [SPEC.md](SPEC.md) sections 4–14 and 23. The spec is normative;
this file explains how the parts fit.

## 1. Shape of the system

```
                 owner: verbatim task, quoted decisions, reads the report
                          |
                          v
  executor window --(runs)--> bin/gauntlet.mjs step <run>  <--(same calls)-- Workflow driver (opt-in)
        |                              |
        | spawns exactly the           | does every deterministic job, then prints ONE of:
        | printed calls                |   exit 10  agent calls to spawn
        v                              |   exit 20  the executor's to-do
  fresh agents (Sonnet/high)           |   exit 30  a stop, report written
   lens writer, planter, validator,    v
   reviewers, matcher, verifiers,   run folder (hash-chained ledger, write-once answers)
   dispute verifier                 data home (anchors, runs index, sealed keys, measurement ledger)
        |
        +--> write answer.json into their own job folder; reply DONE
```

There is one code path: the `step` state machine. Agent mode (the default) and the Workflow driver
both just call `step` and spawn what it prints (SPEC D1, D2).

## 2. Modules

| Package | Folder | Responsibility |
|---|---|---|
| P1 core | `lib/core/` | errors and exit-code classes; canonical JSON; SHA-256 (`node:crypto` and a pure-JS copy for the Workflow script); file I/O (atomic writes, write-once, BOM/CRLF handling, `safeRemove` that refuses junctions/symlinks); path normalisation (`C:\`, `C:/`, `/c/`, `~`); crypto randomness with a test-only seed; clock; the JSON Schema subset validator; globbing; hash chains; data-home and run-folder paths; `run.json` loading and opt-in rules; allowlisted child processes (`shell:false`, `windowsHide:true`) |
| P1 schemas | `schemas/` | JSON Schemas for every file and every agent answer |
| P2 material | `lib/material/` | manifests and version hashes; snapshots; review copies (strip, banner, rebuild, trace scan); strip rules; lints (trace, path, prompt, quote normalisation, quote finding); source recipes; mechanical checks; read-receipt challenges; template rendering; job folders; sampled review of large data files (`sample.mjs`: record scanning, the seeded draw, the planter's guard, sample files for job folders) |
| P2 catalog | `catalog/` | regex catalogs: review-trace patterns, forbidden prompt patterns, meta-mention patterns |
| P3 engine | `bin/gauntlet.mjs`, `lib/engine/` | CLI dispatch and `--json` envelope; the state machine; setup and freeze; round orchestration; ingest; clustering; verification; disputes; the gate; the reference band; `done`; `audit`; one module per command |
| P3 selftest | `lib/selftest/`, `fixtures/selftest/` | offline end-to-end run with scripted agents |
| P4 measure | `lib/measure/`, `taxonomy/`, `bench/` | canary taxonomy; slot planning; candidate validation and application; decoy and true-control checks and counts; sealing and reveal; matching; Clopper-Pearson; the measurement ledger; recall statistics; legacy import |
| P4 report | `lib/report/` | the Russian owner report, its lint, fixed phrases, the 5-line summary |
| P5 templates | `templates/`, `lenses/examples/` | frozen prompt templates (hashes in `MANIFEST.json`), the shared severity text, the one-line agent call, the standalone answer checker, the lens library |
| P6 drivers | `skill/`, `rules/`, `workflows/`, `install/` | the `/gauntlet` skill, the global rule file, the opt-in Workflow driver, the hand-run installer |

Every file has exactly one owning package (SPEC section 6). Command modules export
`async run(argv, ctx) -> { exitCode, state?, payload, text }`; `bin/gauntlet.mjs` prints either
plain text ending in `NEXT: ...` or the JSON envelope
`{ok, exitCode, command, state, payload, sig}` where `sig = sha256(canonical(payload))` (an unkeyed
checksum: it catches copying errors in a relay, not forgery).

## 3. The run at a glance

```
init -> task set -> (executor writes sources.json, strip.json, mechanical.json, edits run.json)
     -> step: lens-writer job -> step: ingest lenses, smoke-test sources, freeze, setup summary  [READY]
loop:
  step: precheck (mechanical) -> snapshot -> review copy (strip, banner, rebuild, trace scan)
        -> sample draw for large data files (sealed) -> slot plan -> planter job
  step: ingest proposals -> canary-validator job
  step: apply canaries, commit key hash -> reviewer jobs (one per lens) + the decoy writer, all in parallel
  step: ingest answers (schema, nonce, receipts, minimum, copy unchanged, quotes)
        -> stage-1 canary match -> [matcher job]
  step: lens validity (own attention canary caught) -> [rerun jobs for invalid lenses, once]
        -> cluster findings + carry-over + requirement claims + disputes -> verifier jobs (+ two dispute jobs),
           with the decoys mixed into the verifier batches
  step: [second-verifier jobs, fresh verifiers for what an untrusted verifier decided] -> gate
        -> reveal decoys -> ledger rows -> todo / report
        FIX -> executor fixes, runs step again
        CONFIRM -> executor changes nothing, runs step again (confirm round)
        DONE -> executor runs `done` (re-hash live files) -> report
        STOP_* -> report, owner decides
```

## 4. State machine

States (`state.json`, a cache; the ledger is the truth and `audit` rebuilds the state from it):

```
NEW -> AWAIT_LENS_WRITER -> READY
READY -> AWAIT_PLANTER -> AWAIT_VALIDATOR -> AWAIT_REVIEWERS
      -> [AWAIT_MATCHER] -> [AWAIT_REVIEWERS (lens reruns)] -> [AWAIT_VERIFY -> [AWAIT_VERIFY2]]
      -> gate -> READY (FIX, CONFIRM, INVALID_ROUND) | STOPPED (DONE decision, STOP_*)
STOPPED (after DONE decision) -> done -> DONE | STOPPED (edited after review)
any -> abort -> ABORTED
```

`step` holds a lock file (`<run>/.lock`) while it works. It is idempotent: run again in a waiting
state, it reprints the same calls. With `canaries.fixedKey` (bench mode) the planter and validator
states are skipped.

Setup (11.1): `TASK.md` and `sources.json` are required; the review base is checked (absolute, away from
run folders, the repository, the data home and key files); folder links in the roots are refused; every
source must pass and none may read a file of the material, the run folder or the project folder, or one
written during the run; the strip preview (`strip-preview.mjs`) builds a throw-away copy and refuses
problems and non-trace removals without the owner's quote; the lens-writer job
gets only the task, the artifact type, a manifest summary (file names, kinds, counts — no content),
source ids with descriptions, one library example and the canary type ids. Its answer is validated
by code (schema, 3–7 lenses, task quotes found in `TASK.md`, every material file covered by some
`all-files`/`all-entries` minimum, a glob rule in every lens, source ids exist, globs match, canary types
exist, prompt lint for loop-control constructs). If the settings changed after the lens writer was
briefed, setup starts again.
One re-issue with the error list; a second failure stops the run. Then `FROZEN.json` is written and
the state is `READY`.

Round start (11.2): budget pre-check (`STOP_LIMIT` before spending); pending owner stop; "material
unchanged since FIX" refusal (unless `--same-material`); round kind (`confirm` only if a candidate
exists and the live version hash equals it); snapshot; folder links, file coverage, primary sources
and mechanical checks (`BLOCKED_PRECHECK`; a blocked attempt keeps its folder number but is not a round and is counted nowhere); review
copy with strip rules, author-notes banner, optional rebuild and trace scan (`BLOCKED_TRACE`); slot
plan (in the sealed stage); planter job.

## 5. Data flow and who sees what

Information matrix, compressed (SPEC 5.2). "No" means structurally absent from the agent's input
unless marked "instruction only".

| Agent | Sees | Never sees |
|---|---|---|
| Lens writer | `TASK.md`, manifest summary, source ids, one example, canary type ids | material content, executor notes, anything about rounds |
| Planter | task, pre-canary review copy, its own slots, type definitions for those slots | lenses, checklists, templates, findings |
| Canary validator | task, pre-canary copy, candidates, sources | lenses, findings |
| Reviewer | task, requirements, planted copy, its own lens, sources, author notes with banner | thresholds, `ownerTarget`, round numbers, scores, history, other answers (instruction only), the canary key (location) |
| Matcher | canary descriptions, findings as JSON (id, file, locator, quote, problem) after all answers are hashed | task, copy, lenses |
| Verifier | task, planted copy, sources, items: location + quote + one-sentence claim | reviewer's class, lens, fix, origin, number of finders, whether the item is new |
| Dispute verifiers (two) | task, copy, sources, the disputed cluster and the executor's linted argument and evidence | everything else, and each other's answer |
| Executor | its own material, verified findings, to-dos, reports | answers before the round closes, the sealed key (instruction only) |

Thresholds, `ownerTarget`, round numbers, scores and the word "canary" appear in no agent input —
including the global rule file every Claude session loads, which therefore carries no loop internals.
Agents work only inside neutral random folders under the review base; the run folder path and the
repo path appear in no agent input (path lint). Source descriptions, origins and notes are shown under
a banner saying they are the author's unverified claims.

### Agent jobs

Each agent call is a **job**: a folder under the review base named with 8 random characters,
containing `PROMPT.md` (rendered by `render.mjs` from a frozen run-local template copy),
`answer.schema.json` and `check-answer.mjs`. The agent receives one fixed line (`agent-call.txt`):
read the prompt file, do what it says, reply `DONE <answer code>`. It writes `answer.json` in its job
folder and checks it with `node check-answer.mjs answer.json`, which prints the answer code (the first 16
hex characters of the file's sha256). At ingest, `step` re-hashes `PROMPT.md` (must equal the issued
hash), compares the answer with the relayed code (`--answer-hash`), validates the schema and the
cross-field rules, checks the nonce, copies the answer write-once into `rounds/NN/answers/<job>.json`
and logs its hash. Planter and validator answers, code checks, slots, the chosen edits and their
prompts go to the sealed stage in the data home and move into `rounds/NN/` only at reveal, so no key
material sits in the run folder or beside the review copy while reviewers work.

### Reviewer validity

`kept` = schema and nonce ok (findings count). `valid` additionally needs at least 2 of 3 read
receipts correct (`line`: copy an exact line; `count`: number of files for a glob or entries at a
JSON pointer), every minimum item present in `inspected` and done (an item marked not done makes the
answer invalid), every requirement marked, and no mention of planted errors. An invalid attempt's findings still count; its clean does not.

### Canaries

Code chooses slots (type, target lens, band, severity floor): one attention slot per lens plus
measurement slots (1 in working rounds, 2 in confirm rounds), at least one omission type per round,
bands spread over start/middle/end. The planter proposes 2 candidates per slot; code checks each
(exactly-once `before`, size, band, distance, JSON still parses, no giveaway markers); the validator
judges them; code applies the first approved candidate per slot, preserving BOM and line endings.
The key is written to `<dataHome>/sealed/<runId>/<round>.key.json` and its hash is logged
(`canary-commit`) before any reviewer prompt is rendered. Reveal happens only after every reviewer
answer of the wave is ingested and hashed; the reveal checks the hash. Matching is two-stage: code
decides clear pairs, a matcher agent judges the rest. Outcomes per (canary × reviewer job): `caught`,
`seen_underclassified` (matched below the floor), `missed`. Matched findings leave the real-issue
pipeline unless the matcher marks them `alsoReal`. Details: [measurement.md](measurement.md).

### Large data files

A data file over the size or row threshold (`limits.sampleThresholdBytes`, `sampleThresholdRows`) is
reviewed through a sample (SPEC 14.10, D40). After the review copy is built and before the slots are
planned, `lib/material/sample.mjs` scans each data file into records (quote-aware CSV/TSV, JSON lines,
a top-level JSON array) and draws, from the seeded generator, the header plus up to `sampleRows` rows
(capped by `sampleMaxBytes` characters per file and by `sampleTotalBytes` over all files, split evenly). The selection (`sample.json`) is kept in the sealed stage next
to the slots and moves into `rounds/NN/` at reveal; its hash is logged in `slots` and `canary-commit`.
The planter's job folder gets the pre-planting rows as `SAMPLE-<k>.md` and code refuses any edit
outside a sampled row or one that changes the row's shape; rows of planted errors are added to the
sample; each reviewer's job folder gets `SAMPLE-<k>.md` rendered from the planted copy; `minimumValue`
rewrites "every row" rules over such files to the sampled rows plus the summary numbers of the other
files; read receipts for such files are drawn from sampled rows. The report states how many rows
were seen out of how many. `classifyEntries` also finds the big files that cannot be sampled (json object, xml, sql,
txt, log) and the groups of small files of one kind in one folder that together pass 4 x the file threshold; both
are kept in the selection (`unsampled`, `grouped`), told to the reviewers and listed in the report (SPEC 14.10).

### Decoys

Verifiers almost never refuse an item, so "confirmed" says little until we see them refuse something.
In the same wave as the reviewers a decoy writer proposes false findings, each with a proof quote from the copy
that shows it false; code checks them (the quote and the proof are found in the copy, neither touches a
planted edit, no giveaway words), seals the key in the data home with a commitment, and mixes the chosen
decoys into the verifier batches so that they look like real items (same fields, an id of the same format that
names no cluster). Verdicts on decoys never touch `clusters.json`; they are the decoy results of the round and
rows of `measurements/decoys.jsonl`. A verifier job that confirms a decoy is untrusted: what it confirmed is
re-checked by a fresh verifier (a second wave). The key, the mix and the results move into the round folder only
when the round closes. SPEC 14.11; limits: honesty limit 25.

### True controls

A decoy shows that a verifier can say "no"; a verifier that refutes everything would pass that. So the findings that the
matcher matched to a planted error this round (they leave the real-problem pipeline) are also mixed into the verifier
batches, in the reviewer's own words, as true controls: problems that are certainly in the copy. Code chooses them
(`chooseControls`: one per planted error, reported at the planted class, a quote found in the copy), seals the key in the
same decoy stage with a commitment logged before any verifier is asked, and spreads them over different batches. A
verifier job that refutes or downgrades a control is untrusted for its refutations and for its confirmations that make
a serious item cosmetic: a fresh verifier re-checks them.
Verdicts never touch `clusters.json`; they are the control results of the round and rows of
`measurements/controls.jsonl`. SPEC 14.12; limits: honesty limit 26.

### Clustering and verification

Findings are grouped deterministically (same file and overlapping quotes, or the same omitted
requirement — never by locator alone; the representative is the most serious claim), attached to existing open clusters where they overlap, and joined by
requirement clusters (any `absent` mark, `partial` marks, all-`cannot-tell`) and carry-over clusters
from earlier rounds. Verifier items are built from new claimed blockers/majors, ungrounded clusters,
requirement clusters and carry-overs on a changed version; shuffled; batched by 8. In confirm rounds
every item goes to two different batches. The class rule (SPEC 12.6) is fail-closed: `unverifiable`
keeps an item open as `unverified`; a refuted blocker claim or carry-over needs a second verifier;
one confirm plus one refute is `contested`. Only verifiers, two agreeing dispute verifiers and owner
waivers change a status; `clusters.json` is guarded (an edit between commands is `TAMPER`). The union rule: a cluster confirmed on version *h* stays open while the material is
still *h*.

### The gate

`lib/engine/gate.mjs` exports a pure `decide(input)`; `audit` replays it on every stored round.

```
if owner 'stop' recorded after the previous gate          -> STOP_OWNER
if kind == confirm:
    if clean and versionHash == candidate.versionHash     -> DONE
    confirmsDone += 1; candidate := null
    if any lens unreliable and |open| == 0                -> STOP_INCONCLUSIVE
    if confirmsDone >= maxConfirms                        -> STOP_LIMIT (reason "confirm rounds")
    -> continue with the working checks below (from "rounds/tokens")
if kind == working and clean                              -> CONFIRM (candidate := this round)
if any lens unreliable and |open| == 0                    -> STOP_INCONCLUSIVE
if roundsDone >= maxRounds or spent + nextEstimate > maxPanelTokens -> STOP_LIMIT   # roundsDone = working rounds only (r3-f16)
if stagnant >= plateauRounds                              -> STOP_PLATEAU
-> FIX
```

`clean` = every lens valid (answer valid and own attention canary caught) ∧ no open verified
blocker/major in any lens ∧ no pending dispute. The best version is a separate matter: the fewest verified
blockers, then majors, over every reviewed round whatever the lenses' validity (`lensesValid` says whether
that round was fully checked). `RERUN_LENS`, `INVALID_ROUND`, `BLOCKED_PRECHECK`
and `BLOCKED_TRACE` are decided before the gate by `round.mjs`. No average is computed anywhere; the
reference band (confirm rounds only) is computed from verified counts for the report and never feeds
the gate.

## 6. Files

### Run folder (`<projectDir>/gauntlet-runs/<runId>/`)

```
run.json  OWNER-TASK.md  TASK.md  sources.json  strip.json  mechanical.json  lenses.json  FROZEN.json
SETUP-SUMMARY.ru.md  templates/  state.json  ledger.jsonl  clusters.json  disputes.json
owner-decisions.json  usage.jsonl  .guard-open (while a command runs)  setup/lens-writer-<n>/  setup/strip-preview.json
rounds/NN/  round.json precheck.json snapshot/ manifest.json copy.json slots.json approved.json planter-<n>/ validator/
            canaries.json decoys.json decoy-mix.json decoy-results.json decoy-writer/ controls.json control-mix.json control-results.json (the last seven from the close of the round) jobs.json prompts/ answers/ ingest/ detections.json verify-items.json gate.json todo.md
best.json  DONE.json  REPORT.ru.md  AUDIT.json
```

### Data home (`gauntlet-data\`)

```
anchors.jsonl        one chained line per run-ledger append: {runId, seq, head}
runs-index.jsonl     one chained line per run state change (the first line of a run also carries short material file hashes)
templates-approved.json  the owner's approvals of reviewer-template versions (MANIFEST sha256, version, words, date; r3-f6)
sealed/<runId>/<round>.key.json   canary key between commit and reveal
sealed/<runId>/<NN>-stage/        slots, chosen edits, planter/validator answers and prompts until reveal
sealed/<runId>/<NN>-decoy-stage/  decoy writer answer, decoy and control keys, mixes and results until the round closes
measurements/        runs, canaries, detections, verdicts, decoys, controls, escapes (.jsonl, chained); STATS.md, STATS.json
selftest/<random>/   selftest workspaces
```

### Integrity

Every `.jsonl` we own is a hash chain: each line `{seq, prev, hash, ts, ...payload}` with
`hash = sha256(prev + canonical(line without hash))`. After each run-ledger append, the head is
copied to `anchors.jsonl` in the data home. Every command (except `init`) verifies the chain and the
anchor (exit 3 `TAMPER`), and after freeze verifies `FROZEN.json` (exit 3 `FROZEN_MISMATCH`).
`FROZEN.json` holds the hashes of the owner task, task, run settings, lenses, sources, strip rules,
mechanical checks, templates, taxonomy and catalogs, plus `instrumentId` — a hash of the reviewer
template and the severity text, the key of the cross-run measurement series — and `lensSetId` (the
lens set, a sub-group), which tag every measurement row.

The guard: when a command releases the run lock, the hashes of every engine-written decision file
(clusters, disputes, owner decisions, best, DONE, the strip preview, every round file and ingest
record) that changed are logged as a `guard` event; the next command compares the files with the
ledger and stops with `TAMPER` on a difference. A command killed half way leaves `.guard-open`; the
next locked command records what it wrote as an interrupted command.

All our files are UTF-8 without BOM, LF, written atomically. Material files are copied byte-exact.
Child processes run only through the allowlist in `proc.mjs`.

## 7. Drivers

**Agent mode** (default): the window runs `step`, spawns every printed call in one message with the
Agent tool, passes the agents' answer codes back with `--answer-hash` and token counts with `--usage`,
acts on to-dos, and stops on exit 30.

**Workflow mode** (opt-in): `workflows/gauntlet.workflow.js` loops a "clerk" agent that runs
`step --json`, recomputes the `sig` checksum with an inlined pure-JS SHA-256, accepts only job calls of
the fixed shape, spawns the printed jobs with `parallel()` and `effort: 'high'`, and passes
`--driver workflow --usage-delta <n>` (the tokens its own agents and clerk calls spent since the last
report, read from `budget.spent()` right before and after each of them; never the turn total), the agents' answer codes and `--give-up` for agents that died. `step --driver workflow`
refuses without the owner's recorded opt-in. The script has no filesystem access by design of the Workflow
tool; all file work goes through `step`.

## 8. Owner-facing outputs

`SETUP-SUMMARY.ru.md` after freeze, `REPORT.ru.md` (14 fixed sections, fixed phrases from
`lib/report/phrases.ru.json`, report lint forbids «панель поставила» and bare `x,y из 10`), and
`report --summary` (5 lines plus one per caveat, always with the audit result; the headline re-hashes the
live files and turns into «Готово с вашими исключениями» after owner waivers or decisions). `done` and
`report` run the audit first; a failed audit refuses `done`. All are generated from run files only; the executor can add an optional
comment (at most 2000 characters, linted with quote lines included) shown under its own heading as
unchecked words.
