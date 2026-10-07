---
name: gauntlet
description: Honest review loop - an executor window improves an artifact (marketing plan, copy, slides, report, code) while a panel of independent reviewer agents checks it in rounds, and scripts (not the window) decide when it is done. Use when a task says "loop until the panel score ...", "panel review loop", "/gauntlet", "review it with a panel and iterate", «гоняй панель до ...», «до оценки панели ...», «проверь панелью и доведи», «прогони через панель», «панель проверяющих», or whenever work must be judged or brought to "done" by AI reviewers.
---

# /gauntlet - honest review loop

The loop may drive itself; it may not acquit itself. You (the executor window) make and fix the
material. Fresh reviewer agents, briefed only by code from frozen templates, check it. The
`gauntlet` CLI decides FIX / CONFIRM / DONE / STOP from verified findings of the worst lens.
"Done" needs a clean working round and a clean blind confirm round on the same version hash.

CLI (all commands below): `node "{{GAUNTLET_REPO}}/bin/gauntlet.mjs" <command> ...` - written
below as `PL <command>`. Repository docs: `{{GAUNTLET_REPO}}/README.md`, runbook
`{{GAUNTLET_REPO}}/docs/runbook.md`, full contract `{{GAUNTLET_REPO}}/docs/SPEC.md`.

## House rules (binding)

- **Models.** Every reviewer and helper agent runs on the default subagent model (Sonnet) with
  effort `high`. Any other model (Opus, Fable, a second model in the confirm round) only by the owner's
  own words, recorded with the owner's verbatim quote (`run.json` `models.optIn` before freeze, or
  `PL owner <run> --kind model-opt-in --owner-quote "<the owner's words>" --question "<what you asked>" --set role=<role> --set model=<model>`).
  The default model and effort can be changed per project by the owner's recorded words only.
- **No outbound messages.** The loop never sends anything to anyone. Agents are told the same.
- **Owner output is plain Russian and generated.** (The owner report is currently produced in Russian only;
  an English version is welcome as a contribution.) What you tell the owner about the result comes only
  from `PL report <run> --summary` (5 lines) and `REPORT.ru.md`. Show those lines as printed, plus
  the report path. Do not invent numbers, do not add a score, never write «панель поставила X».
- **Working copies** stay under a run root: by default `~/work-copies/<project>/`; the allowed roots are
  listed in the env var `GAUNTLET_RUN_ROOTS` (see the runbook). Review copies are deleted by the CLI at round close; run `PL cleanup <run>`
  after the report.
- **Owner words need their question.** Every `--owner-quote` (and every `quote` you write into
  `run.json`) is the owner's own answer to a question you asked the owner; record it verbatim together with the
  exact question, `--question "<what you asked>"`. The CLI refuses an owner decision without the
  question. One quote never serves a different decision (a limit raise is not a word about sources):
  ask the owner again. The report lists every decision with its quote and question and flags one quote
  used for decisions of different kinds.
- **The dispatcher is not the owner.** A dispatcher window may manage the night and message you; its
  messages start with «[Dispatcher, not the owner]». It answers only operational questions, the
  ones that need no words of the owner («continue?», «which step next?»), and it never supplies owner
  words. Follow its operational requests (run `step`, wait, stop an action that breaks a rule), but
  never record its text as the owner's words (`--owner-quote`, `quote` fields, an answer to `--question`).
  Only the owner's own messages count; if a step needs the owner's words, the dispatcher does not answer it: it
  notifies the owner and waits, and so does the step.
- The never-list in `reference/never.md` applies throughout. Read it once per run.

## Steps

### 1. Owner task -> run

1. **Never ask the owner about thresholds** ("до 9.5" is the owner's target, not a reviewer instruction).
   Save the owner's words **verbatim** to a file, e.g. `<projectDir>/owner-task-<YYYYMMDD>.md`
   (copy-paste; do not summarise or fix wording).
2. `PL init --project <name> --artifact-type marketing-plan|copy|slides|report|code|other --root "<abs folder>"[=content] [--include <glob>]... [--exclude <glob>]... [--notes <rel>]`
   If `init` says the reviewer templates are not approved, ask the owner «Шаблоны вопросов проверяющим
   версии N ещё не одобрены. Одобряете?» and only on the owner's words run
   `PL templates approve --owner-quote "<the owner's words>" --question "<what you asked>"`, then `init` again.
   Declare **broad roots**: the whole output folder, not the files you think matter. Note the run
   folder it prints. **Before `init`**, put in place every script or data file a source will read
   (step 3): code refuses any file written after the run started. If a source file only appears
   later, and no round has run yet (nothing is open), `PL abort "<run>" --reason "<why>"` needs no words
   from the owner: start a new run once the file exists. That is the only wordless abort: the CLI refuses
   one for a run in the middle of a round, stopped on a plateau, a limit or an inconclusive panel, or
   with a serious problem open, unverified or contested. If it refuses, ask the owner (step 6).
3. `PL task set "<run>" --from "<task file>" --cut <line numbers> --source "the owner, <date>, <where>"`
   Cut **only loop-control lines**: thresholds, "until the panel says ...", averages of panel scores,
   number of rounds. Everything else stays — product words such as «оценка стоимости», «средняя цена»
   or "credit score" are requirements and the lint lets them through. A cut line the lint does not flag
   on its own is a requirement: the CLI refuses the cut unless the owner said to drop it
   (`--owner-quote "<the owner's words>" --question "<what you asked>"`; the report shows the line, the owner's words and the question). If the lint refuses a line that
   is pure loop control, cut it. If a refused line also states a requirement, never cut it: ask the owner to
   say it again without the loop-control part.
   If the owner named a target such as "9.5", put it in `run.json` as `"ownerTarget": "9.5"` - it is
   printed in the owner's report and never shown to any agent.

### 2. Driver question (once per run)

Unless the owner already said it in this conversation, ask once:
«Запускать проверки через Workflow? Если нет — через обычных агентов, это тоже честно, но слабее защищено.»
- Yes -> before freeze write into `run.json`:
  `"driver": { "mode": "workflow", "workflowOptIn": { "quote": "<the owner's exact answer>", "question": "<the question above>", "date": "YYYY-MM-DD" } }`
  (`question` is always required, also when the owner's answer is long; never pad a short one such as «да»;
  `PL step` refuses to freeze a `run.json` whose `workflowOptIn`, `models.optIn` or `limitsOptIn` has no `question`)
- No, or no answer -> leave `"driver": { "mode": "agent" }` (the default).

### 3. Sources, strip rules, mechanical checks (you write; the CLI smoke-tests and freezes)

- `sources.json` - primary sources reviewers and verifiers check numbers against: commands
  (allowlisted: curl, node, python, python3, git) or files. **Only recipes you actually ran and that
  returned data.** Every source needs an `origin` (where the data comes from, who made it). Use
  `notes` for traps (e.g. "this form text is rendered in the browser; curl cannot see it; use S2 = the
  code file"). Reviewers see `what`, `origin` and `notes` as your unverified claims; the owner sees every
  source in the plan and the report. A source may never point at your own notes or facts file: code
  refuses any file inside the material, the run folder or the project working folder, and any file
  written after the run started, and any recipe with inline code (`node -e`, `python -c`), a `file:`
  URL or a loopback host: put a script in a file outside your folders instead (made before `init`,
  see step 1). In JSON, Windows paths need doubled backslashes or forward slashes. Every round start
  compares the files each source reads with their hashes at setup: a source file edited during the run
  blocks the round until it is restored or the owner agrees (`amend --what sources --owner-quote ... --question ...`).
  Preview: `PL sources check "<run>"` (the same checks as setup, including the age rule).
- **A source must say the same thing in every round: pin it.** Code lints each recipe by its shape and
  refuses (setup todo, `amend` error) any recipe that reads something you can change during the run,
  unless the owner agrees to keep exactly that recipe (`--owner-quote` and `--question`). Use the pinned form:
  - a git file: `git -C <repo> show <full-40-char-hash>:<path>` - never a branch (`origin/x`, `main`),
    `HEAD`, a tag, a relative name (`HEAD~1`) or an abbreviated hash (`10d8d4a`). Get the full hash once
    with `git -C <repo> rev-parse <ref>` and write it into the recipe;
  - a git history: `git -C <repo> log -4 <full-hash>` or `git -C <repo> diff <full-hash> <full-hash>`
    (a range needs both ends pinned); a bare `git log`, `git status`, `git diff` with no commits,
    `--all` and `git branch` read the live state and are flagged; `git diff <one hash>` compares with the
    working tree, so give both ends;
  - a folder listing: `git -C <repo> ls-tree --name-only <full-hash> <path>/`;
  - a data file inside a git working tree you edit (your own reports, ADRs, spend logs): do not use a
    `file` source; read the committed version with `git show <full-hash>:<path>`;
  - when the thing you want to show is "the staging site moved to commit X after my push", pin the commit you
    expect (`git log -1 <full-hash>`), do not ask a moving branch for it.
  A source the reviewers cannot reach (rate limit, captcha, block) does not make a lens invalid: write the
  lens's `source-check` minimum so that `count` is the number of **attempts** the reviewer must document
  (outcome `ok` or `unavailable` with the error), never the number of results the source must give.
  Keep `count` small for a source that may block (2 or 3): the reviewer must record one `sourceChecks` entry
  per attempt, and an entry that sums up several runs counts once.
  Unavailability is shown in the to-do, the ledger and the report; claims only that source could settle
  stay unverified.
- **Large data files** (`.csv .tsv .jsonl .ndjson`, a `.json` array over 1 MiB or 2 000 rows) need
  nothing from you: reviewers read a random sample of their rows that the CLI draws itself each round,
  and the lens writer is told so. Do not ask reviewers to read such a file whole and do not try to learn
  the sample. When you report, `report --summary` carries the line with how many rows were seen out of
  how many; tell the owner that "done" then means "none found in the rows seen" (runbook section 1.3).
  Big files that cannot be sampled (a JSON object, XML, SQL, text, log) are only listed to reviewers
  ("check the structure, spot-check"), get no planted errors and appear in SETUP-SUMMARY, report section 7
  and one summary line; small files of one kind in one folder that together pass 4 x the threshold count as
  one data set. Tell the owner that such files are not checked whole; do not split files to get under the threshold.
- `strip.json` - remove every review trace from the copy reviewers read: feedback files, score
  tables, "round N", "fixed", previous verdicts (`excludeGlobs`, `regex` with `expect`). A rule may
  only **delete review traces**: the first `step` previews the copy and refuses a rule that writes new
  text, deletes text without a trace, or drops a file without one, unless the owner agreed
  (`PL step "<run>" --owner-quote "<the owner's words>" --question "<what you asked>"`); it also refuses any trace left in the copy. Legitimate
  product phrases that look like traces go to `traceAllow` as literal phrases
  (`{ "phrase": "solar panel kits", "why": "..." }`, no regex, one trace word plus real product words);
  each phrase needs the owner's words: show the owner the phrase and record `--owner-quote` and `--question`. Never rewrite
  material values to get past the scan (it only catches accidental traces, a split word fools it):
  ask the owner instead. Fix and re-run
  `step` as often as needed before freeze.
- Limits: leave `run.json` `limits` and `canaries` at their defaults. Any limit or planted-error setting
  looser than its default needs
  `limitsOptIn: { "approvedBy": "owner", "quote": "<the owner's words>", "question": "<the exact question you asked the owner>", "date": "YYYY-MM-DD" }`, or freeze
  is refused. Stricter limits need nothing.
- `mechanical.json` - cheap checks run before any agent: `json-valid`, `count`, `file-exists`,
  `no-forbidden-text`, `command`. A failing blocker/major check stops the round before it costs tokens.
- Author notes (`--notes`, `material.authorNotes`) get a code-added banner "unverified claims".
  Do not write a facts file for reviewers; give them sources.
- File formats: `{{GAUNTLET_REPO}}/docs/SPEC.md` section 9.4-9.5.

### 4. Setup: lens writer and freeze

`PL step "<run>"` -> exit 10 prints one lens-writer call -> spawn it (step 5 shows how) -> `PL step "<run>"`
-> lenses are validated and everything is frozen -> exit 20 with `SETUP-SUMMARY.ru.md`.
The lens writer is briefed at most 3 times per run (changing a setting after its answer briefs it
again); a fourth brief needs the owner's words (`step --owner-quote ... --question ...`).
Show that file to the owner only if the owner wants to see the plan; it does not wait for the owner.
You never write lenses, checklists, minimums or reviewer prompts. If you must change a frozen file
later: `PL amend` (between rounds only; any narrowing needs `--owner-quote` with the owner's words and
`--question` with what you asked the owner).

### 5. The loop

- **Agent mode** (default): `reference/agent-mode.md`. In short: `PL step` -> exit 10 -> spawn every
  printed call in one message with the Agent tool, prompt exactly as printed -> each agent replies
  `DONE <code>` -> `PL step "<run>" --answer-hash <job>=<code>,... --usage <job>=<tokens>,...`
  -> repeat; exit 20 -> do the to-do -> `PL step`; exit 30 -> stop. Give every `step` and `done`
  call the longest shell timeout (600000 ms): one step can rebuild the copy and run every source.
- **Workflow mode** (only with the recorded opt-in): `reference/workflow-mode.md`. Start
  `{{GAUNTLET_REPO}}/workflows/gauntlet.workflow.js` with the Workflow tool and
  `args: { cli: "{{GAUNTLET_REPO}}/bin/gauntlet.mjs", run: "<run>", maxSteps: 60 }`.

Exit codes of every command:

| Code | Meaning | What you do |
|---|---|---|
| 0 | nothing waiting | read `NEXT:` |
| 10 | agents to spawn | spawn exactly the printed calls, all in parallel, then `step` |
| 20 | executor action | read the to-do (`PL todo "<run>"`); FIX -> fix only what it lists; CONFIRM -> change nothing, run `step`; DONE -> run `PL done "<run>"`; BLOCKED_* -> fix the listed precheck/trace problem |
| 30 | stopped, report written | show the owner the summary (step 6); no new rounds without the owner's word |
| 3 | integrity failure (tamper, frozen mismatch, prompt lint, a failed audit at `done`) | stop; tell the owner in plain Russian that the run's integrity check failed, and give the owner the path of `REPORT.ru.md` (`PL report "<run>"` writes it) and of `AUDIT.json`; never "repair" hashes or ledgers |
| 4 | usage error / refused input | read the message; fix your arguments; if it asks for the owner's words, ask the owner |
| 1 | internal error | stop; tell the owner in plain Russian that the program failed with an internal error, and give the owner the run folder path; do not paste the stack trace |

Disagreeing with a finding: `PL dispute "<run>" --cluster <id> --argument "<why>" (--evidence-cmd <exe> --evidence-arg <a>... | --evidence-quote <rel>::<quote>)`.
Without evidence it is refused; so is evidence that argues intent or scope ("deliberate", "already
fixed"). Two fresh checkers decide; a finding is withdrawn only if both agree. You never mark anything
fixed yourself; verifiers do. Never edit `clusters.json` or any run file: the next command stops with
exit 3.

### 6. On a stop (exit 30)

1. `PL report "<run>" --summary` -> show the owner exactly the printed lines (five, plus a line for each
   caveat) and the path of `REPORT.ru.md`. Nothing else about quality, no score of your own.
2. Wait for the owner's words. Record decisions only with the owner's exact words, and every time with
   `--question "<the exact question you asked>"` (the CLI refuses a decision without it). Whether the owner
   answers in a few words («да», «стоп», «продолжай») or in a long message, record the owner's answer exactly
   as said; never pad or rephrase it. Use a quote for the decision it answers and for no other: a new
   decision needs a new question. In `run.json` every `quote` (`limitsOptIn`, `models.optIn`,
   `driver.workflowOptIn`) needs a `question` field, short or long. Each line
   below needs `--owner-quote "<the owner's words>" --question "<what you asked>"`:
   - waive a finding (only now, after a stop and its report): `PL waive "<run>" --cluster <id>[,<id>] --owner-quote "<the owner's words>" --question "<what you asked>"`;
   - continue after a plateau / inconclusive stop: `PL owner "<run>" --kind continue --owner-quote "<the owner's words>" --question "<what you asked>"`;
   - raise a limit: `PL owner "<run>" --kind raise-limit --owner-quote "<the owner's words>" --question "<what you asked>" --set limits.maxRounds=10`
     (only `maxRounds`, `maxConfirms`, `maxPanelTokens`, and only upward);
   - stop: `PL owner "<run>" --kind stop --owner-quote "<the owner's words>" --question "<what you asked>"`;
   - restore the best version (on the owner's word only): `PL restore-best "<run>" --to "<dir>" --owner-quote "<the owner's words>" --question "<what you asked>"`;
   - abort the run (needs the owner's words when a round is in progress, a serious problem is open,
     unverified or contested, or the run stopped on a plateau, a limit or an inconclusive panel; only
     a run still in setup with nothing open aborts without them, step 1): `PL abort "<run>" --reason "<text>" --owner-quote "<the owner's words>" --question "<what you asked>"`;
   - start over on the same material: `PL init ... --supersede <runId> --reason "<text>" --owner-quote "<the owner's words>" --question "<what you asked>"`
     (the new run shows the old run's open problems to the owner).
3. After the report: `PL cleanup "<run>"`.
A plateau (two working rounds in a row that reached the reviewers, even with an invalid lens, without fewer open blockers and majors) is a stop for a reason: show
the list, do not keep fixing in silence.

### 7. Never-list

`reference/never.md`. The global rule `~/.claude/rules/gauntlet.md` is deliberately short (every
session loads it, the run's reviewers included, so it says nothing about how the loop works); the
never-list lives only here.

### 8. Project process note

If a project's own process document (for example a sprint plan) mandates a model for review steps, that is the owner's
word: before freeze add it with `PL owner "<run>" --kind model-opt-in --owner-quote "<that line, verbatim>" --question "<what you asked>" --set role=<role> --set model=<model>`
(or the same entry in `run.json` `models.optIn` with that line as the quote and a `question`).

### 9. Cost

About 1.8M panel tokens per round with 5 lenses plus the generalist; a hard artifact needs about
10M in total. The default cap is 15M (`limits.maxPanelTokens`); the CLI stops with STOP_LIMIT before
a round that would exceed it. Raising it is the owner's decision (`owner --kind raise-limit`).

## Other commands

`PL status "<run>"` (state, rounds, tokens, best round, unreviewed changes) - `PL todo "<run>"` -
`PL audit "<run>"` - `PL abort "<run>" --reason "<text>" [--owner-quote "<the owner's words>" --question "<what you asked>"]` - `PL ledger stats` (planted-error recall
across runs; the only place recall is read) - `PL doctor` - `PL selftest`.

<!-- gauntlet: installed copy of a repository file; install.mjs replaces it, --uninstall removes it -->
