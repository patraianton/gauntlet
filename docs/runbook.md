# Runbook

How to run gauntlet and what to do at every exit code and decision. Commands are shown for
PowerShell 7 on Windows; Git Bash and POSIX shells work the same with `/c/Users/...` or `/home/...` paths. Throughout:

```powershell
$PL  = 'C:\src\gauntlet\bin\gauntlet.mjs'
$RUN = '<the run folder printed by init>'
```

House rules that apply to every step: nothing is sent to anyone outside without the owner's word;
working copies only under a run root (default `~/work-copies/<project>/`; see section 1.1);
owner decisions only with the owner's verbatim words; reviewers and helpers default to Sonnet/high.

---

## 0. Before the first run on a machine

```powershell
cd C:\src\gauntlet
node bin/gauntlet.mjs doctor     # Node >= 24, template manifest, data home writable, chains verify
npm test
node bin/gauntlet.mjs selftest   # offline scenario, no LLM; exit 0 only if every check passed
```

Once per data home, import the historical canary outcomes (flagged contaminated; idempotent):

```powershell
node $PL ledger import-legacy --file C:\src\gauntlet\bench\legacy-2026-10.json
```

Before the **first real run** the bench run (section 7) must pass. It needs the owner's consent.

The reviewer templates must be approved by the owner once per template version (and again after any
change to `templates/`): `init` refuses otherwise. Show the owner what changed (`git log -p templates/`), ask
«Шаблоны вопросов проверяющим версии N ещё не одобрены. Одобряете?», and on the owner's words run
`node $PL templates approve --owner-quote "<the owner's words>" --question "<what you asked>"` (r3-f6;
`templates status` shows the state).

---

## 1. Starting a run

### 1.1 Owner's words and `init`

1. Save the owner's task **verbatim** to a text file (for example `owner-task.txt` in the
   project folder). Do not paraphrase, summarise or "clean up".
2. Create the run. Declare **broad** roots — the whole output folder of the work, not a selection.
   `--include`/`--exclude` apply to every root; `--notes` names author-notes files (copy-relative).

```powershell
node $PL init --project demo-project --artifact-type marketing-plan `
  --root 'C:\Users\you\work-copies\demo-project\content-plan=content' `
  --root 'C:\Users\you\work-copies\demo-project\page=page' `
  --notes content/AUTHOR-NOTES.md
```

**Run roots.** The run folder (default `<projectDir>/gauntlet-runs/<runId>`, `--run-dir` overrides) must lie
strictly inside an allowed run root. The allow-list is the env var `GAUNTLET_RUN_ROOTS`: folders separated
by `;` (on macOS and Linux `:` also works); the entry `*` allows any folder. Default: `~/work-copies`.
The project folder defaults to `<first run root>/<project>` (`--project-dir <dir>` overrides) and the
review base to `<run root>/_wc`. This keeps runs and review copies out of the material.

`--artifact-type` is one of `marketing-plan`, `copy`, `slides`, `report`, `code`, `other`. `init`
refuses (exit 4) if the run folder exists, is not strictly inside an allowed run root, or another
unfinished run covers overlapping roots (whatever its project name). To replace such a run, only on
the owner's word: `--supersede <oldRunId> --reason "<why>" --owner-quote "<the owner's words>" --question "<what you asked>"` (the old run is
marked aborted, superseded). `init` also refuses (exit 3) when the repository templates differ from
`templates/MANIFEST.json`. Every earlier run on the same material is recorded with the verified
problems it left open; SETUP-SUMMARY, the report and the summary show them.

### 1.2 `task set`

```powershell
node $PL task set $RUN --from owner-task.txt --cut 4,7-8 --source 'the owner, 2026-10-06, chat'
```

- `OWNER-TASK.md` keeps the text verbatim plus the `Source:` line; it is never shown to agents.
- `TASK.md` is the same text minus the cut lines (1-based line numbers). Cut **only** loop-control
  lines: thresholds ("до 9,5"), "until the panel says", averages, round instructions.
- The task lint looks for loop-control constructs only (thresholds, "≥ 9", "9,5", "until the panel
  says", «гоняй панель», "do not flag", "deliberate", ...). Ordinary product words such as «оценка
  стоимости», «средняя цена», "credit score" are requirements and stay.
- If `TASK.md` fails the lint, `task set` exits 4 and lists the offending lines. Cut a line only if it
  is loop control and holds no requirement. A line that mixes a requirement with loop control is never
  cut: ask the owner to say it again without the loop-control part. Every cut line is printed in the
  report.
- A cut line that the lint does not flag on its own states a requirement: `task set` refuses the cut
  (exit 4) unless the owner said to drop it — then add `--owner-quote "<the owner's words>" --question "<what you asked>"`; the report prints the
  line under the owner's words and the question, not as loop control.

### 1.3 The executor's settings files

Write these into the run folder before the first `step`. They are smoke-tested and frozen at setup.

**`sources.json`** — recipes for primary data. Only recipes you have actually run and seen return
data. `cmd` must be in `run.json.allowExecutables` (default `curl, node, python, python3, git`).

```json
{
  "schemaVersion": 1,
  "sources": [
    { "id": "S1", "what": "Live site home page", "kind": "command",
      "origin": "The live public site example.com, fetched by the recipe.",
      "cmd": "curl", "args": ["-s", "-A", "Mozilla/5.0", "https://example.com/"],
      "expect": "contains:Example" },
    { "id": "S2", "what": "Lead form texts as shipped in the site code", "kind": "file",
      "origin": "The shop repository, lib/copy.ts, local clone.",
      "path": "C:/Users/you/src/shop/lib/copy.ts",
      "notes": "The form is rendered in the browser; curl of the page cannot see these texts. Check here." },
    { "id": "S3", "what": "Privacy policy page", "kind": "command",
      "origin": "The live public site example.com, fetched by the recipe.",
      "cmd": "curl", "args": ["-s", "https://example.com/privacy"], "expect": "nonempty" }
  ]
}
```

For live data that changes daily, say in the source's `notes` when the work's numbers were taken
("the plan's numbers were fetched on 2026-10-04; this recipe prints today's data") — a fact, never a
verdict such as "a small shift is not an error", which the lint refuses (roadmap, recorded decision
r3-f26).

Every source needs an `origin` (where the data comes from and who made it; up to 300 characters);
`what` is capped at 300 and `notes` at 600 characters. Reviewers see `what`, `origin` and `notes`
under a banner saying they are the author's unverified claims; the owner sees every source with its origin
and recipe in SETUP-SUMMARY and the report. In JSON a Windows path needs doubled backslashes or
forward slashes; a file that is not valid JSON is refused with exit 4 and the position.

Refused as primary sources (exit 20 at setup, `amend` refused later): a file that lies inside a
material root, the run folder or the project working folder (`run.json.projectDir`) — whatever it is
called, it is the author's own work or notes; a file written after the run started (so every script
or data file a source reads must exist **before `init`**; if one only appears later, abort the run and
start a new one: allowed without the owner's words only while no round has run and nothing is open; the CLI refuses it otherwise); a recipe whose arguments name such a file (e.g. `node facts.mjs` with the script next
to the work); anything that points at the declared author notes. `sources check` applies the same
rules as setup. The age rule reads the file's modification time, so a file whose date was set back
passes it; to close that, setup records the sha256 of every file each source reads (`sources-baseline`
in the ledger) and **every round start compares them**: a source file that changed or vanished blocks
the round (`BLOCKED_PRECHECK`) until it is restored or the owner agrees (`amend --what sources
--owner-quote ... --question ...`, which records a new baseline). A source that fails at a round start also **blocks the
round**: repair it, or change the recipe with `amend --what sources` and the owner's words (any change to a
kept source needs them). If a run truly has no sources, pass `--no-sources` to the
first `step` (logged, shown in the report).

**Moving targets.** A source must say the same thing in every round, so code lints each recipe by its
shape (it runs nothing). Flagged: a git revision that is not a full commit hash (a branch, `HEAD`, a tag,
`origin/x`, `HEAD~1`; an abbreviated hash of 7+ characters is only shown as a `HINT`); `git log` and friends without a pinned range; `git diff`,
`blame` or `grep` with no commit, or `git diff` with one commit (they compare with the working tree); `git status`, `ls-files`, `branch`,
`fetch` and other commands that show the live state; a `file` source, or a data file named in a
command, inside a git working tree (the script an interpreter runs is not linted; the baseline hash
guards it). At setup the first `step` stops with exit 20 and the pinned form for each flagged recipe;
answer by rewriting the recipe (`git -C <repo> show <full-hash>:<path>`), or, only if the owner agrees to
keep exactly these recipes, run `step --owner-quote "<the owner's words>" --question "<what you asked>"` (recorded as a `moving-sources`
owner decision). `amend --what sources` applies the same lint to the new or changed sources and needs
the owner's words to keep a flagged one. Sources an amendment does not touch are not re-linted. `sources
check` prints each flagged recipe as `WARN` without changing its exit code. Paths after a revision
(`git ls-tree <hash> lib/db/`, `git log <hash> reports/SPEND.md`) are not revisions: for `ls-tree`, `archive`,
`describe` and `name-rev` only the first argument is a revision, and elsewhere a trailing `/`, a file
extension or an existing file marks a path; put `--` before paths when in doubt. The git commands inside
`sh -c`, `bash -c` and `powershell -Command` one-liners are linted too; moving URLs and API calls are not.

**A source that blocks the reviewers.** A reviewer who is refused (HTTP 429, captcha, timeout) records
every attempt in `sourceChecks` with `outcome: "unavailable"` and the error in `result`. A
`source-check` minimum (`count` = attempts, not successes) counts as done when the reviewer documented
that many attempts, at least one of them unavailable; the lens is **not** invalid because of it. Code
logs a `source-unavailable` ledger event per round, `todo.md` lists the source under "Primary sources
the reviewers could not reach", and the report's "not checked" section says that source <id> was
unavailable to reviewers in round N. Claims only that source could settle stay under `notVerified` (or
`unverifiable` for verifiers): neither findings nor passes.

**`strip.json`** — removes review traces from the review copy. Use it when the material contains
score tables, feedback files, "fixed in round N" notes and the like.

```json
{
  "schemaVersion": 1,
  "excludeGlobs": ["**/*FEEDBACK*.md", "**/scores.json"],
  "regex": [
    { "glob": "page/index.html", "pattern": "<section id=\"history\">.*?</section>", "flags": "s",
      "replace": "", "expect": "atLeastOne", "why": "history of earlier review rounds on the owner page" }
  ],
  "traceAllow": []
}
```

`expect`: `atLeastOne` fails when the rule matched nothing (the trace moved); `zero` fails when it
matched; `any` never fails. Data files (`.csv .tsv .jsonl .ndjson .json`): small ones (below 1 MiB and 2 000 rows) get every pattern, like prose; in large ones short values are scanned for unambiguous traces only (score sentences, the tool's own names, "round N verdict"), so bare ratings and words such as "panel" or "reviewer" are ordinary data there, while every long value (4 or more words, or 30 or more characters) gets every pattern. `traceAllow` is only for genuine product phrases that look like traces (for
example "solar panel kits" in a shop listing): `{ "phrase": "solar panel kits", "why": "..." }`. A phrase
is literal text matched case-insensitively, never a regex; code refuses a phrase shorter than 8
characters, one with regex characters (`\ [ ] * + ? | ^ $ { }`), one that covers no trace word or more
than one, and one with fewer than 4 letters besides the trace word. Every phrase needs the owner's words
(`step --owner-quote ... --question ...` before freeze, `amend --owner-quote ... --question ...` after), and SETUP-SUMMARY and the report list
every phrase with its match count. Never allow-list real review history.

**The strip preview.** At the first `step` (before the lens writer and the freeze) the CLI builds a
throw-away snapshot and review copy with these rules and the rebuild, and refuses to go on (exit 20,
state `NEW`, with the list) when a regex does not compile, an `expect` fails, a JSON file breaks, a
review trace is left, or the rebuild fails or gives output that differs from the material although
strip touched no rebuild source. A strip rule may only **delete review traces**: a rule that writes new
text, deletes more than 600 characters at once, or deletes text without a trace in it, and an exclude
glob that drops a file without a trace, is **narrowing** — it is refused unless the owner agreed, recorded
with `step $RUN --owner-quote "<the owner's words>" --question "<what you asked>"`. Fix strip.json and run `step` again as often as needed
before freeze; no quote is needed for that. SETUP-SUMMARY and the report list every exclusion, every
rule with its match count and the rebuild command. After freeze, `amend --what strip` runs the same
preview; new non-trace removals and every new `traceAllow` phrase need the owner's words. A `traceAllow` phrase that
no longer covers a trace word (the version words were narrowed on 07.10) is refused as not needed; delete it
(removing an excuse needs no owner words), and do not copy `strip.json` from an older run: start with
`"traceAllow": []` and add a phrase only after the first `BLOCKED_TRACE` names it.

**`mechanical.json`** — cheap checks before any agent runs. A failing `blocker`/`major` check stops
the round before it starts (`BLOCKED_PRECHECK`).

```json
{
  "schemaVersion": 1,
  "checks": [
    { "id": "K1", "what": "plan.json is valid JSON", "severity": "blocker", "kind": "json-valid", "glob": "content/plan.json" },
    { "id": "K2", "what": "exactly 30 posts", "severity": "blocker", "kind": "count",
      "glob": "content/plan.json", "pointer": "/posts", "op": "=", "value": 30 },
    { "id": "K3", "what": "no leftover placeholders", "severity": "major", "kind": "no-forbidden-text",
      "glob": "content/**/*.json", "patterns": ["TODO", "XXX", "\\{\\{"] }
  ]
}
```

Which field belongs to which `kind`: `json-valid` takes `glob` (default `**/*.json`); `count` takes `glob`,
`value` (a number), and optionally `op` (`>=`, `=`, `<=`) and `pointer`; `file-exists` takes `path` (one exact
file, `<root name>/<file>`; **not** `glob`); `no-forbidden-text` takes `patterns` (regular expressions) and
optionally `glob`; `command` takes `cmd` (a name from `allowExecutables`) and optionally `args`. The first
`step` checks the whole file before anything is frozen: an unknown kind, a missing field, a field of another
kind, a bad regex, a program outside the allowlist, or a path or glob that matches nothing in the material is
refused with a list that names each check (`K1: ... Fix: ...`). A `file-exists` path must already be a file of the
material at the first `step`: a check for a file the window will create after freeze cannot be frozen (create the file
first, or use another kind). Fix the file and run `step` again; no owner
words are needed before freeze. A check that was frozen with a wrong shape by an older program (a `file-exists` with
`glob`) could never run: `amend --what mechanical` may replace it by a sound check with the same id and the same or
a higher severity without the owner's words. Deleting it or lowering its severity still needs them. `amend --what mechanical` runs the same check (exit 4, nothing written).

**`run.json`** — edit before freeze only:

| Field | When to change |
|---|---|
| `driver` | `{ "mode": "workflow", "workflowOptIn": { "approvedBy": "owner", "quote": "<the owner's words>", "question": "<the exact question you asked the owner>", "date": "YYYY-MM-DD" } }` only if the owner said so; otherwise leave `agent`. Every quote written into `run.json` (here, `models.optIn`, `limitsOptIn`, `canaries.fixedKey`) carries the `question` it answers, short answer or long: freeze is refused without it |
| `ownerTarget` | the owner's own target as said (e.g. `"9.5"`); printed in the report, never shown to agents |
| `rebuild` | when the material has generated outputs (slides rendered from HTML): command, args with `{copy}`, `sourcesGlob`, `outputsGlob` |
| `material.readingOrder` | when path order is not the reading order (affects canary bands) |
| `models.optIn` | only with the owner's quote: `{ "role": "reviewer", "model": "opus", "approvedBy": "owner", "quote": "<the owner's words>", "question": "<the exact question you asked the owner>", "date": "..." }`. `codex*` is refused on Windows |
| `generalist` | `true` by default (a "first-time reader" lens); keep it |
| `limits`, `canaries` | defaults are written in at freeze. Stricter limits are fine; any limit — or planted-error setting (`canaries.attentionPerLens`, `measurementWorking`, `measurementConfirm`, `candidatesPerSlot`, `maxEditChars`, `minDistanceChars`) — looser than its default needs `"limitsOptIn": { "approvedBy": "owner", "quote": "<the owner's words>", "question": "<the exact question you asked the owner>", "date": "YYYY-MM-DD" }` or freeze is refused. After freeze raise limits only with `owner --kind raise-limit`. `canaries.visualAllowed` defaults to on when `rebuild` is set. `canaries.fixedKey` is for the bench only (section 7) |
| `reviewBase` | default `<run root>/_wc`, a folder of its own. Change it only if the path lint refuses it. It must be absolute, under a run root (`GAUNTLET_RUN_ROOTS`), outside the material, the run folder, the repository and the data home, and neither it nor its parent may hold `gauntlet-runs`, `gauntlet`, `gauntlet-data`, `sealed` or `*.key.json` — reviewers would be one `..` away from answers and keys |

Preview the sources: `node $PL sources check $RUN`.

**Large data files (SPEC 14.10).** A table or list of records (`.csv .tsv .jsonl .ndjson`, a `.json`
array) over 1 MiB or over 2 000 rows cannot be read whole by a reviewer, so you do not ask them to.
You change nothing in the run for it; the program does this on its own:

- At setup the lens writer is told which files are large (the file list is marked LARGE DATA FILE)
  and writes minimums over the sampled rows and the summary numbers of the description files.
  SETUP-SUMMARY lists the large files for the owner.
- At every round start, after the snapshot, the program draws a new random sample of every large file
  (header + up to `limits.sampleRows` = 200 rows, at most `limits.sampleMaxBytes` = 100 000 characters of
  rows once 20 rows are in, and at most `limits.sampleTotalBytes` = 250 000 characters over all large files
  together, split evenly) plus every row a planted error sits in. The draw is sealed with the canary
  key; you cannot see it and it changes every round. The planter may plant only inside sampled rows
  (refused candidates show up as the ordinary "planter again" step), the reviewers get the rows in
  `SAMPLE-<k>.md` in their job folder, any "every row" rule over such a file is rewritten by code to
  "every sampled row + every summary number in the prose files", and the read-check lines come from the
  sampled rows.
- A planted error of the round may therefore sit in a row you never saw; that is the point. Do not
  look for the sample in the review base to "fix only those rows": the next round draws again.
- The thresholds are `limits.sampleThresholdBytes`, `limits.sampleThresholdRows`, `limits.sampleRows`,
  `limits.sampleMaxBytes`, `limits.sampleTotalBytes`. Bigger sizes read more and are free. Smaller ones
  need `limitsOptIn` with the owner's words (they read less) and are printed as looser limits; so is any
  threshold raised above the defaults (1 MiB, 2 000 rows): it would stop sampling for files that
  reviewers cannot read whole.
- The sealed selection is checked against the hash in the ledger before the key is revealed and by
  `audit` (check `sample`); a changed file is an integrity failure (exit 3). If a round is blocked
  because "the rows of <file> changed while the review copy was prepared", the rebuild of the copy
  regenerates a large data file: leave data files out of the rebuild outputs, then step.
- The report (section 7) says per round and file «проверяющие видели выборку N строк из M; ошибки вне
  выборки могли остаться», and the summary gets one line with the same numbers. «Готово» for such a run
  means "none found in the rows seen". Tell the owner so; if the owner wants a file checked in full, give the owner the number
  of rows the sample could not cover or have a whole-file check run by a script (counts, empty cells, duplicates).
  Do not split a file to get below the thresholds: files of one kind in one folder that together pass 4 x the
  file threshold are treated as one data set anyway.
- Files that are too big but cannot be sampled (a JSON object, XML, SQL, text, log) are listed to the reviewers
  as "check the structure, spot-check", get no planted errors, and are named in SETUP-SUMMARY, report section 7
  and one summary line as not checked whole. Tell the owner that such files are not checked whole; small files of
  one kind in one folder over 4 x the file threshold together count as one data set (sampled, or listed when
  they cannot be). A data set split across folders or kinds is not recognised (honesty limit 24).
- A reviewer may still run a script over the whole file (counts, empty cells, duplicates). That is the
  right way to check a summary number and is not restricted.

### 1.4 Setup and freeze

```powershell
node $PL step $RUN     # exit 10: one lens-writer call. Spawn it exactly as printed.
node $PL step $RUN --answer-hash <job>=<code> --usage <job>=<tokens>
                       # validates lenses; exit 20: READY. SETUP-SUMMARY.ru.md is written.
```

Showing `SETUP-SUMMARY.ru.md` to the owner is optional and non-blocking. It lists the lenses, the
requirements with their task quotes, limits, the canary plan, expected cost and models. A lens with
no attention-eligible canary type is flagged there: it can never certify clean.

### 1.5 The loop (Agent mode)

```powershell
node $PL step $RUN
```

| Exit | Do |
|---|---|
| 10 | Spawn **every** printed call in **one** message, in parallel, with the Agent tool: `subagent_type: "general-purpose"`, prompt exactly as printed, `model` only if the job lists one. Each agent replies `DONE <answer code>`. When all have replied, run `step $RUN --answer-hash <job>=<code>,... --usage <job>=<tokens>,...` with each agent's code and total-token number. An answer whose file no longer matches its code is rejected; an answer relayed without a code is accepted as found and counted in the report. |
| 20 | Read the to-do (`todo $RUN` reprints it). Act on it (section 2 and 3), then `step` again. |
| 30 | Stop. Show the owner `report $RUN --summary` and the report path. Start nothing new without the owner's word. |

Round numbers in `status`, the to-do, the report and the summary are the REAL ones: only rounds that reached
the reviewers are counted (the same set the round limit, the plateau and the best version use). The run
folder follows in brackets where it differs («round 3 (folder 04)», «круг 3 (папка 04)»). A blocked
attempt (`BLOCKED_PRECHECK` / `BLOCKED_TRACE`) is shown as «attempt (folder 01)» and is never a round.
`ledger`/`gate` files, `best.json` and the `audit` details keep the folder number: the «round N» prefix in the lines
of `audit` and in the `control-run` output is the folder number, not the real round.

The spawn list of a round also holds one **decoy writer** job beside the reviewers (label `decoy`); spawn it like
the others. Its answer and the decoys it makes stay sealed until the round closes; a lost one is given up like any
other job (`--give-up`) and the round simply goes on without decoys. When the verifiers are asked, some of their
items are decoys (false) or true controls (real planted problems): print and relay them as they are, never try to
tell them apart. A second wave of verifier calls after the first one means a verifier accepted a false item, or
acquitted a real planted problem, and its other decisions are being re-checked.

Never read reviewer answers (`rounds\NN\answers\`) or the data home's `sealed\` folder while a
round is open. Never edit the material during a round or after a clean round.

After the decision `DONE`: `node $PL done $RUN`, then `report $RUN --summary`.

---

## 2. Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done with this command, nothing waiting | Continue with the next step of the procedure |
| 10 | Agents to spawn | Spawn all printed calls in one message; then `step --answer-hash ... --usage ...`. Running `step` again before the agents finish just reprints the missing calls |
| 20 | Executor action needed | Follow the to-do and the decision table below |
| 30 | Stopped; report written | Show the owner the 5 summary lines and the report path; wait for the owner's words (section 6) |
| 3 | Integrity failure (fail-closed) | Stop. Do not "repair" ledgers, hashes or answers. See section 5.4 |
| 4 | Usage error, wrong state, refused input | Read the message; fix the command or the input. Common: missing `--owner-quote` or `--question`, dispute without evidence, command not allowed in this state, lock held, `init` refused, task lint, freeze refused an opt-in without a quote or without its question or a `codex*` model on Windows |
| 1 | Internal error (a bug) | Do not retry in a loop. Run `status` and `audit`; keep the run folder untouched; report the command, output and run id to the maintainer |

`--json` gives the same information as one envelope; the Workflow driver relies on it.

---

## 3. Decisions and other `step` outcomes

### 3.1 Gate decisions (`rounds/NN/gate.json`)

| Decision | Exit | Meaning | What to do |
|---|---|---|---|
| `FIX` | 20 | Open verified blockers/majors (or unverified/contested ones, or invalid/unguarded lenses) remain | Fix exactly what `todo.md` lists. For `unverified`/`contested` items, either fix, or `dispute` with evidence, or take them to the owner. Then `step`. If nothing serious is open (the round was not clean only because a lens could not be checked or its answer was invalid), change nothing and run `step`: the round is repeated on the same version |
| `CONFIRM` | 20 | This working round was clean; it is now the candidate | **Change nothing.** Run `step`: the next round is the blind confirm round on the same version |
| `DONE` | 20 | The confirm round was clean on the candidate's version | Run `done $RUN` (exit 30, "готово" if the live files are unchanged) |
| `RERUN_LENS` | 10 | A lens's answer was invalid or missed its own attention canary; a fresh reviewer re-reads the same copy (once, `maxLensReruns`) | Spawn the printed rerun calls like any other |
| `INVALID_ROUND` | 20 | Something wrote into the review copy during review; the round counts toward `maxRounds` | Read section 3.1a first: `todo.md` (Russian lines under "What blocks the round") and `rounds\NN\copy-tamper.json` name the files, their times and the jobs that were running. Make sure nothing (you, a tool, a sync) writes into the review base (`<run root>/_wc/`). Then `step` |
| `BLOCKED_PRECHECK` | 20 | Before any agent ran: a blocker/major mechanical check failed, a primary source does not work now, a material file is not covered by any lens's mandatory reading rule (a file added after freeze), or a folder link/junction sits inside a root; not counted as a round | Fix the material, the source (or its recipe via `amend` with the owner's words), move the uncovered file out of the roots or widen the lenses (`amend --what lenses` with the owner's words), replace the link with a real folder; then `step`. Each block uses up a folder number (the next round folder is `rounds\<NN+1>`) but is **not a round**: it counts toward no limit (`maxRounds`), no plateau, no best version and no open count; `status` lists it as an "attempt", and the report shows it as "Попытка круга (папка rounds\NN) не состоялась" with no problem counts and a separate count in section 12 |
| `BLOCKED_TRACE` | 20 | The review copy contains review traces (score words, "круг 3", "исправлено", "9,5", "FEEDBACK", the version history of the work itself such as «версия 3 плана» or «по сравнению с версией 2»; product numbering like «Версия 1 / Версия 2» of an integration is not a trace) or a strip rule's `expect` failed, or the frozen strip rules now remove material that carries no review trace (a file or text added after freeze), or the rebuilt outputs differ from the material; the copy was deleted; not a round | Remove a real leftover of a review from the material by hand (or add a `strip` rule, `amend --what strip`). **Never rewrite, reword or hide material values to pass the scan, and never split a word to evade it**: for a genuine product word or value (a shop's own rating, "solar panel kits") ask the owner the question the to-do prints, and only on the owner's yes add a `traceAllow` with a `why` (`amend --what strip --owner-quote ... --question ...`). Data files (`.csv .tsv .jsonl .ndjson .json`): small ones get every pattern; in large ones short values are scanned with unambiguous patterns only and every long value (4+ words or 30+ characters) with every pattern. For removed non-trace material: rename or move the new file, or (the owner's words) `amend --what strip --owner-quote`. Then `step` |
| `STOP_PLATEAU` | 30 | `plateauRounds` (2) working rounds in a row that reached the reviewers (even if a lens was invalid in them) without fewer open serious problems than the best before them; clean, CONFIRM and DONE still need every lens valid | Escalate (section 6) |
| `STOP_LIMIT` | 30 | Rounds, confirm rounds or panel tokens exhausted (checked before a round starts, too) | Escalate (section 6) |
| `STOP_INCONCLUSIVE` | 30 | A lens stayed unreliable while nothing else is open — invalid after its rerun, no attention check possible for it at all, or no attention check two rounds in a row; the run cannot certify. Also used when the lens writer fails twice (reason `lens-writer`) or the planter is lost twice (reason `planter`) | Escalate (section 6) |
| `STOP_OWNER` | 30 | the owner's `stop` was recorded (also when the program had stopped the run before: the report then says «сначала … , а потом вы сами тоже сказали остановить») | Nothing; the report is final |

### 3.1a `INVALID_ROUND`: who wrote into the copy (SPEC 14.13)

The round is void when the copy no longer hashes to what was planted once the last reviewer has answered. Do not guess; read the record
(the copy folder itself is deleted when the round closes):

1. `rounds\NN\todo.md`, "What blocks the round": plain-Russian lines, one per file (the first 10): new / changed / removed file, size, the time it was
   written and **who was running at that time**. The full list (up to 500 files) is `rounds\NN\copy-tamper.json`; the ledger event `copy-tampered`
   (`stage: "while reviewers worked"`) holds the counts and the first 20. The report (section 11) prints the same lines.
2. How to read "who": a list of reviewer jobs (and the decoy writer) = the write happened while they worked, so one of them (or a program they ran) is
   the likely writer; an empty list ("ни один из помощников не работал") = the write happened before the first job started or after the last
   answer, so it was not a reviewer: look at your own window, a sync tool, an editor open on the review base; "время записи неизвестно" = a removed file has no time.
   This is a reading of file times, not proof (a tool can keep an old time). If `listingKnown` is false the run was started by an older version: the
   files cannot be named, only that the content differs.
3. Typical causes and the fix: a reviewer wrote a helper script or an extract into the copy instead of its own scratch folder (the prompt now names
   `work\` in the job folder; if a lens keeps doing it, say so to the owner, do not edit the prompt: templates are frozen); a sync/antivirus/indexer tool touching the
   review base (exclude it); you or a tool opened and saved a file in the copy.
4. Then `step`: the round is repeated from a fresh copy (it used one round of `maxRounds`).

What is **not** an invalid round: if the only difference is **added** files that Python or pytest write by themselves (`__pycache__\*.pyc` with a valid byte-code header and its source in the copy, and the files pytest itself writes under `.pytest_cache\`), the engine deletes them,
checks that the copy hashes to the planted hash again and counts the round; the ledger event `copy-tampered` (action "only files that a tool writes by itself were added;
they were removed and the round counts"), `copyScratchRemoved` in `round.json` and one Russian line in the report say so. Nothing else is ever tolerated: a changed or removed file,
any other new file, `.mypy_cache`, scratch together with another difference. Do not add tolerated paths to make a run pass: show the owner the record first.

Every job folder holds an empty `work\` scratch folder (SPEC 14.13); it is removed with the job folder when the answer is ingested. If a job folder is reported as a
leftover after a round (a tree with a folder link, for example a virtual environment a reviewer made, is never removed automatically), delete it by hand with the usual care
(`cmd /c rmdir` for a link first), never through the copy.

### 3.1b Code and matcher disagree about a planted error (SPEC 14.6a)

After the matcher has answered, the program checks every reviewer finding against the planted text itself. If a finding
quotes the planted words (and is not wider than the passage, stands once in the file and covers most of the changed words)
and the matcher did not accept it, the finding is counted as a catch of the planted error and never reaches `clusters.json`,
`todo.md` or the open problems. Where to see it: `rounds\NN\round.json` `crossCheck` (`hits`, `keptReal`, `alsoRealIgnored`), the
`match` event of the ledger (`codeVsMatcher`), a `detections.json` row with `crossCheck: true`, and a Russian line under the
round in the report. Nothing is asked of the executor. `keptReal` lists findings where the matcher said "not the planted error,
but a real problem on the same line": they stay real, as the matcher decided, and the report names them. If the same finding
shows up in `hits` round after round for a reviewer lens, suspect the matcher template, not the reviewers.

### 3.2 Other exit-20 messages from `step`

| Message | What to do |
|---|---|
| "run task set" | `task set` was not run |
| `sources.json` missing | Write it, or pass `--no-sources` once if the work truly has no primary data |
| failing sources at setup | Fix the recipes until `sources check` returns data for every source. Do not delete a source to get past this after freeze without the owner's quote |
| READY after setup | Optionally show `SETUP-SUMMARY.ru.md`; run `step` to start round 1 |
| "material unchanged since round N; fix first" | You ran `step` after `FIX` without changing anything while serious problems are open. Fix the to-do. `--same-material` re-reviews the same version on purpose (rare; earlier confirmed clusters stay open under the union rule anyway) |
| strip preview problems or "removes or rewrites material that is not a review trace" (state `NEW`) | Fix strip.json (section 1.3) and `step` again; only if the owner wants exactly that removal, `step --owner-quote "<the owner's words>" --question "<what you asked>"` |
| review base problems | Fix `run.json reviewBase` (section 1.3 table) |
| folder links or junctions in the roots | Replace them with real folders or exclude them |
| "material changed after a clean round" (logged) | You edited after `CONFIRM`; the candidate is cleared and the next round is a working round again |

### 3.3 `done` outcomes

| Outcome | Meaning | What to do |
|---|---|---|
| exit 30, "готово" | Live files hash to the confirm round's version; `DONE.json` written | Show the summary and report path to the owner |
| exit 30, "после проверки файлы менялись" | Files changed after the confirm round; the report lists them as unreviewed | Tell the owner. A new confirm round (or a new run) is needed for those edits to count |

`status $RUN` prints `UNREVIEWED CHANGES: <files>` whenever live files differ from `DONE.json`.

---

## 4. Disputes, waivers, amendments, owner decisions

All of these are **between rounds** (state `READY`). The executor never changes a finding's status
or class directly.

**Dispute** — when you believe a finding is wrong and can prove it:

```powershell
node $PL dispute $RUN --cluster C-02-03 --argument "The 24-hour promise is in the lead form, rendered in the browser" `
  --evidence-cmd git --evidence-arg -C --evidence-arg 'C:\Users\you\src\shop' `
  --evidence-arg grep --evidence-arg -n --evidence-arg '24 hours' --evidence-arg -- --evidence-arg lib/copy.ts
node $PL dispute $RUN --cluster C-02-05 --argument "The plan already says numbers are recounted on publishing day" `
  --evidence-quote "content/page_text.json::numbers are recounted on the day of publishing"
```

Evidence is required: a command (allowlisted, run now, output stored) or a quote that code finds in
the live material. The argument, the command's arguments and its output are linted: words that steer
a checker ("deliberate", "already fixed", "out of scope", ...) are refused, also when a command prints
them. Two fresh dispute verifiers decide it next round, independently. The cluster is `withdrawn`
(closed) only if both say so, `reclassified` only if both lower it (to the higher of their classes);
any `upheld` keeps it. Every dispute and its outcome is listed in the report.

**Waive** — only when the owner said so, with the owner's exact words, and only in a stopped run after its
report was written (to waive mid-run, record `owner --kind stop` with the owner's words first):

```powershell
node $PL waive $RUN --cluster C-02-03,C-02-07 --owner-quote "<the owner's exact words>" --question "<what you asked the owner>"
```

**Owner decisions** — only with the owner's exact words, and with the exact question you asked the owner
(`--question`; a command without it is refused). One quote answers one question: never reuse it for a
decision of another kind (the report flags that, and words older than the problem they are used for):

```powershell
node $PL owner $RUN --kind continue    --owner-quote "<words>" --question "<what you asked>"
node $PL owner $RUN --kind raise-limit --owner-quote "<words>" --question "<what you asked>" --set limits.maxRounds=10 --set limits.maxPanelTokens=20000000
#   only maxRounds, maxConfirms and maxPanelTokens, and only upward; plateauRounds and the other
#   limits are frozen protections
node $PL owner $RUN --kind stop        --owner-quote "<words>" --question "<what you asked>"
node $PL owner $RUN --kind model-opt-in --owner-quote "<words>" --question "<what you asked>" --set role=confirm-extra --set model=opus
```

If a project's own process document mandates a model for review steps, that line is
the owner's word: add it with `owner --kind model-opt-in`, quoting the line.

**Amend** — change frozen settings, only in `READY`:

```powershell
node $PL amend $RUN --what sources --file C:\...\sources.new.json --reason "S3 URL moved"
node $PL amend $RUN --what lenses  --file C:\...\lenses.new.json  --reason "..." --owner-quote "<words>" --question "<what you asked>"
```

`--what` is `sources`, `strip`, `mechanical`, `lenses`, `material` or `task`. Lenses and task always
need an owner quote; any removal or narrowing (a lens, checklist line, minimum, source or a change to
a kept source, root, include glob; a strip rule or exclude glob that removes anything but review
traces) needs one too — code diffs old against new. `amend --what lenses` installs a lens file **you**
wrote: it is the one place where the executor writes lenses, so it needs the owner's words, is diffed,
logged and listed in the report (EVID, not a separate agent). Every amend clears the candidate,
re-freezes and is listed in the report. Templates never change inside a run.

---

## 5. Crash recovery

The run folder and the ledger are the state. Nothing important lives in the window.

### 5.1 The window crashed, compacted or was closed mid-round

1. `node $PL status $RUN` — state, round, pending jobs, next action.
2. `node $PL step $RUN` — idempotent. Answers that agents already wrote are ingested; calls still
   missing are reprinted (exit 10). Spawn only those.
3. If an agent is gone for good (no answer will come), either spawn the reprinted call again (same
   prompt, same nonce — fine), or give up on it:
   `step $RUN --give-up <job>[,<job>]` or `--give-up missing`. A given-up reviewer is an **invalid
   attempt** (never an approval). A lost planter is re-issued once; a second loss stops the run with
   `STOP_INCONCLUSIVE` (reason `planter`).

Token numbers for agents of a crashed window are usually lost; `step` records an estimate flagged
`estimated`, and the report says «оценено».

If a `step` itself was killed half way (a shell timeout, a closed terminal), the next command that
takes the run lock finds the guard marker it left, accepts the run files it wrote, records them in the
ledger as an interrupted command and warns; the report counts interrupted commands. Give long steps
(rebuilds, many sources) a long shell timeout: every `step` and `done` call gets the maximum Bash
timeout, 600000 ms; keep `run.rebuild.timeoutS` well under it.

### 5.2 Lock held

`step` takes `<run>\.lock`. If it is held by a live process younger than 2 hours, `step` exits 4.
Check that no other window or Workflow run is driving the same run. A lock of a dead process is taken
over automatically and logged. Kill a stuck process only if its command line contains
`gauntlet.mjs` — never any other `node` process (the session-backup watcher is a `node` process
and is protected).

### 5.3 The Workflow driver failed

The script stops with "clerk failed twice; run step by hand" or returns a status line. Either resume
the Workflow run (`resumeFromRunId`), or continue in Agent mode: run `step` by hand and spawn the
printed calls. The state is in files, so both are safe. A dead agent in Workflow mode is spawned once
more; after a second spawn without an answer it is passed as `--give-up` automatically. A relay that is not the fixed job-call shape, or names an odd model, also
stops the script (the clerk may have garbled or invented it). At a stop (any exit code but 10) a
payload the clerk copied inexactly does not stop the script: the returned line says so; run `status`.

### 5.4 Integrity failure (exit 3)

| Code | Usual cause |
|---|---|
| `TAMPER` | a ledger line edited/removed, or the chain head does not match the anchor in the data home (a run folder restored from a backup or copied from another machine; a rewritten ledger); or an engine-written run file (`clusters.json`, `disputes.json`, `owner-decisions.json`, a round file, an ingest record) changed between two commands — the message lists the files |
| `FROZEN_MISMATCH` | a frozen file (run settings, lenses, sources, strip, mechanical, task, a run template) changed outside `amend`/`owner`; or `TASK.md` no longer equals `OWNER-TASK.md` minus deleted lines |
| `TEMPLATE_MISMATCH` | run templates differ from the recorded hashes or the repo manifest version |
| `PROMPT_LINT` | a substituted value in a rendered prompt hit the forbidden-pattern list |
| `COMMITMENT_MISMATCH` | the sealed canary key changed between commit and reveal |

What to do:
1. Do not edit anything to make it pass. Run `node $PL audit $RUN` and read `AUDIT.json`.
2. Tell the owner plainly what failed (the report's «Проверка честности» section shows it too).
3. For `PROMPT_LINT` from a frozen setting (task, requirements, lens text, source notes): the run
   cannot continue as frozen. With the owner's word, start a new run with corrected inputs:
   `init ... --supersede <runId> --reason "prompt lint: <value>" --owner-quote "<the owner's words>" --question "<what you asked>"`. If the hit comes from text an agent
   wrote (a finding's claim shown to verifiers), report it to the maintainer with the run id.
4. For the other codes (`AUDIT_FAILED` from `done` included) the run's evidence is no longer
   trustworthy. With the owner's word, start a new run with `--supersede`, `--owner-quote` and `--question`. A run folder that has been moved between machines cannot be continued there.

---

## 6. Escalation after a stop (plateau, limit, inconclusive)

A stop means the system will not decide for the owner. The window shows the owner exactly the summary lines
(`report $RUN --summary`: five, plus one per caveat) and the report path — nothing invented, no
advocacy. The owner's options, each
recorded only with the owner's words:

| He wants | Command |
|---|---|
| keep going as is | `owner --kind continue` (plateau is counted afresh from the next round; earlier rounds still define "best") |
| more rounds or tokens | `owner --kind raise-limit --set limits.maxRounds=<n>` / `--set limits.maxPanelTokens=<n>` / `--set limits.maxConfirms=<n>` |
| accept specific findings as they are | `waive --cluster <ids>` (listed in the report as the owner's decision, never as fixed) |
| a stronger or different reviewer | `owner --kind model-opt-in --set role=<role> --set model=<model>` |
| the best version back | `restore-best $RUN --to <empty dir> --owner-quote "<the owner's words>" --question "<what you asked>"` (into a live root only with `--overwrite`: the root becomes equal to the best version, later material files removed, both version hashes printed) |
| stop here | `owner --kind stop` (end it for good: `abort $RUN --reason "<text>" --owner-quote "<the owner's words>" --question "<what you asked>"`) |
| a different approach | a new run with `init --supersede <runId> --reason "<the owner's reason>" --owner-quote "<the owner's words>" --question "<what you asked>"`; it shows the old run's open problems |

Typical reading of the stops:
- **Plateau:** fixes are not reducing the open count. Often the open items are disagreements about
  class (`contested`), requirements that the work does not meet by design, or fixes that create new
  problems. The report's sections 4–5 show which.
- **Inconclusive:** a lens's reviewers repeatedly missed their own planted error. The panel cannot
  vouch for that duty. A new round (`continue`) brings fresh reviewers; a different model is the owner's
  call.
- **Limit:** see the cost lines in the report; ask before raising.

---

## 7. The bench run on the bench material

Purpose: check the templates on a material with five planted errors before the first real run. In the
tool's own history, an earlier template caught 19 of 25 reviewer × planted-error pairs on a similar
material (5 planted errors, 5 reviewers); that is the reference, not a promise. Costs about **1.5M tokens**
and runs only with **the owner's consent**.

The bench material is shipped in `bench/material/bakery/`: a small synthetic example, the 30-post
Instagram content plan of an invented bakery (Crumb & Co.), already carrying five planted errors. The files
in `bench/` (key, strip rules, sources, pass rule) describe it, and `bench/material/bakery-sources/` holds the
two "primary sources" (price list and order page). The optional tests that read the material use the
env var `GAUNTLET_BENCH_MATERIAL` if you want to point them at another copy; by default they use the shipped one.

The bench is a **check, not a comparable measurement**. The lens set shipped as
`lenses\examples\bakery-content-plan.json` is the **bench lens set**: it was written after the bench
key was known, and three of its checklist lines point straight at three of the five planted errors
(the footer-logo line at C5, "compare every number in the strategy" at C4 — 8 against 12 reels,
"the call-to-action word and link named the same way" at C3 — `/preorder` against `/pre-order`). The
checklists of the earlier blind check had no such lines. So C3, C4 and C5 are scored separately as
"hinted", and only C1 and C2 are comparable with the blind check. Every bench row enters the ledger
marked contaminated (fixed key, `prePlanted:true`) and never counts toward the 25–50.

### 7.1 Inputs

| Input | Where |
|---|---|
| Material (pre-planted) | `bench\material\bakery` in the repo, read-only (never modify it; `$MATERIAL` below) |
| Fixed key: the 5 canaries with their target lenses | `bench\bakery.key.json` in the repo |
| The bench lens set (five lenses plus the generalist; hinted, see above) | `lenses\examples\bakery-content-plan.json` in the repo |
| Task text | `tests\fixtures\templates\tasks\bakery-content-plan.md` (the owner's task; it contains every `taskQuote` of the lens example) |
| Sources | `bench\sources.json` in the repo (point the two paths at `bench\material\bakery-sources\` in your clone) |
| Strip rules (tested on the material by `tests\bench\bench-strip.test.mjs`) | `bench\strip.json` in the repo |

### 7.2 Steps

1. **Copy the material** to a neutral bench folder (8 characters from `abcdefghjkmnpqrstuvwxyz23456789`),
   away from the repository (the review base must not sit next to `gauntlet` or `gauntlet-runs`):

   ```powershell
   $NAME = -join ((1..8) | % { 'abcdefghjkmnpqrstuvwxyz23456789'[(Get-Random -Maximum 31)] })
   $B = "$HOME\work-copies\bench\$NAME"
   New-Item -ItemType Directory -Force "$B\material" | Out-Null
   Copy-Item -Recurse "$MATERIAL\*" "$B\material"
   ```

2. **Task file:** copy `tests\fixtures\templates\tasks\bakery-content-plan.md` to `$B\owner-task.txt`.

3. **init** under a run root. Declare the three material folders as
   three roots, each named exactly like its folder: the fixed key's `file` paths are relative to
   the material root (`content-plan/page_text.json`, `render/out/B3.png`), and a canary is found in
   the review copy only under these names. The review base defaults to `<run root>\_wc`.

   ```powershell
   node $PL init --project bench-run --artifact-type marketing-plan `
     --project-dir "$HOME\work-copies\bench-project" `
     --root "$B\material\content-plan=content-plan" --root "$B\material\page=page" `
     --root "$B\material\render=render" --notes content-plan/AUTHOR-NOTES.md
   node $PL task set $RUN --from "$B\owner-task.txt" --source 'the owner, bench task'
   ```

4. **Edit `run.json`** before freeze:
   - `canaries.fixedKey = { "path": "C:\\src\\gauntlet\\bench\\bakery.key.json", "prePlanted": true, "approvedBy": "<owner label>", "quote": "<the owner's consent, verbatim>", "question": "<the exact question you asked the owner>", "date": "YYYY-MM-DD" }`
     (the key file must be in the repository's `bench\` folder; the run can never be declared done and
     every ledger row of it is contaminated);
   - `canaries.visualAllowed = true` (the key contains the VISUAL canary, the erased logo on slide B3);
   - `generalist` stays `true` (the example contains the generalist lens);
   - `limits.maxRounds = 1` (one round; the gate then stops with a report).

5. **Settings files:** copy `bench\sources.json` and `bench\strip.json` from the repo into `$RUN`
   (after pointing the sources at your clone).
   Both are tested: `strip.json` deletes only review traces ("the panel suggests" in the author notes,
   the heading "What the reviewers proposed and what went in" and the "Version 3 of this plan" line in
   `index.html`) and allows one product word (the bakery's "oven control panel"); every planted error
   still occurs exactly once. **mechanical.json**: plan JSON valid; 30 posts (`pointer` `/posts`). The first `step` runs
   the strip preview; if the material changed and it reports a trace, fix `strip.json` and `step` again.

6. **Setup with the fixed lens set.** `step` prints the lens-writer call (exit 10). Do **not** spawn
   it. Instead write the job's `answer.json` from the example: the example's content without its
   `taskSha256` (code adds the hash of `TASK.md` itself), plus `nonce` (stated in the job's
   `PROMPT.md`). Check it with the job's `check-answer.mjs` (it prints the answer code), then
   `step --answer-hash <job>=<code>` (freeze, exit 20). This hand-written lens answer is allowed only in
   the bench, because the lens set is the fixed bench set; it stays in the ledger.

7. **Round 1.** `step`: precheck, snapshot, copy; the fixed key is validated (each `after` must occur
   exactly once in the copy; nothing is applied), sealed and committed; one reviewer call per lens is
   printed (six with the generalist). Spawn all of them in one message; `step --answer-hash ...
   --usage ...`; continue through matcher and verifier calls until exit 20 or 30.

8. **Compute the result** (only after the round closed):
   `node $PL report $RUN --bench C:\src\gauntlet\bench\bakery.pass.json`.
   It applies the pass rule below to the run files and prints fixed Russian lines; the window does not
   judge the bench itself. What it reads: The round is the one `status $RUN` names (a
   `BLOCKED_*` attempt uses up a folder number, so it may be `rounds\02` or later):
   - own-lens catches: `rounds\<NN>\detections.json`, rows where `lens == targetLens` with outcome
     `caught`. Report **C1 and C2** (not hinted) and **C3–C5** (hinted) separately;
   - pair recall over the five bench lenses, again split C1–C2 / C3–C5, as a diagnostic **without an
     interval** (pairs are not independent: measurement.md section 8); report the generalist's pairs
     separately (`gate.json` → `panelCatch` counts all pairs). `seen_underclassified` is listed but
     does not count;
   - the two known false findings of the blind check — claims that look wrong but are right ("36 hours" and
     "Pick-up is free") — in `clusters.json`: they must not end `open`. `dropped` or absent passes; `unverified` or
     `contested` is a warning to look at.

   **Pass:** C1 and C2 each caught by their own lens; at least 2 of the 3 hinted canaries caught by
   their own lens; neither false finding open. (Reference, the first frozen template on a similar material:
   own-lens 4 of 5, pairs 19 of 25 — pairs from 5 planted errors, so no interval is given.)

9. **Close.** If the run is not already stopped, `abort $RUN --reason "bench: one round" --owner-quote "<the owner's consent, verbatim>" --question "<what you asked>"`. Then
   `cleanup $RUN` and delete the bench copy:
   `Remove-Item -Recurse -Force "$B"`. Keep the run folder: it is the evidence.

10. **Report to the owner**: show the lines printed by `report --bench` exactly as printed, plus the cost
    line of `report $RUN --summary`.
    If it failed: no real runs until the templates are fixed (a template change bumps
    `templates/MANIFEST.json` version) and the bench passes.

After the bench: first a real run on a small artifact, then the real plan.

---

## 8. Cleanup

- After a report (`DONE`, `STOPPED`, `ABORTED`): `node $PL cleanup $RUN`. It deletes leftover
  review-base folders of the run and all snapshots except best, last and done. Folders containing a
  junction or symlink are refused and listed. Remove such a link by hand with
  `cmd /c rmdir <link>` (in Git Bash `cmd //c rmdir <link>`); never `rm -rf` through it — Git Bash
  follows junctions and deletes the target's contents.
- Review copies are deleted automatically at round close; the run's folders in the review base
  (`<run root>/_wc/`) should be gone between rounds. Leftovers after a crash: `cleanup` (after the run
  ends) or `abort`.
- Keep run folders: they are the evidence behind every report. Never delete the data home's
  `measurements\`, `anchors.jsonl` or `runs-index.jsonl`.
- `selftest` deletes its workspace on success (`--keep` keeps it for debugging; delete it afterwards).
- Bench copies are deleted in the same session (section 7).

---

## 9. Measurement chores

```powershell
node $PL ledger stats --md                                   # writes STATS.md / STATS.json in the data home
node $PL ledger stats --instrument <id> --artifact-type marketing-plan
node $PL ledger verify-chain
node $PL ledger add-escape --run <runId> --description "<what slipped through>" --severity blocker --lens <id|none> --found-by owner --owner-quote "<the owner's words>" --question "<what you asked the owner>"
```

`add-escape` only on the owner's word, with the exact question you asked the owner (`--question`, refused without it, like every owner decision; the report of that run prints the escape under the owner's words and counts it in the check for one quote used for different decisions): it records a real problem found after "done" — the only direct
signal of real-error recall. How to read the numbers: [measurement.md](measurement.md).

`ledger stats` also prints "decoys rejected": how often verifiers refused the false findings mixed into their
batches, and "true controls dismissed": how often they refused or played down real planted problems mixed in with
them. Switching decoys off (`canaries.decoysPerRound: 0` in `run.json`) or the true controls off
(`canaries.controlsPerRound: 0`) is a protection set looser than the default: it needs `limitsOptIn` with the owner's words.

---

## 10. Platform notes (macOS and Linux)

- Paths: the data home is `~/gauntlet-data` (`GAUNTLET_DATA` overrides); project folders live under the
  run roots, default `~/work-copies/<project>/` (`GAUNTLET_RUN_ROOTS` overrides; on macOS and Linux
  the separator is `:` or `;`).
- Non-interactive ssh shells may not read your shell profile. If Node 24 is not found, prefix the
  command with the `PATH` that contains it; check with `node bin/gauntlet.mjs doctor`.
- Keep each run on one machine. The run ledger is anchored in that machine's data home; a run folder
  copied to another machine fails the anchor check (`TAMPER`). The measurement ledgers of different
  machines are separate files and there is no merge command yet (roadmap v2): only the ledger of the
  machine you pick as the ledger home counts toward the 25–50 planted errors; runs elsewhere report
  their own numbers only.
- Install: run the dry run first and read every target. If you keep several Claude config folders,
  install into one at a time with `node install/install.mjs --home <config folder> --apply` — the rule
  then goes into that home's own `rules/gauntlet.md` and `~/.claude` is not touched. Never `--apply`
  without the owner's explicit word.
- Models: reviewers and helpers default to the Claude subagent model of the home (Sonnet, effort high).
  Another model is a recorded opt-in by the owner's words (`owner --kind model-opt-in`).

## 11. Merging a change of the catalogs or templates while runs are live

A run freezes a hash of `catalog/*.json` (and of the reviewer templates) at setup. After a merge that
changes any of them, `step`, `owner`, `done` and `todo` of a run started before the merge stop with
`INTEGRITY FAILURE FROZEN_MISMATCH` (exit 3) and the run cannot continue. `audit` and `report` still work on
such a run (a finished one, to rebuild its report): they check everything else and say in plain Russian that
another program version rebuilt the report and which comparison (the word lists) could not be made. That is
«пройдена не полностью», not a failure; a changed word list under the same program version, or any change in
the run's own frozen files, still fails. So: do not merge into, or
switch, the checkout that live runs call until every such run has finished; otherwise accept that they
start again as new runs under the new catalogs (and the owner approves the templates again). Say this in
the merge notes. Editing only the `description` of a catalog file counts as a change too.

Any change to a file in `templates/` changes `templates/MANIFEST.json` (the version number goes up when a hash changes), so a data home that approved the earlier hashes needs `templates approve` again (the owner's words), and runs frozen before the change keep their old prompts.
