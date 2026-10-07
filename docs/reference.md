# Reference

The detailed reference that used to be the top of the README: what "done" means, the guarantee table, the
step-by-step quick start with every option, the Workflow driver, the command list, file locations,
installation, cost and large data files. The short introduction is in [../README.md](../README.md).
If anything here disagrees with [SPEC.md](SPEC.md), the spec wins.

## What "done" means

`DONE` needs **two clean rounds in a row on the same version of the material**: a working round
(the candidate) and then a confirm round, which is the blind final: a fresh panel, fresh planted
errors of different types, and two verifiers per item. "Clean" means:

- every lens (reviewer duty) answered validly: read receipts correct, every item of the mandatory
  minimum done (an item marked "not done" makes the answer invalid), every owner requirement marked;
- every lens caught its own attention canary (a planted error aimed at that duty);
- zero open **verified** blockers or majors in **any** lens (the worst lens decides; nothing is
  averaged);
- no pending dispute.

After `DONE`, the `done` command re-hashes the live files. If anything changed since the confirm
round, the result is reported as "edited after review", not done.

"Done" means the reviewers **did not find** verified serious problems. It does not mean there are
none. Reviewers are worst at noticing that something required is missing, and planted errors are
easier to find than real ones.

**Verifiers are tested too.** Verifiers almost never refuse an item (in two early runs: 55 of 66 and 103 of 108
confirmed). Each round a separate agent writes a few plausible but false findings, each with a quote from the copy
that proves it false; code checks them and mixes them into the verifier batches so they look like real items. The
report says how many the verifiers refused («Перепроверка отклонила X из Y заведомо ложных замечаний»), the
cross-run ledger counts them with Clopper-Pearson bounds, and a verifier that confirms one is not trusted: its
other confirmations in that batch are re-checked by a fresh verifier. Decoys never become clusters, so they never
reach `todo.md` or the owner's open problems (SPEC 14.11).

**Verifiers are tested for the opposite failure too.** A verifier that refutes everything would score perfectly on
decoys. So the reviewer findings that the matcher matched to a planted error this round (real problems, certainly in
the copy) are mixed into the verifier batches as true controls, in the reviewer's own words. A verifier that refutes
or downgrades one is not trusted for its refutations or for confirmations that make a serious item cosmetic: a fresh verifier re-checks them. The report says in plain
Russian how many real planted problems the verifiers wrongly dismissed; controls never become clusters (SPEC 14.12).

## Guarantees and their enforcement levels

Every protection carries one of five labels. The docs never claim more than the label.

| Level | Meaning |
|---|---|
| CODE | A script refuses or decides, fail-closed. Bypassing it needs editing the script or forging a hash. |
| STRUCT | The input simply does not contain the thing. |
| SEP | A separate fresh agent, briefed only by code, does the step. |
| EVID | Possible to do, impossible to do silently (hash chain, write-once files, anchors, the report shows it). |
| PROMPT | Instruction only. |

| Guarantee | Level |
|---|---|
| Reviewer prompts are rendered by a script from templates frozen by hash; the executor never writes them; every substituted value is linted for thresholds, "deliberate", "do not flag", "already fixed" and similar (the owner's product words such as «оценка стоимости» are not loop control and stay) | CODE + STRUCT |
| Reviewers never see a threshold, a score, a round number, prior findings or the owner's target; the review copy is a stripped copy in a neutral random folder (a review base checked to be away from run folders, keys and the data home) and is scanned for review traces | CODE + STRUCT |
| What strip rules and the rebuild change in the reviewers' copy is checked before freeze: a rule may only delete review traces; anything else, and a rebuild whose output differs from the material, needs the owner's quote or is refused; the same checks run again on every round's copy; every rule and each round's exclusions are listed in SETUP-SUMMARY and the report | CODE + EVID |
| Primary sources: recipes run at setup and every round (a failing one blocks the round); a source that reads a file inside the material, the run folder or the project folder, or one written during the run, is refused, and so is a recipe with inline code (`node -e`, `python -c`), a `file:` URL or a loopback host; each source's stated origin is shown to the owner | CODE + EVID (origins are the executor's words; a script written earlier elsewhere that prints constants is visible only) |
| A recipe that reads something that moves during the run (a git branch, `HEAD`, an abbreviated hash, a `git log` without a pinned range, a file inside the executor's own git working tree) is flagged by its shape and kept only on the owner's words; the pinned form is `git -C <repo> show <full-hash>:<path>`. A source that blocks the reviewers (HTTP 429, captcha) is documented as unavailable instead of making the lens invalid, and is named in the to-do, the ledger and the report | CODE + EVID (the reviewer's "unavailable" is its own documented claim) |
| No score is asked for; score keys in answers are ignored and logged; decisions use verified blocker/major counts of the worst lens | CODE + STRUCT |
| Lenses, checklists and the mandatory minimum are written once by a separate lens-writer agent from the owner's verbatim task, then frozen | SEP + CODE |
| Every file of the material is covered by some lens minimum, at setup and at every round start; every lens has a glob rule, so read receipts always exist and prove reading; an empty, unparsable or cross-field-invalid answer is a failed review, never a clean one | CODE |
| Planted errors are chosen by the script, written by a separate planter, judged by a separate validator, applied by code; the key, the slots, the planter's and validator's answers and prompts stay in the sealed data-home folder until reveal, with only their hashes in the run folder; the key is committed by hash before reviewers start | CODE + SEP (+ PROMPT: a reviewer that searches the whole disk could still find them) |
| Blocker and major findings are reproduced by fresh verifiers who never see the reviewer's class, lens or fix; a verifier that cannot decide keeps the item open; two confirming verifiers who differ on the class keep the stricter one | SEP + CODE |
| False findings (decoys) written by a separate agent with a proof quote from the copy, checked by code, kept sealed in the data home until the round closes, mixed into the verifier batches in the shape of real items; a verifier that confirms one is untrusted and its other confirmations are re-checked by a fresh verifier; decoys never become clusters; refused / shown is reported and counted in the ledger | SEP + CODE + EVID (a decoy that is in truth right is confirmed by an honest verifier: limit 25) |
| True controls: reviewer findings matched to planted errors are mixed into the verifier batches as ordinary-looking items, their key committed before any verifier is asked and sealed until the round closes; a verifier that refutes or downgrades one is untrusted for its refutations and for confirmations that make a serious item cosmetic, and a fresh verifier re-checks them; controls never become clusters; dismissed / shown is reported and counted in the ledger | CODE + EVID (a control is easier to confirm than an unnoticed defect: limit 26) |
| The executor cannot close a finding: only verifiers, two agreeing dispute verifiers or the owner's quoted words can; `clusters.json` and every round and ingest file are hashed when a command ends and checked by the next one (an edit in between is TAMPER); a reviewer answer whose code does not match keeps its findings and the lens is reviewed again | CODE in Workflow mode; EVID in Agent mode (the window relays the codes and could compute them; unbound and rejected answers are counted in the summary) |
| Findings are clustered only on overlapping quotes or the same requirement, never on the place alone; a cluster is verified on its most serious claim | CODE |
| Removing or narrowing a lens, checklist item, source (or changing one), root, include glob, author note or task line needs the owner's quote (also the first `task set`: a cut line that is not loop control); waivers only after a stop report; abort or a new run on the same material while verified problems are open only on the owner's words, and the new run shows the old run's open problems; `amend --what lenses` installs a lens file the executor wrote, so it is EVID, not SEP | CODE + EVID |
| `DONE` is bound to the confirm round's version hash and needs a passing audit; `done`, `status`, `audit`, the report and the summary flag later edits as unreviewed; the owner's waivers and other decisions turn «Готово» into «Готово с вашими исключениями» | CODE + EVID (detection, not prevention) |
| A large data file (a `.csv .tsv .jsonl .ndjson` table or a `.json` array over 1 MiB or 2 000 rows) is reviewed through a random sample of its rows (200 by default) that the program draws after the snapshot, seals with the canary key and draws anew every round; planted errors in it sit only in sampled rows, the reviewers' "every row" minimums over it are rewritten by code to "every sampled row + every summary number in the prose files", read checks come from sampled rows, and the report says how many rows were seen out of how many | CODE + EVID (that reviewers read the sampled rows is PROMPT backed by the read checks; errors outside the sample can stay: limit 24) |
| Prompts, answers, canary keys, decisions and the run ledger are hash-chained and anchored in the data home; `audit` replays the gate | EVID |
| Stops: worst lens; round, confirm-round and token limits (panel tokens included); plateau (two working rounds in a row that reached the reviewers, even if a lens was invalid in them, without fewer open serious problems than the best before them; clean, CONFIRM and DONE still need every lens valid) stops and escalates to the owner; limits looser than the defaults need the owner's words; the best version is kept, not the last (fewest verified blockers, then majors, over every round that reached the reviewers, whatever the lenses' validity; the summary says when that round was not fully checked); blocked attempts (`BLOCKED_*`) hold a round folder number but are not rounds and count nowhere | CODE (the token limit on self-reported numbers in Agent mode; tiny or missing numbers are replaced by the estimate) |

What is **not** enforced (agents have filesystem access, the executor types the owner's words, the
system is tamper-evident rather than tamper-proof, same-model panels share blind spots) is listed in
[docs/honesty-limits.md](honesty-limits.md).

## Requirements

- Node 24 or newer. No npm dependencies, no Python, no network calls from scripts except the source
  recipes a run configures.
- Windows (Git Bash or PowerShell 7), macOS and Linux. Paths in the examples below are Windows
  paths; on macOS and Linux use the same commands with POSIX paths.
- A Claude Code window to act as the executor. Subagents run on Sonnet with effort `high` unless the
  owner opted in to another model in the owner's own words.

Check the installation:

```powershell
cd C:\src\gauntlet
node bin/gauntlet.mjs doctor      # Node version, template manifest, data home, ledger chains
npm test                            # unit, cheater and end-to-end tests
node bin/gauntlet.mjs selftest    # full offline run with scripted agents, no LLM
```

## Quick start (Agent mode, the default)

In a Claude Code window, the `/gauntlet` skill walks through these steps. By hand they look like
this (PowerShell; in Git Bash or a POSIX shell use `/c/Users/...` or `/home/...` paths and `\` line continuations):

```powershell
$PL = 'C:\src\gauntlet\bin\gauntlet.mjs'

# 1. Save the owner's words verbatim to a file (owner-task.txt). Do not paraphrase them.

# 2. Create the run. Declare broad roots: the whole output folder, not a hand-picked subset.
node $PL init --project demo-project --artifact-type marketing-plan `
  --root 'C:\Users\you\work-copies\demo-project\content-plan=content' `
  --notes content/AUTHOR-NOTES.md
#    -> run folder, e.g. C:\Users\you\work-copies\demo-project\gauntlet-runs\20260115-0930-a1b2c3
$RUN = 'C:\Users\you\work-copies\demo-project\gauntlet-runs\20260115-0930-a1b2c3'

# 3. Copy the task. Cut only loop-control lines ("until the panel gives 9.5"), by line number.
node $PL task set $RUN --from owner-task.txt --cut 4 --source 'the owner, 2026-10-06, chat'

# 4. Write sources.json, strip.json and mechanical.json into the run folder; edit run.json
#    (driver, rebuild, limits) now: after freeze only `amend` can change them.
#    Examples: docs/runbook.md, section 1.
node $PL sources check $RUN         # every source recipe must return data

# 5. Setup: the first step prints the lens-writer call; the second freezes.
node $PL step $RUN                  # exit 10: spawn the printed call
node $PL step $RUN                  # exit 20: READY; SETUP-SUMMARY.ru.md written

# 6. The loop.
node $PL step $RUN                  # exit 10: spawn EVERY printed call in ONE message, in parallel
node $PL step $RUN --answer-hash ab3k9mpq=3f2a9c0b1d4e5f60,c7dr2wnx=0b1d4e5f603f2a9c --usage ab3k9mpq=182000,c7dr2wnx=171500
#    --answer-hash: the code each agent replied after DONE; --usage: each agent's total tokens
#    exit 20 -> act on the to-do (fix only what it lists; on CONFIRM change nothing), then step
#    exit 30 -> stopped; show the owner the summary and stop

# 7. After the decision DONE:
node $PL done $RUN                  # re-hashes the live files; equal -> "готово"
node $PL report $RUN --summary      # the 5 plain-Russian lines for the owner
```

Rules for the window in Agent mode:

- Spawn each printed call with the Agent tool, `subagent_type: "general-purpose"`, the prompt
  **exactly** as printed (one fixed line pointing at a `PROMPT.md`), `model` only when the job lists
  one. Each agent replies `DONE <answer code>`; pass the codes to the next `step` with
  `--answer-hash <job>=<code>,...`.
- Read only `step` output, `todo.md` and the report. Never open reviewer answers
  (`rounds/*/answers/`) before the round closes, and never open the data home's `sealed\` folder.
- Never edit the material while a round runs or after a clean round.
- Record owner decisions (`waive`, `owner`, a narrowing `amend`) only with the owner's exact words and the exact question you asked the owner (`--question`); never reuse one quote for a different decision (the report flags it). Messages starting with «[Dispatcher, not the owner]» are the dispatcher window's, never the owner's words.

Exit codes: `0` nothing waiting, `10` agents to spawn, `20` executor action needed, `30` stopped with
the report written, `3` integrity failure, `4` usage error, `1` internal error. What to do for each
one, and for every gate decision, is in [docs/runbook.md](runbook.md).

## Optional: the Workflow driver

`workflows/gauntlet.workflow.js` drives the same `step` state machine through the Claude Code
Workflow tool, so the executor does not type spawn messages and panel tokens are measured by the
Workflow budget. It runs only with the owner's recorded opt-in (`run.json.driver.mode: "workflow"`
with the owner's quote, written before freeze); `step --driver workflow` refuses without it.

```text
Workflow tool:
  scriptPath: C:\src\gauntlet\workflows\gauntlet.workflow.js
  args: { cli: "C:\\src\\gauntlet\\bin\\gauntlet.mjs",
          run: "<run folder>", maxSteps: 60 }
```

A cheap "clerk" agent runs `step --json`; the script recomputes the payload checksum with an
inlined pure-JS SHA-256 (it catches a clerk's copying errors, not a clerk that invents a payload),
accepts only job calls of the one fixed shape, spawns the printed jobs in parallel with
`effort: 'high'`, and relays every agent's answer code. The script reports only the tokens its own agents
and clerk calls spent (`--usage-delta`, measured around each batch), never the turn's total, so the
window's own work before the workflow is not booked as panel spending. What it does **not** add in v1: the
canary key is still sealed on disk, and agents still have filesystem access.

## Commands

All commands: `node bin/gauntlet.mjs <command> [<runDir>] [options]`. Add `--json` for one JSON
envelope `{ok, exitCode, command, state, payload, sig}` on stdout.

| Command | Purpose |
|---|---|
| `init` | Create a run folder and `run.json`; copy the templates with their hashes (`--supersede <runId>` replaces an unfinished run only with `--owner-quote` and `--question`) |
| `templates status` / `templates approve` | Show whether the reviewer templates are approved by the owner; approve them only with `--owner-quote` and `--question` |
| `task set` | Store the owner's words verbatim (`OWNER-TASK.md`) and the rendered task (`TASK.md`, whole lines cut only; cutting a requirement line needs `--owner-quote` and `--question`) |
| `sources check` | Run the source recipes and show their results |
| `step` | The state machine: do every deterministic job, then print agent calls, a to-do, or a stop (`--owner-quote` with `--question` where the owner agreed to exactly what the to-do shows) |
| `status`, `todo` | Where the run stands; reprint the latest to-do |
| `dispute` | Contest a finding with evidence (a command output or an exact quote); judged by a dispute verifier next round |
| `waive`, `owner` | Record the owner's decisions with the owner's verbatim words and the exact question the owner answered (`--owner-quote` and `--question`, both always required): waive findings (only after a stop report), continue, raise a limit, stop, allow a model |
| `amend` | Change frozen settings between rounds (narrowing needs `--owner-quote` and `--question`; clears the candidate) |
| `done` | After `DONE`: re-hash the live files, run the audit and finish (refused on a failed audit and for a bench run) |
| `report` | Re-run the audit and re-render `REPORT.ru.md`; `--summary` prints the summary lines; `--bench <rule>` prints the bench verdict |
| `audit` | Replay hashes, chains and the gate; exit 3 on any failure |
| `restore-best` | Copy the best round's snapshot to a folder, or make a live root equal to it (`--owner-quote` and `--question` required) |
| `abort`, `cleanup` | End a run (mid-round, with serious problems open, unverified or contested, or after a plateau, a limit or an inconclusive stop: only with `--owner-quote` and `--question`; a run still in setup with nothing open needs no words); delete leftover review copies and old snapshots |
| `lint` | Run the prompt, trace or report lint over one file |
| `ledger stats` / `import-legacy` / `add-escape` / `verify-chain` | The cross-run measurement ledger (`add-escape` needs `--owner-quote` and `--question`) |
| `selftest`, `doctor` | Offline end-to-end test; environment check |

## Where files live

| What | Default location (`~` = your home folder) |
|---|---|
| Repository | wherever you cloned it (examples use `C:\src\gauntlet`) |
| Data home (anchors, runs index, sealed keys, measurement ledger) | `~/gauntlet-data` (env `GAUNTLET_DATA` overrides) |
| Run roots (where project folders and run folders may live) | `~/work-copies` (env `GAUNTLET_RUN_ROOTS` overrides; see below) |
| Project folder | `<run root>/<project>/` (`init --project-dir <dir>` overrides) |
| Run folder | `<projectDir>/gauntlet-runs/<runId>/` |
| Review copies (deleted at round close) | `<run root>/_wc/<8 random chars>/` (away from run folders) |
| Owner report copy | `<projectDir>/reports/gauntlet-<runId>.ru.md` |
| Skill after install | `~/.claude/skills/gauntlet/` |
| Rule after install | `~/.claude/rules/gauntlet.md` |

**Run roots.** `init` refuses a run folder that is not strictly inside an allowed run root, so that
runs never live inside the material they review. The allow-list is the env var `GAUNTLET_RUN_ROOTS`:
folders separated by `;` (on macOS and Linux `:` also works); the entry `*` allows any folder (the
checks that keep the run, the review copies and the data home away from the material still apply). The
default is the single folder `~/work-copies`. The review base must not carry the tool's name or words
like "review" or "round" in its path, so the default `~/work-copies/_wc` is deliberately neutral.

Layouts of the run folder and data home: [docs/architecture.md](architecture.md).

## Install the skill and rule (by hand only)

Nothing is installed automatically. The install script copies the skill and the rule file and adds
one `@` include line to `CLAUDE.md` files. Run the dry run first and read its plan:

```powershell
node install/install.mjs                       # dry run (default): prints every action, changes nothing
node install/install.mjs --apply               # performs the plan; backs up each file first (*.bak-YYYYMMDD-gauntlet)
node install/install.mjs --uninstall           # dry run of the reversal: prints it, changes nothing
node install/install.mjs --uninstall --apply   # reverses from the backups
```

If you use several Claude Code config folders (`CLAUDE_CONFIG_DIR`), install into one of them only:

```bash
node install/install.mjs --home <config folder>           # dry run for that home
node install/install.mjs --home <config folder> --apply
```

To let the installer find all such folders, set `GAUNTLET_CLAUDE_HOMES_DIR` to a folder whose
subfolders are the config homes.

Nothing changes without `--apply`, for install and uninstall alike. Targets: the skill goes to
`~/.claude/skills/gauntlet/` (extra homes under `GAUNTLET_CLAUDE_HOMES_DIR` whose `skills` folder links to
the same place are not copied twice); the rule goes to `~/.claude/rules/gauntlet.md`; the include
`@~/.claude/rules/gauntlet.md` is appended to `~/.claude/CLAUDE.md` and to the `CLAUDE.md` of each
extra home that lacks it. With `--home <config folder>` everything goes into that home only — the skill,
`<home>/rules/gauntlet.md` and an include pointing at it — and `~/.claude` is not touched. `--home` is
refused for a home whose `skills` folder is a link to `~/.claude/skills`. Every installed file carries a gauntlet signature line, so an
upgrade replaces the earlier copy without a backup and uninstall removes it instead of restoring an old
version. The script never touches `settings.json`, permissions or hooks.

The rule file is loaded into every Claude session, the run's reviewers included, so it holds only
"use the /gauntlet skill, report only the generated summary" and nothing about how the loop checks
its reviewers (a test and `doctor` enforce that); it is addressed to the window that makes the work,
tells agents of a gauntlet job to ignore it, and gives way to a project's own review procedure. The
never-list lives in the skill.

## Cost

- About **1.8M panel tokens per round** with 5 lenses plus the generalist (setup summary estimate:
  `lenses × 0.23M + 0.5M` per round). For reference, in the blind experiment five reviewers on the new template used
  1.15M tokens, against 0.55M on the old prompt.
- A minimum successful run is 2 rounds (candidate + confirm); a typical 5-round run is about 9M, a hard
  artifact about 10M or more — close to the post-mortem's options Б (≈11M) and В (≈12–13M), not to "A".
- **Deviation from proposal "A" of the post-mortem.** "A" had lighter working rounds and planted errors
  only in the blind final, at about 5.8M tokens per cycle. gauntlet runs **every round in the full
  blind shape** (fresh reviewers, the full template, planted errors, verification), at about 1.8M per
  round: a lighter working round would let the old failure points back in between finals (the
  executor's steering, unverified "fixed" claims), and the per-lens attention check needs a planted
  error every round. A lighter working-round mode is not offered in v1.
- Default limits: `maxPanelTokens` 15M (panel tokens, not just the executor's), `maxRounds` 8 working
  rounds (a confirm round is counted by `maxConfirms` instead), `maxConfirms` 2. A round that would
  cross the token cap is not started (`STOP_LIMIT`). Research
  item 20 suggests changing the reviewer make-up every 3–4 rounds; v1 keeps the lens set frozen for the
  whole run (only the reviewers are fresh), so long runs may lose sharpness after round 4 — a reason
  to stop and ask rather than raise `maxRounds` (rotation of the lens procedure order is v2).
- Before freeze, any limit set looser than its default needs `limitsOptIn` with the owner's words and the question that was answered in
  `run.json` (code refuses the freeze otherwise) and is printed in SETUP-SUMMARY and the summary. After
  freeze only `maxRounds`, `maxConfirms` and `maxPanelTokens` can be raised, upward only, on the
  owner's words (`owner --kind raise-limit`); the plateau patience and the other protections stay frozen.
- The bench run on the bench material costs about 1.5M and runs only with the owner's consent.

In Agent mode token numbers are self-reported by the window; missing numbers, and numbers below a quarter
of the per-agent estimate, are replaced by the estimate and marked as such in the report. In Workflow mode they are
measured (except the last clerk call of each invocation).

## Large data files

Reviewers cannot read a 50 MB table, and in one long run they were told to ("read every row
of every evidence file"): the planted errors were caught 15 of 36, then 11 of 42 times. So a data file
over `limits.sampleThresholdBytes` (1 MiB) or `limits.sampleThresholdRows` (2 000) is reviewed through a
sample (SPEC 14.10, D40): at each round start the program draws the header plus `limits.sampleRows`
(200) rows at random (at most `limits.sampleMaxBytes` = 100 000 characters of rows once 20 are in, and `limits.sampleTotalBytes` = 250 000 over all large files together),
adds every row a planted error sits in, seals the selection with the canary key and shows the reviewers
only those rows, in `SAMPLE-<k>.md` next to their prompt. Smaller thresholds or samples need
`limitsOptIn`; bigger sample sizes are free (a raised threshold is not: any threshold above 1 MiB / 2 000 rows needs `limitsOptIn` too, because it would stop sampling for files reviewers cannot read whole). The trace scan reads a large data file with every pattern on its prose-like values and with the unambiguous patterns on short ones; SETUP-SUMMARY and the report count both. Prose, code and small tables are reviewed whole as before. The
report states «проверяющие видели выборку N строк из M; ошибки вне выборки могли остаться». A big file that cannot be sampled (a JSON object, XML, SQL, text, log) is listed in the reviewer prompt as too big to read whole (check the structure, spot-check) and in report section 7 as not checked whole; many small files of one kind in one folder that together are over 4 x the file threshold are treated as one data set. Details:
[docs/runbook.md](runbook.md) section 1.3, [docs/honesty-limits.md](honesty-limits.md) limit 24.

## Limits (short)

gauntlet v1 is honest about what it cannot do. In short: agents can still wander the disk; the
executor types the owner's quotes (they are all printed back in the report); persuasion inside the
artifact that the trace patterns miss can still sway reviewers; five reviewers of one model are worth
fewer independent votes than five (nine judges from seven vendors gave about two; ours is not
measured); planted errors are easier than real ones, so ledger recall is an upper bound; large data
files are read through a sample, so errors in the other rows can stay. Full list:
[docs/honesty-limits.md](honesty-limits.md).
