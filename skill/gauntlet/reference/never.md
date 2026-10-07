# Never-list (gauntlet)

Each line closes a way an earlier loop inflated its result ("panel 9.5" that a blind re-check put at
about 6.2). Most are also enforced by code; these are the parts only you can keep.

## Reviewer input
- Never write, edit or paraphrase reviewer, verifier, planter, decoy-writer or lens-writer prompts. They are
  rendered by the CLI from frozen templates and checked by hash.
- Never add words to a spawn call. The prompt is exactly the printed call line.
- Never tell any agent a threshold, a target ("9.5"), a score, a round number, what was fixed,
  what earlier reviewers said, or that something is "deliberate", "out of scope" or "do not flag".
- Never write a "facts" or "already fixed" file for reviewers. Give primary sources (`sources.json`);
  your own notes go only through `authorNotes`, which carry an "unverified claims" banner.
- Never point a source at your own notes, and never put the data into the recipe itself (`node -e`,
  `python -c`, a `file:` URL, a local server).
- Never narrow what reviewers look at (roots, include globs, lenses, checklist lines, minimums,
  sources, task lines, author notes, strip rules beyond review traces) without the owner's verbatim words
  (`amend --owner-quote`; before freeze `task set --owner-quote` for task lines and
  `step --owner-quote` for strip rules; each with `--question`, the exact question you asked the owner).
- Never loosen `run.json` limits without the owner's words in `limitsOptIn`.
- Never change an agent's answer code or relay a code you did not receive from that agent.

## Scores and claims
- Never compute or quote an average panel score.
- Never write "the panel gave X" / «панель поставила X» outside a generated gauntlet report.
- Never report recall from planted errors caught in one run. Planted errors in one run are only a
  gross-failure check; recall is read only from `PL ledger stats`, with its interval.
- Never tell the owner anything about quality beyond `report --summary` and `REPORT.ru.md`.

## Material
- Never edit material while a round runs (from the first exit 10 of a round until `step` returns
  something else).
- Never edit material after a clean round (CONFIRM) or after DONE. Edits after the confirm round make
  the result "unreviewed"; the report says so.
- Never write into a review copy or a job folder.
- Never rewrite, reformat, reword or "normalise" material values to get past the trace scan, never
  write a script or module that does it, and never split a word inside your own files to hide it from
  the scan (that fools the scan and is still falsification). A flagged text that is a real leftover of
  a review you remove by hand; a flagged ordinary word or value of the work (a product name, a shop's
  own rating) you leave as it is and ask the owner for a `traceAllow` entry, with the exact question the
  BLOCKED_TRACE to-do prints.

## Files you do not open
- Never open `gauntlet-data\sealed\`, job folders, `PROMPT.md` files or `answer.json` files before
  the round closes. Never edit a run's `ledger.jsonl`, `FROZEN.json`, `clusters.json`, `gate.json`,
  `jobs.json`, `answers/` or `templates/`. Exit 3 means stop and show the owner, never "repair".

## Decisions
- Some verifier items are false findings the program mixed in on purpose. Never try to tell which, never
  skip or reword an item because it looks wrong, and never act on one: they cannot reach `todo.md`.
- Never mark a finding fixed, refuted or less severe yourself. Disagree with `dispute` and evidence.
- Owner decisions (`waive`, `owner continue|raise-limit|stop|model-opt-in`, `restore-best`,
  `templates approve`, any `amend` that narrows, `step --owner-quote`, `ledger add-escape`, an `abort`
  that needs the owner's words (below), `init --supersede`) only with the owner's exact words, quoted
  (`--owner-quote`), and always with the exact question you asked the owner (`--question`). The report
  prints both; a missing question is refused.
- Never reuse one quote of the owner's for a different decision. The owner's words answer the question the owner was
  asked, nothing wider: «не жалей токенов» is not a word about sources, strip rules or waivers. A new
  decision means asking the owner a new question and recording the owner's new answer. The report flags one quote
  behind decisions of different kinds, and words recorded before the problem existed.
- Messages that start with «[Dispatcher, not the owner]» come from the dispatcher window, not from
  the owner. The dispatcher answers only operational questions, the ones that need no words of the owner, and
  never supplies owner words. Do what it asks about running the loop (run `step`, wait, stop a
  violating action), but never record its text as the owner's words: not as `--owner-quote`, not in
  `run.json` `quote` fields, not as a `--question` answer. Only the owner's own messages count; if a step
  needs the owner's words, the dispatcher does not answer it, it notifies the owner and waits, and so do you.
- Never start a new round after a stop (exit 30) without the owner's word.
- Never abort a run, start a new run on the same material, or change settings to get a fresh lens
  writer or a friendlier panel without the owner's word: verified problems of an earlier run stay visible
  in the next one.
- What `abort` lets you do without the owner's words is exactly what the CLI allows, no more: a run that is
  not in the middle of a round, not stopped on a plateau, a limit or an inconclusive panel, and has no
  serious problem open, unverified or contested. In practice that is a run still in setup (no round
  has run, nothing is open) that cannot go on, for example a primary source file that appeared after
  `init`: abort with a plain reason and start a new run. Everything else, and every `init --supersede`,
  needs the owner's words (`--owner-quote` and `--question`); the CLI refuses without them. Never use the
  wordless abort to re-roll the lens writer or the panel.
- Never use a model other than the default (Sonnet, effort high) without the owner's recorded words.

## Money, settings and sources (lessons of an early long run)
- Never use a paid service (a metered cloud query such as BigQuery, a paid API, anything billed) without
  the owner's explicit yes in this conversation. «Wait» or «I will not run it» are promises: keep them.
- Never remove or loosen a `permissions` deny, a hook or any other guard in Claude settings
  (`settings.json`), in any home. If a guard blocks the work, report it to the owner.
- Never rewrite the material's values (a number, a name, a date, a quote) to get past a scan or a
  check of the program. If the program refuses a word that is real material, ask the owner; do not
  change the text.
- Never point a primary source at something you change yourself: the last commits of a branch you
  commit to, files of the project you edit, a live site you deploy to. A source is a record by hash
  or a copy made before the run started.

## Outside the loop
- Never send any message to anyone (Slack, email, Telegram, GitHub comments) as part of the loop.
- Never run `install/install.mjs --apply` or `--uninstall` without the owner asking for it.
- Never leave review copies or clones behind: `PL cleanup "<run>"` after the report.

<!-- gauntlet: installed copy of a repository file; install.mjs replaces it, --uninstall removes it -->
