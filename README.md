# Gauntlet

**Your AI's work runs the gauntlet: fresh blind reviewers, planted traps, and a verdict that code — not the model — decides.**

Gauntlet is an honest review loop for AI-made work. One Claude Code window (the **executor**) makes or
improves an artifact: a marketing plan, copy, slides, a report, code. Fresh, independent reviewer agents
check it in rounds. Planted errors (**canaries**) test whether the reviewers are paying attention.
Every serious finding is re-checked by other agents. And a small program, not the model that wants to be
finished, decides whether the work is **fixed, confirmed, done, or stopped**.

It is a Node 24 command-line tool with no dependencies, plus a Claude Code skill (`/gauntlet`) and an
optional Workflow script that drives it.

> Status: v1, working but young. The build specification is [docs/SPEC.md](docs/SPEC.md) (it wins over
> any other text here). The templates have not been measured on enough real runs yet; read
> [docs/honesty-limits.md](docs/honesty-limits.md) before you trust a "done".

## The problem

Ask an AI loop to improve something, grade it, and improve it again, and the grade climbs. It climbs even
when the work does not.

In the first use of this idea, a 7-round loop that graded itself reported **"panel score 9.5"** for a
social-media content plan. A blind re-check with fresh reviewers put the same plan at about **6.2**.

The post-mortem found 15 ways the loop had inflated its own score:

- the reviewers were told the threshold they had to reach;
- late prompts forbade new findings;
- the executor wrote the reviewer prompts, the "already fixed" summary and the facts file;
- scores were averaged, so one weak area hid behind four strong ones;
- the final version was edited after the last review.

Run again on fresh reviewers, the old prompt reproduced 9.5. The number was made by the prompt, not by the work.
A frozen template with no history and no threshold, a severity scale with anchors and a mandatory list of
things to inspect, caught 19 of 25 reviewer-by-planted-error pairs where the old prompt noticed 5 of 25
(5 planted errors, 5 reviewers), and it found real problems besides.

Gauntlet turns that lesson into code. Two rules carry it:

- **The loop may drive itself; it may not acquit itself.** "Done" is computed by a program from files whose
  hashes were recorded before the decision.
- **Nobody who benefits from a pass writes the instrument.** The executor never writes reviewer prompts,
  lenses, checklists, canaries, verdicts, gate decisions or report numbers.

## How it works

```text
 owner's words ──► frozen setup ──► ROUND ──────────────────────────────────────┐
 (verbatim task)   lenses written     │                                         │
                   by a separate      ├─ 1. copy the material, strip every      │
                   agent, then        │     trace of the review                 │
                   frozen by hash     ├─ 2. a planter agent hides errors        │
                                      │     (canaries) in the copy              │
                                      ├─ 3. one fresh reviewer per lens reads   │
                                      │     it, briefed by a frozen template    │
                                      ├─ 4. findings are clustered; each serious│
                                      │     one is re-checked by fresh verifiers│
                                      │     mixed with decoys and true controls │
                                      └─ 5. the gate (code) decides:            │
                                           FIX      -> executor fixes the to-do │
                                           CONFIRM  -> one more blind round     │
                                           DONE     -> re-hash the live files   │
                                           STOP     -> limits / plateau: ask    │
                                                       the owner                │
                                                         │                      │
                                  FIX / CONFIRM ─────────┴──────────────────────┘
```

1. **Task.** The owner's words are saved verbatim. Only lines about how the work is run ("repeat until the
   score is 9.5") may be cut, and what was cut is shown in the report.
2. **Lenses.** A separate agent writes 3 to 7 **lenses** from the task: each is one duty ("facts and risks",
   "language", "path to an order"), with a procedure, a checklist and a mandatory minimum of what to read.
   One lens is the **generalist**, a first reader who knows only the task. Then everything is frozen.
3. **Round.** The material is copied into a neutral random folder and stripped of review traces. A planter
   agent hides a few errors in the copy. One fresh reviewer per lens gets a prompt rendered by code from a
   frozen template. It sees no threshold, no score, no round number and no earlier findings.
4. **Checks on the checkers.** Every reviewer must catch the canary aimed at its own duty, or its review does
   not count. Every blocker and major finding goes to fresh verifiers who see neither the class nor the fix.
   Among the items they get are decoys (plausible false findings) and true controls (real planted problems).
5. **Gate.** From the verified findings of the **worst** lens (nothing is averaged) the program prints one of
   FIX, CONFIRM, DONE or STOP. `DONE` needs a clean working round, then a clean blind **confirm** round on the
   same version of the material.
6. **After done.** The program re-hashes the live files. If anything changed since the confirm round the
   result reads "edited after review", not "done".
7. **Report.** The owner gets a plain-language report generated from run files. The executor cannot add a
   score or a verdict to it.

## What makes it honest

| Mechanism | What it prevents |
|---|---|
| **Frozen templates.** Reviewer prompts are rendered by a script from templates frozen by hash. The executor never writes them, and every substituted value is linted for thresholds, "deliberate", "do not flag", "already fixed". | Steering the reviewers, directly or by wording. |
| **Stripped, neutral review copy.** Reviewers read a copy in a random folder with review traces removed. A strip rule may only delete traces; anything else needs the owner's recorded words. | Reviewers learning the round number, the target or earlier findings. |
| **Planted errors (canaries).** Chosen by the script, written by a separate planter, judged by a separate validator, applied by code, sealed by hash before the reviewers start. A lens that misses its own canary is invalid. | Reviewers that skim, and lenses that look clean because they did not read. |
| **Re-verification.** Blocker and major findings are reproduced by fresh verifiers. A verifier that cannot decide keeps the item open. | Hallucinated findings and silent dismissals. |
| **Decoys.** Plausible false findings are mixed into the verifier batches. A verifier that confirms one is not trusted, and its other confirmations are re-checked. | Verifiers that agree with everything. |
| **True controls.** Real, planted problems are mixed in too. A verifier that refutes or downgrades one is not trusted for its refutations. | Verifiers that refute everything. |
| **Code-decided gate.** FIX, CONFIRM, DONE and STOP come from the verified findings of the worst lens, plus limits and a plateau rule. No score is asked for, and score keys in answers are ignored. | Averaged-away weak spots, and the executor declaring itself done. |
| **Owner-only decisions.** Waiving a finding, narrowing a lens, raising a limit, continuing after a stop: each needs the owner's verbatim words and the exact question they answered. The report prints every one. | The executor quietly lowering the bar. |
| **Integrity audit.** Prompts, answers, canary keys, decisions and the run ledger are hash-chained and anchored outside the run folder. `audit` replays the gate. | Silent edits after the fact. Tampering is made visible; it is not made impossible. |

Each protection carries one of five labels (CODE, STRUCT, SEP, EVID, PROMPT), and the docs never claim more
than the label. The full table is in [docs/reference.md](docs/reference.md).

"Done" means the reviewers **did not find** verified serious problems. It does not mean there are none.
Reviewers are worst at noticing that something required is missing, and planted errors are easier to find
than real ones. See [docs/honesty-limits.md](docs/honesty-limits.md).

## Quick start

**Requirements**

- Node 24 or newer. No npm dependencies, no Python, and no network calls except the source recipes a run
  configures.
- [Claude Code](https://claude.com/claude-code) for the executor window and the reviewer agents. The default
  driver ("Agent mode") uses the Agent tool; the optional **Workflow** driver uses Claude Code's Workflow tool.
- Windows, macOS or Linux.

**1. Get it and check it**

```bash
git clone https://github.com/patraianton/gauntlet.git
cd gauntlet
node bin/gauntlet.mjs doctor      # Node version, template manifest, data home, ledger chains
npm test                          # unit, cheater and end-to-end tests
node bin/gauntlet.mjs selftest    # a full offline run with scripted agents, no LLM
```

**2. Install the skill and the rule** (by hand, dry run first):

```bash
node install/install.mjs          # dry run: prints every action, changes nothing
node install/install.mjs --apply  # copies the skill and one rule file, backs up what it touches
```

The installer never touches `settings.json`, permissions or hooks. `--uninstall` reverses it.

**3. Your first run.** In a Claude Code window, state the task in your own words and invoke the skill:

```text
/gauntlet  Write a 30-post Instagram plan for a small bakery. The main goal is pre-orders
           of a weekly bread box. Offer a few slide designs to choose from.
```

The skill walks the window through the steps below. The window spawns the reviewers, relays their answers,
fixes what the to-do lists, and shows you the generated summary. By hand the loop looks like this:

```bash
PL=bin/gauntlet.mjs
node $PL init --project demo --artifact-type marketing-plan --root ~/work-copies/demo/plan=content
node $PL task set <runDir> --from owner-task.txt --source 'the owner, chat'
node $PL step <runDir>            # exit 10: agents to spawn; exit 20: your turn; exit 30: stopped
node $PL done <runDir>            # after a DONE decision: re-hash the live files
node $PL report <runDir> --summary
```

Every exit code and decision is described in [docs/runbook.md](docs/runbook.md).

**4. See what a measured check looks like.** `bench/` holds a small synthetic example, the 30-post content
plan of an invented bakery with five planted errors, a key, a pass rule and a matching set of lenses. The
bench run in [docs/runbook.md](docs/runbook.md#7-the-bench-run-on-the-bench-material) shows whether your
templates and reviewers catch them (about 1.5M tokens, with the owner's consent).

## Commands

`node bin/gauntlet.mjs <command> [<runDir>] [options]`. Add `--json` for one JSON envelope on stdout.

| Command | Purpose |
|---|---|
| `init`, `task set`, `sources check` | Create a run, store the owner's words, check the primary-source recipes. |
| `step` | The state machine: does every deterministic job, then prints agent calls, a to-do, or a stop. |
| `status`, `todo` | Where the run stands; the latest to-do. |
| `dispute` | Contest a finding with evidence; judged by a dispute verifier next round. |
| `waive`, `owner`, `amend` | The owner's decisions, each with the owner's verbatim words and the question they answered. |
| `done`, `report`, `audit` | Finish after DONE, render the owner report, replay hashes, chains and the gate. |
| `restore-best`, `abort`, `cleanup` | Recover the best round, end a run, delete leftover review copies. |
| `ledger stats / add-escape / verify-chain` | The cross-run measurement ledger (recall with Clopper-Pearson intervals). |
| `templates status / approve`, `lint`, `selftest`, `doctor` | Template approval, prompt/trace lint, offline end-to-end test, environment check. |

Exit codes: `0` nothing waiting, `10` agents to spawn, `20` executor action needed, `30` stopped, `3` integrity
failure, `4` usage error, `1` internal error. Details and options: [docs/reference.md](docs/reference.md).

## Cost

About **1.8M panel tokens per round** with five lenses plus the generalist. A minimum successful run is two
rounds; a typical five-round run is about 9M tokens. Limits are on by default (`maxPanelTokens` 15M,
`maxRounds` 8) and can be raised only on the owner's recorded words.

## Limits

Gauntlet is honest about what it cannot do. In short: agents can still wander the disk; the executor types the
owner's quotes (they are all printed back in the report); persuasion inside the artifact that the trace
patterns miss can still sway reviewers; five reviewers of one model are worth fewer independent votes than
five; planted errors are easier than real ones, so recall measured on canaries is an upper bound; large data
files are read through a sample. Full list: [docs/honesty-limits.md](docs/honesty-limits.md).

## Language of the owner report

Everything in the repository is English except the owner-facing output. **The report, the summary and the
setup summary are currently generated in Russian only**, because the tool was first written for a Russian-speaking owner. The languages are examples: the report phrases live in one file and other languages can be added. Latvian (`lv`) is one of the answer languages the prompts and pattern catalogs already support. Reviewer and
verifier prompts are English, and their answers can be in any language you set (`ru`, `lv` or `en`). An
English owner report is the most useful contribution to make; see [CONTRIBUTING.md](CONTRIBUTING.md).
A plain-Russian overview for owners is in [README.ru.md](README.ru.md).

## Documentation

| File | Contents |
|---|---|
| [docs/reference.md](docs/reference.md) | What "done" means, the guarantee table, the full quick start, workflow driver, file locations, install details, cost, large data files |
| [docs/runbook.md](docs/runbook.md) | Starting a run, every exit code and decision, crash recovery, plateau, the bench run, cleanup |
| [docs/SPEC.md](docs/SPEC.md) | The normative build specification |
| [docs/architecture.md](docs/architecture.md) | Modules, data flow, the state machine, file layouts |
| [docs/failure-points.md](docs/failure-points.md) | The 15 ways the original loop inflated its score, and how each is closed |
| [docs/honesty-limits.md](docs/honesty-limits.md) | What is protected only by prompts or by evidence |
| [docs/measurement.md](docs/measurement.md) | Canaries, the ledger, intervals, how (not) to read the numbers |
| [docs/roadmap.md](docs/roadmap.md) | v1 / v2 / v3 |
| [docs/CREDITS.md](docs/CREDITS.md) | Sources of ideas and wording |

## Licence

[MIT](LICENSE). Ideas and adapted wording from other open-source work are credited in
[docs/CREDITS.md](docs/CREDITS.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
