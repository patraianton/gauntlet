# Agent mode (default driver)

The window drives the loop by hand with the Agent tool. Same `step` state machine as Workflow mode;
the difference is that you type the spawn messages and report token numbers yourself
(honest limit: those are self-reported and the report marks missing ones as «оценено»).

`PL` = `node "{{GAUNTLET_REPO}}/bin/gauntlet.mjs"`.

## The loop

1. Run `PL step "<run>"` with the longest shell timeout (600000 ms; one step can rebuild the copy
   and run every source).
2. **Exit 10 - agents to spawn.** The output lists one or more calls. For each call:
   - spawn it with the Agent tool, `subagent_type: "general-purpose"` (configured with effort `high`);
   - `prompt` = the call text **exactly as printed**: no added words, no context, no "please be
     thorough", no summary of earlier rounds, no threshold;
   - `description` = the printed label (e.g. `reviewer:facts`);
   - `model` only if the job line lists one (an opt-in the owner approved); otherwise omit `model`.
   Spawn **every** printed call **in one message** (parallel tool calls). Do not run them one by one,
   do not drop any, do not add any.
   Each agent replies `DONE <answer code>` (16 hex characters printed by its answer check). Do not
   read their files. Spawn every printed call whatever its label: a `decoy` job beside the reviewers and
   a second wave of verifier calls after the first are normal.
3. Collect each agent's answer code and each Agent result's total-token number (the `total_tokens` /
   usage figure the Agent tool reports with the result) and run:
   `PL step "<run>" --answer-hash <job>=<code>,<job>=<code>,... --usage <job>=<tokens>,<job>=<tokens>,...`
   (job ids are printed with each call). Copy the codes exactly as the agents replied; never compute
   or "fix" one. An answer changed after its agent replied does not match its code: a
   reviewer's attempt then counts as invalid (its findings are still kept and verified, and the lens is
   reviewed again); any other agent's answer is rejected. A job with no code
   or no number: leave it out; the CLI accepts the answer unbound (the report counts such answers) and
   books an estimate for the tokens.
4. If an agent died or returned an error without writing its answer: run `step` again - it reprints
   only the missing calls - and spawn those once more. If one still fails, give it up:
   `PL step "<run>" --give-up <job>[,<job>]` (or `--give-up missing`). A given-up job counts as a
   failed review, never as approval.
5. **Exit 20 - your action.** Read the to-do (printed; again with `PL todo "<run>"`).
   - `FIX`: fix only what the to-do lists (open findings, requirements, mechanical failures). The
     "could not be confirmed" items are questions, not findings - answer them with evidence or take
     them to the owner. Then `PL step "<run>"`. If the to-do says nothing serious is open (a lens could
     not be checked this round), change nothing and run `PL step "<run>"`: the round is repeated.
   - `CONFIRM`: the material was clean in this round. **Change nothing.** Run `PL step "<run>"`; the
     blind confirm round starts on the same version.
   - `DONE` decision: run `PL done "<run>"` (re-hashes the live files and writes the report).
   - `BLOCKED_PRECHECK` / `BLOCKED_TRACE`: fix what is listed — a mechanical failure, a primary
     source that does not work now, a material file no lens must read (a file added after freeze), a
     folder link in the roots, or a review trace. A real leftover you remove by hand (or a strip rule,
     which may only delete review traces). **Never rewrite, reword or "normalise" material values to
     get past the trace scan and never split a word to hide it**: a legitimate product word or value
     is not yours to wave through: ask the owner the exact question the to-do prints, and only on the owner's yes
     add a `traceAllow` through `PL amend --what strip --owner-quote "<the owner's words>" --question "<what you asked>"`.
   - "material unchanged since round N": you ran `step` after FIX without fixing. Fix first.
     (`--same-material` exists for a deliberate re-check; it does not clear earlier findings.)
6. **Exit 30 - stopped.** Go to step 6 of SKILL.md: show the owner the 5 summary lines and the report
   path, then wait for the owner's words.

## What the window reads and does not read

Reads: `step` output, `todo.md`, `SETUP-SUMMARY.ru.md`, `REPORT.ru.md`, `status`.
Never reads during a round: job folders, `PROMPT.md` files, `answer.json` files, the review copy,
`gauntlet-data\sealed\`. After the round closes the answers are in the run folder; you still act
only on the to-do.

## While a round runs

From the first exit 10 of a round until `step` returns something other than 10, do not touch the
material. An edit during the round invalidates nothing silently: the version hash changes and the
next round is a working round again.

<!-- gauntlet: installed copy of a repository file; install.mjs replaces it, --uninstall removes it -->
