# Workflow mode (opt-in driver)

Allowed only when `run.json` has `"driver": { "mode": "workflow", "workflowOptIn": { "quote": "<the owner's words>", "date": "..." } }`
recorded before freeze. `step --driver workflow` (which the script passes on every call) refuses
without it, so record the owner's answer first.

## Start

Workflow tool:
```
{ scriptPath: "{{GAUNTLET_REPO}}/workflows/gauntlet.workflow.js",
  args: { cli: "{{GAUNTLET_REPO}}/bin/gauntlet.mjs", run: "<run folder>", maxSteps: 60 } }
```
Run it after setup (lens writer and freeze can also run inside it: they are ordinary `step` calls).
The workflow runs in the background and notifies the window when it returns.

## What the script does

1. A clerk agent runs `node "<cli>" step "<run>" --json [...]` and returns the exit code and the JSON
   envelope. The script recomputes the checksum `sha256(canonical(payload))` and compares it with
   `sig` when the exit code is 10 (the only case where the payload is acted on), and accepts only job
   calls of the one fixed shape and plain model names; a mismatch is retried once (the retry repeats
   `step` with `--driver workflow` only, so no token total or code is booked twice), a second mismatch
   stops the workflow ("run step by hand"). At any other exit code a payload the clerk did not copy
   exactly is reported as such in the returned line instead of stopping (r3-f11). The checksum has no key: it
   catches a clerk's copying errors, not a clerk that invents a payload.
2. Exit 10: every printed job is spawned in parallel with the printed call as the whole prompt,
   `effort: 'high'`, and `model` only when the job lists one.
3. The next `step` gets `--driver workflow --usage-delta <n>`, where `<n>` is the sum of the differences of
   `budget.spent()` read immediately before and after each of this invocation's own agent batches and
   clerk calls since the last report (never the turn's total: `budget.spent()` also holds the window's
   own work from the same turn), the agents' answer codes (`--answer-hash`, from each agent's "DONE <code>" reply), plus
   `--give-up <jobs>` for agents that died, and for jobs that were printed again after two spawns
   without an answer.
4. Any exit code other than 10 ends the workflow; its return string is `<exit> <state>: <payload>` and
   lands in the window transcript.

## After it returns

Act exactly as in Agent mode for the returned exit code (`reference/agent-mode.md`, steps 5-6):
exit 20 -> do the to-do, then start the workflow again (or run `PL step` by hand);
exit 30 -> show the owner `PL report "<run>" --summary` and the report path.
An agent that died is spawned once more on the next step (as in Agent mode), then given up. The last
clerk call of each invocation is not reported to the token count (its tokens are small).
The count has one remaining leak: tokens the window's own main loop spends WHILE a batch runs (if you
keep working in the window while the workflow runs) are inside that batch's difference. So do not
do other heavy work in the window during a run. If one record ends up above twice
`roundTokenEstimate`, `step`, `status` and the report call it `suspect`: read the number with
caution (it is still counted).

If the workflow was killed, resume it with `resumeFromRunId` or just run `PL step "<run>"` by hand -
`step` is idempotent and reprints the waiting calls.

## What Workflow mode adds and what it does not

Adds: you do not type spawn messages; panel tokens are measured by the runtime; every answer is bound
to its agent's code; the relay is checked by a checksum and the fixed call shape (accidents, not
forgery). Does not add (v1): the canary key is still sealed on disk; agents still have filesystem
access. The protections that matter (frozen templates, code-decided gate, hashes) are the same in
both modes.

<!-- gauntlet: installed copy of a repository file; install.mjs replaces it, --uninstall removes it -->
