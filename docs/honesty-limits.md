# Honesty limits

What gauntlet v1 protects only with prompts (PROMPT) or only by making things visible (EVID), and
what it cannot protect at all. This file mirrors [SPEC.md](SPEC.md) section 20; the spec wins if they
differ. Read it before trusting a "готово".

## Threat model

gauntlet is built against an **honest-but-optimising executor**: a window that wants its work to
pass and will, without meaning harm, steer reviewers, soften the brief, trust its own notes or polish
the result after the last review — exactly what happened in the original incident. Against that executor, most
steering is either structurally impossible (CODE, STRUCT, SEP) or impossible to do silently (EVID).

It is **not** built against a deliberately forging executor. Such an executor could rewrite a whole
run folder, the anchors in the data home and every hash consistently. The system is
tamper-**evident**, not tamper-**proof**.

## The limits

1. **Agents have shell and filesystem access.** Reviewers could wander out of their folder, read
   sibling job folders under the review base, or search the disk for run folders. Mitigation:
   neutral random paths; the review base is a folder of its own (default `<run root>/_wc`, with run roots from `GAUNTLET_RUN_ROOTS`), checked
   to be absolute, outside the material, the run folder, the repository and the data home, with no
   run folders, repository, data home or key files in it or next to it; no run-folder or repo path in
   any prompt; the planter's and validator's answers, the slots, the chosen planted edits and their
   prompts stay in the sealed data-home folder until the key is revealed (only hashes in the run
   folder); answers moved out of job folders at ingest; copies deleted at round close; an instruction
   not to read anything else. A reviewer that deliberately searches the whole disk can still find run
   folders of other rounds. Not enforceable without a sandbox. *Level: PROMPT + STRUCT for paths.*

2. **Agent mode relies on the executor in four places.**
   - It types the spawn text. The text is one fixed line pointing at `PROMPT.md`, and the prompt hash
     is checked at ingest, so an edited prompt makes the attempt invalid; but words *added* to the
     spawn message ("this is the final pass, report only blockers") are not refused by any script. Each
     reviewer copies the message it was started with into `instructionReceived`; ingest compares it
     with the fixed call and the report counts reviewers whose copy differs (r3-f10). A window that adds
     words can also ask the agent to copy only the plain call, so this makes careless steering visible,
     not deliberate steering. This weakens failure points 1, 3, 4 and 5 in Agent mode; Workflow mode
     sends only the fixed call. *PROMPT, made visible: EVID.*
   - It relays each agent's answer code ("DONE <code>", the first 16 hex characters of the answer's
     sha256, unsalted). In Agent mode the window could compute that code itself for an answer it
     edited — or even wrote — so the code binds the file against accidents, not against the window.
     A reviewer answer whose code does not match keeps its findings (they are clustered and verified)
     but counts as an invalid attempt, so the lens is reviewed again: relaying a wrong code cannot drop
     an inconvenient answer. Without a code the answer is kept and counted as unbound in the report and
     the summary; given-up and rejected reviewer answers are counted in the summary too. Deleting an
     answer file and giving the job up still re-rolls that one attempt (visible as a given-up job).
     *CODE in Workflow mode (the script relays the agent's own reply); EVID in Agent mode.*
   - The canary key and the planting files sit sealed in the data home while the first wave of
     reviewers works. The executor could read them. It gains little: it neither plants, matches, gates
     nor reports, and every step leaves hashes. The key is revealed into the round's run folder once the
     first wave is ingested; a lens reviewed again in that round (a rerun after an invalid attempt or a
     missed attention check) is reviewed on the same planted copy **while the revealed key is in the run
     folder** (r3-f12). The rerun reviewer is a fresh agent whose prompt names no run folder, and the
     review base is refused next to run folders, so it would have to search the disk for it (limit 1).
     Reruns decide only whether the lens is valid; a cheating rerun could make an unreliable lens look
     valid. Keeping the key sealed until the last wave is v2. In Workflow mode the key is also on disk
     (held in memory is v2). *EVID.*
   - Token numbers are self-reported. Missing numbers, and numbers below a quarter of the per-agent
     estimate (at least 1000), are booked at the estimate and marked «оценено» in the report, and the
     report says the numbers came from the executor window; the next-round estimate never drops below
     `roundTokenEstimate` (r3-f7); `--usage-delta` (and the legacy `--usage-total`) are accepted only
     with `--driver workflow`. The token limit is therefore CODE on self-reported numbers. Workflow mode
     measures them: the script reads `budget.spent()` right before and after each of its own agent batches
     and clerk calls and reports the sum of those differences (`--usage-delta`), never the turn's total.
     Remaining limits: the final clerk call of an invocation is not reported; tokens that the window's
     own main loop spends WHILE a batch runs (the window working concurrently) land in that batch's
     difference; a single record above twice `roundTokenEstimate` is marked `suspect` (ledger, `status`,
     report) but still counted. The old whole-turn total swallowed the window's own coding (in a long early run:
     1.6 M, 3.6 M, 5.3 M for a step that cost 0.34 M) and stopped a run at 16 M counted against about
     6-7 M real. *EVID.*

3. **The executor types the owner's words** — `OWNER-TASK.md`, every `--owner-quote`, the Workflow
   opt-in, model opt-ins. A fake quote cannot be detected by code. Evidence: every one of them is
   printed back to the owner in the report (task, «Что убрано из задания», «Что вы решили сами»). the owner is
   the check. *EVID.*
   Each decision is recorded with the question it answers (`--question`, always required; the same for
   the quotes written into `run.json` and for `ledger add-escape`), and the report
   flags one quote used for decisions of different kinds and words older than the problem they are
   attached to (in a long early run: a quote about spending tokens also backed a change of sources).
   Code cannot tell whether the owner really said the words, and cannot see a reuse that hides behind
   a slightly different wording; the flag is a pointer for the owner, not a block. A dispatcher window's
   messages are not the owner's words either: they carry the label «[Dispatcher, not the owner]»; the
   dispatcher answers only operational questions and never supplies owner words, and keeping that text out of `--owner-quote` is a rule for the executor (`never.md`), not something
   the code can check. *EVID.*
   What depends on those words is printed where the owner reads first: waived problems, other owner
   decisions, requirement lines cut from the task and limits looser than the defaults turn the
   headline into «Готово с вашими исключениями» and add a summary line with the owner's first words.
   The same holds for `amend --what lenses`: it installs a lens file the executor wrote. It needs the
   owner's quote, the change is diffed and logged, and the report lists it — but the new lenses are not
   written by a separate agent. *EVID, not SEP.*

4. **The executor declares the material roots, sources and strip rules.** A weak part kept outside
   the roots, or a source that conveniently cannot see a problem, is not reviewed. Coverage checks
   (at setup and every round), requirement marks by every reviewer, the `unlistedRecent` warning
   (fresh files excluded by globs) and the list of roots, sources (with their stated origin) and strip
   rules in SETUP-SUMMARY and the report reduce the chance but do not remove it. A source that reads a
   file inside the material, the run folder or the project working folder, or a file written after the
   run started, is refused; so is a recipe that runs code written on its command line (`node -e`,
   `python -c`), names a `file:` URL or a loopback host, or names one of those folders anywhere in
   an argument. The "written after the run started" test reads the file's modification time, so a
   file written after `init` with its date set back passes setup; every round start then compares the
   hash of every file a source reads with the setup baseline, so any later edit blocks the round
   (r3-f3). A facts file or a script written earlier somewhere else that prints constants is not
   detected by code — the owner sees its recipe and origin. A recipe that reads a moving target (a git ref that
   is not a full commit hash, a `git log` without a pinned range, a file inside the executor's own git
   working tree) is flagged by its shape and kept only on the owner's words; code cannot see a moving
   target hidden behind a script or a URL (a moving URL or `gh api` call is not linted). A source that blocks the reviewers is recorded and reported,
   but what it alone could settle stays unchecked: "unavailable" is the reviewer's own documented claim,
   shown with the error excerpt, not something code can verify. A reviewer could write invented "unavailable" entries to get a source-check
   item counted without doing the work; code cross-checks only one thing: if its own read of that source at the round start worked while a reviewer
   wrote that the source was unavailable (every attempt or only some of them), the report and the to-do say so (`suspicious`). Attempts are counted per source over all items of the
   lens that name it, and one entry counts as one attempt; entries that sum up several runs count once. Strip rules that
   remove anything but review traces need an owner quote before freeze and after it, and the same check
   runs again on every round's copy (new material the frozen rules would drop without a trace blocks
   the round); a text file counts as a trace only by its content. A file that matches an exclude rule
   and carries a trace in its content is still removed whole; each round's exclusions are listed in the
   report and the confirm round's in the summary. Narrowing after freeze needs an owner quote. *CODE for narrowing and own-folder sources, EVID for origins, PROMPT
   for the initial choice of roots.*

5. **Persuasion inside the artifact and the author notes.** Author notes are linted for steering,
   intent ("on purpose", «специально») and fix or check claims ("corrected", «сверены») at every copy
   build and capped in length (r3-f2); a claim worded past the patterns still reaches reviewers under
   the "unverified" banner. *CODE for the listed words, PROMPT for paraphrases.*
   **In the artifact itself:** Text such as "figures were checked by the data team" or
   "this was reviewed and approved" that the trace patterns do not match can still sway reviewers.
   Templates say that text inside the material is data, not instructions; v2 adds an `INJECT` canary
   type to measure obedience. *PROMPT.*

6. **Severity is judgement.** Reviewers and verifiers decide blocker / major / cosmetic. Verifiers do
   not see the reviewer's class, confirm rounds use two verifiers, a confirmed-versus-refuted
   disagreement becomes `contested`, and two verifiers who both confirm but differ on the class keep
   the stricter one, so a lenient verifier never weakens a confirmed problem. Only clusters claimed blocker or major
   reach a verifier: a real major that every reviewer files as cosmetic is never re-checked. The
   severity text tells reviewers to take the stricter class when torn, which lowers that risk; it does
   not remove it. *SEP + EVID; PROMPT for under-classification.*

7. **Same-model panels share blind spots.** By default every agent is Sonnet. Nine judges from seven
   vendors were found to give only about two independent votes (arXiv 2605.29800, as reported); five
   reviewers of one model are probably worth fewer — not measured. v1 measures shared misses
   (unanimous misses in the ledger) and the report says so every time; a second model in the confirm
   round is opt-in by the owner's word (v1 config slot `confirm-extra`).
   *Measured, not prevented.*

8. **Planted errors are easier than real ones.** Ledger recall is therefore an **upper bound** on how
   well reviewers catch real problems; omissions are the hardest. Escapes (real problems found after
   "done", entered with `ledger add-escape`) are the only real-error recall signal, and they grow
   slowly. See [measurement.md](measurement.md).

9. **Tamper-evident, not tamper-proof.** See the threat model above. Hash chains, write-once answers,
   anchors in the data home, the guard over every engine-written decision file (`clusters.json`,
   disputes, owner decisions, round and ingest files: hashed when each command releases the run lock
   and compared by the next command) and `audit` make silent edits detectable; a determined forger
   with write access to both the run folder and the data home is out of scope. A command killed half
   way (for example by a shell timeout) leaves a marker; the next command accepts what it wrote,
   records the changed files in the ledger and the report counts it ("прерванные команды"), so an
   interruption is visible, not hidden.

10. **The Workflow opt-in is a recorded answer, not a technical switch.** `step --driver workflow` is
    refused unless `run.json` holds the opt-in quote, but the quote is typed by the executor
    (limit 3); the quote is evidence that it asked.

11. **The Workflow relay checksum is not a signature.** `step --json` prints sha256(canonical payload)
    without a key; the script recomputes it. That catches a clerk agent that garbles or truncates the
    output by accident. A clerk that invents a payload can compute a matching checksum. Against that,
    the script accepts only job calls of the one fixed shape (the agent-call line pointing at a
    `PROMPT.md`) and model names of a plain shape, so an invented job cannot carry other instructions;
    an invented exit code or decision is still possible. *CODE for the call shape, PROMPT otherwise.*

12. **The global rule reaches every session, reviewers included.** `~/.claude/rules/gauntlet.md` is
    loaded into every Claude session through CLAUDE.md, so every reviewer reads it. It therefore says
    only "use the /gauntlet skill; report only the generated summary" and nothing about how the loop
    checks its reviewers; a test and `doctor` refuse internals in it. The skill's description (listed
    in every session) says that reviewer agents check work in rounds, no more. The rule is addressed to
   the window that makes the work and tells agents of a gauntlet job to ignore it; every agent
   template forbids skills, slash commands and plugins. Whether an agent obeys is not checked by code:
   the test checks only the wording. *PROMPT (the wording itself: CODE by test).*

13. **The planter is the same model as the reviewers, and no human checks the planted errors.** A
    shared blind spot makes planted errors easier for the same model to find, and some planted
    "errors" may not be errors at all (research 3.3: about 82.5 % real defects, 5 % non-errors,
    12.5 % disputed, as reported). A non-error that is missed lowers recall in the ledger; a non-error
    used as an attention check can mark a lens unreliable and stop a run. v1 has an agent validator
    only; a human spot check of a sample per run (logged as `humanChecked`) and a planter of another
    model are v2. *Measured with this caveat, not prevented.*

14. **A dispute's evidence command is chosen by the executor.** Its arguments and output are linted
    and shown verbatim to two independent dispute verifiers, and a cluster closes only when both
    withdraw it, but the command itself (`node -e` included) is not restricted to the frozen sources.
    *CODE (lint, two verifiers) + EVID (every dispute is listed in the report).*

15. **The English templates are not yet measured.** The blind-experiment evidence (19 of 25 reviewer × planted
    error pairs, from 5 planted errors; own-lens 4/5) is for the Russian first reviewer template draft. The bench
    run (runbook section 7) must pass before the first real use; its lens set was written after the
    bench key was known, so its result is a check, not a comparable measurement.

16. **Visual planted errors need a rebuild.** Without `run.rebuild` no error can be planted in an
    image, so whether reviewers look at images is not checked; SETUP-SUMMARY says so when the work has
    images. With a rebuild, visual planted errors are on by default.

17. **A round can lack a planted omission.** One omission is planned per round; if the planter and the
    validator fail twice on it, the slot is dropped. Report section 8 says so, and for the confirm round
    the summary says so; DONE is not refused for it. *EVID.*

18. **A bench run reuses a known key.** `canaries.fixedKey` needs the owner's words with their question and a key file from
    the repository's `bench/` folder; such a run is never declared done and every ledger row of it is
    contaminated. Test mode (`GAUNTLET_TEST=1`) lifts the folder rule; test runs are marked seeded in
    the report. *CODE + EVID.*

19. **The reviewer templates are approved by the owner, not proven unchanged.** A template version is
    usable only after `templates approve --owner-quote` recorded it in the data home (r3-f6), and
    SETUP-SUMMARY and the report print the version with the date and words of that approval. The
    executor types those words (limit 3). *EVID.*

20. **The trace scan reads text only.** Every file that decodes as text is scanned, whatever its
    extension (UTF-16 included, r3-f15); genuinely binary files (office documents, archives, PDFs)
    are not, and SETUP-SUMMARY lists them under «Файлы, которые программа не читает как текст».
    A `traceAllow` entry is a literal product phrase with one trace word, approved by the owner and
    listed with its match count (r3-f1). *CODE for text, EVID for binaries.*

    **The scan is defeated by splitting a string, so it catches accidental traces, not deliberate
    ones.** A word written as `"pan" + "el"`, a value built at run time, a homoglyph or an
    encoding the scan does not decode (base64, a zip inside a data file) passes. In a long early run a
    window did exactly this in its own tools: it rewrote 182 values of its evidence data to get
    past the scan and split the flagged words inside the rewriting code "so that this file passes
    the same check". The scan cannot see intent. What stops it is the rule «never rewrite material
    values to get past the trace scan; ask the owner for a `traceAllow` entry» (`never.md`, and the
    BLOCKED_TRACE message says it), plus the report and the human reading the evidence files; the
    program does not prove it. To keep honest windows from being pushed into this, a LARGE data file
    (`.csv .tsv .jsonl .ndjson .json` over 1 MiB or 2 000 rows) is scanned with the unambiguous
    patterns on its lines and with every pattern on its prose-like values (4 or more words, or 30 or
    more characters): a shop's own rating "9,5" or the word "panel" in a short product name is not a
    trace, but "deliberate, do not flag" in a long text value is. Small data files get every pattern.
    **Version words are narrowed (bug 15).** The scan catches the history of the reviewed work itself
    («версия 3 плана/документа/отчёта», «Версия 7. Собрано …», «по сравнению с версией 2», «в версии 3
    исправлено», «предыдущая версия», "version 3 of the plan", "previous version", "v2 → v3"), not
    product numbering («Версия 1 — один тег, Версия 2 — приложение», «API версии 3»). Besides the
    document-noun forms («версия 3 плана», «версия 3 этого плана», «документ версии 3»), the scan also
    catches a version number followed by a review note («Версия 3 (после замечаний)», «Версия 2 —
    учтены замечания», "Version 3 (after review)", "Version 3 — fixed typos"), a change note against an
    earlier number («Что изменилось с версии 2», «в отличие от версии 2», «Обновлено в версии 4»,
    "changes since version 2", «версия 2 → версия 3»), a line that only says «Это версия 3.», and «в версии 3
    добавлен раздел». The price, in both directions. Still passing: a bare «Версия 3» heading, a
    plain changelog line without a noun, a review note or a fix verb («в версии 3 добавлен экспорт»,
    "version 4 of the checkout"), and a bare "since version 3". Still stopped although they may be
    product text: «Версия 1 → Версия 2» as an upgrade path, "in contrast to version 2",
    «версия 2 материала темы»; the window asks the owner for a `traceAllow` phrase for those. «работа»
    and the plain nominative of «описание» / «материал» after the number are not counted as a
    document noun («версия 3 работы блока» is how a block works). The rest of the loop does not
    depend on this word: earlier verdicts, rounds, scores and «исправлено» are caught by their own
    patterns. After this narrowing a `traceAllow` phrase that no longer covers a trace word is refused
    (a phrase that covers nothing is not needed); delete it, which needs no owner words, and do not
    copy `strip.json` from an older run. *CODE; the gap is accepted.*

    What is read with the reduced set is counted: SETUP-SUMMARY and the report list the large data
    files, how many short values were not checked with every pattern and how many patterns that is.
    A short value (a number, a name) can still carry a trace word that the reduced set does not look
    for. *EVID.*

21. **Model and effort come from the Claude home.** Reviewers run with no explicit model unless the owner
    chose one, so the model is the home's `CLAUDE_CODE_SUBAGENT_MODEL` and, in Agent mode, the effort
    is the home's `agents/general-purpose.md`. `doctor` checks both in the window's home and
    SETUP-SUMMARY says «Sonnet, высокий уровень старания» only when they hold, «не проверено» otherwise
    (r3-f20). *EVID.*

22. **Another data home hides earlier runs.** `init` compares the new run with earlier runs (by
    folder and by file contents, r3-f8) only in its own data home; a run started with another
    `GAUNTLET_DATA` prints a warning and the report says so. *EVID.*

23. **A word of the work is not "talking about the check".** A reviewer answer that mentions a
    meta word ("canary", "attention check", "planted error", "honeypot", ...) is invalid, unless
    code can show the text comes from the work: a verbatim quote with context found in the review
    copy or in a primary source output, a search term that the source output really contains, or,
    for the one catalog word marked `quotableTerm` (honeypot, an ordinary anti-bot form field in
    code), a whole word the material itself uses. Excused hits are stored in the ingest record and
    counted in the report. Limits: a reviewer who uses an excused word on purpose to signal something
    is not caught (the word then carries no information about planted errors, because the material
    has it too); a paraphrase of a quote that is not verbatim is excused only for `quotableTerm`
    words. *CODE.*

24. **A large data file is reviewed through a sample.** A data file over the threshold (default 1 MiB or
    2 000 rows) is read by reviewers as a random sample of its rows (default 200, capped at 100 000
    characters per file and 250 000 over all large files together, never below 20 per file), chosen by the program after the snapshot, sealed with the canary key and
    new every round; the planted errors in such a file sit only in sampled rows (SPEC 14.10, D40).
    Nobody is obliged to read the other rows, so errors there can stay; a reviewer may run a script over
    the whole file, but nothing forces it. The sample is uniform, not stratified, and capped in
    characters, so a rare kind of row can be missed, and the rows of a wide table cost more of the cap.
    The report states per round and file how many rows were seen out of how many and says what «Готово»
    then means, but it cannot say how many errors lie outside. The draw, the sealing, the planter's
    constraint, the rewritten minimum and the read-check lines are code; that reviewers actually read
    the sampled rows is a prompt rule backed by the read checks, which are drawn from those rows
    (EVID). *Level: CODE for selection and constraints, PROMPT + EVID for reading.*
    A big text data file that has no rows to draw from (a JSON object, XML, SQL, text, log) gets no
    sample at all: the program only lists it (reviewer prompt, setup summary, report section 7) and
    tells the reviewer to check its structure and spot-check it; what is inside stays unchecked unless a
    reviewer chooses to look. Many small files of one kind in one folder are treated as one data set
    once they pass 4 x the file threshold together; a data set split across folders, or across kinds
    (the same records as csv and as json), is not recognised as one. *Level: CODE for the list, PROMPT for what the reviewer does with it.*

25. **Decoys measure "can the verifier say no", not "how good is it".** A decoy is easier to refute than a
    subtle real error, so the rejection rate is an upper bound. Its proof is a quote that code finds in the copy,
    not a judgement of an agent: a decoy whose claim is in truth right (the writer misjudged) is confirmed by an
    honest verifier, taints that verifier's batch, costs a re-check and lowers the measured rate; the report lists
    the confirmed ones. The decoy writer has the planter's model, so a shared blind spot with the verifiers is
    possible. A decoy item carries a cluster-like id that is no cluster in `clusters.json`: a window that compares
    `verify-items.json` with `clusters.json` before the round closes can tell them apart (the key itself is sealed
    in the data home; the system is tamper-evident, not tamper-proof). Several decoys shown to one verifier job,
    and one decoy shown to two jobs, are not independent trials. Runs frozen before template version 9, bench
    runs and `decoysPerRound: 0` use no decoys. *CODE + EVID.*

26. **True controls measure "do the verifiers keep real problems alive", not "how good are they".** A control is a
    reviewer finding that the matcher matched to a planted error, mixed into the verifier batches in the reviewer's
    own words. It is an edit the program made itself in a place a reviewer already pointed at, so it is easier to
    confirm than a defect nobody noticed: the dismissal rate is a lower bound of the real acquittals. The matcher is
    an agent, so a loose match can give a control whose claim is not quite true of the planted edit (code-settled
    matches are preferred, and the report prints the counts). The yardstick for "downgraded" is the planted class
    (the floor of the error); a class is a judgement, so a verifier that calls a blocker-floor error major counts as
    downgrading it. Controls exist only where reviewers caught planted errors: a round in which they caught none tests
    no verifier. A control carries a cluster-like id that is no cluster in `clusters.json` and equals no decoy's id;
    the key is sealed in the data home (tamper-evident, not tamper-proof). Several controls in one verifier job, and
    one control in two jobs, are not independent trials. A verifier that failed a control is also not believed when
    it makes a serious item cosmetic; a lowering from blocker to major is not re-checked (the item stays open either
    way). A control verdict with no class counts as `undecided`, and no evidence is required for `kept`. Bench runs
    and `controlsPerRound: 0` use none. *CODE + EVID.*

27. **A round with an invalid lens is a weak round for the plateau rule.** The plateau counts every round that reached
    the reviewers, because a lens that is invalid in every round must not keep a run from stopping (SPEC 13.2). But such a
    round has too few open problems: the blind lens found nothing. So the minimum that later rounds must beat is taken
    over fully valid rounds when there are any, and a blind round whose count looks better than that minimum breaks
    the streak instead of counting. The price is that the run may go on longer than needed (capped by `maxRounds` and the
    token limit); it never stops early because of a blind round. `best` has no such protection: it can name a blind
    round, and says so with `lensesValid: false`. *CODE.*

28. **"Who wrote into the copy" is a reading of file times.** When the copy changes while reviewers work the round is void and
    the record names the files and the reviewer jobs whose working time holds each file's modification time (SPEC 14.13). A tool
    can keep or set an old modification time (copying with `-p`, `touch`), a removed file has none, and a job's window runs to the
    moment its `answer.json` was finished, so the list says who was running, not who wrote. A reviewer's scratch folder lies
    outside the copy and the prompt forbids writing into the material, but a reviewer is an agent with disk access and can still
    do it; the second hash catches it, it does not prevent it. The one tolerated case (only added `__pycache__` byte-code or
    `.pytest_cache` files, removed again and the copy re-hashed) assumes such files carry no review material. The names are narrow
    (only the files pytest writes; byte-code only with a valid header and its source in the copy) but the content is not read in full: a
    reviewer who writes a valid-looking file there could still pass a note to another running reviewer, and the engine would delete it
    and count the round. The per-job scratch folders sit side by side outside the copy and have the same property. The ledger names
    the removed files (first 20). Any other new file voids the round. The "who was running" list is also weak for a job that gave
    no answer: its window stays open, so it is named for every later write. *CODE + EVID.*

29. **The code cross-check of findings is a rule on quotes, and a rule can be wrong both ways (SPEC 14.6a).** A finding is
    taken for the planted error when its quote sits on the planted words: 12 characters at least, at most twice the planted
    passage plus 40, standing once in the file, and covering 60 % of the changed characters. Narrow on purpose: a quote of
    the neighbouring lines, of the unchanged beginning of the same line, of a whole section, a bare number, or in another file
    is not taken. Two prices. (a) A reviewer who quotes the planted sentence to complain about something else in it is counted
    as having caught the planted error, and that other complaint does not reach this round's to-do list (the matcher's explicit
    word "score below 3, `alsoReal`" for that very pair prevents it); recall can be a little too high for that reason. (b) A
    reviewer who points at the planted place with a short quote (a core of the changed words) is left to the matcher, so a
    matcher that misses it still lets that finding through. Omission and visual planted errors have no planted words and are
    left to the matcher entirely. The other half of the fix is a plain bug: the matcher's `alsoReal` used to keep a finding
    real whatever pair it was written on; now it counts only on the pair that matched the finding. The report lists every
    place where the code and the matcher disagreed. Three more prices. (c) When the matcher scores the very pair below 3
    and sets `alsoReal`, the matcher's word stands: the finding stays among the real problems even if it quotes the
    planted words, so a planted error can still reach the to-do list; the report names such findings in the
    `crossKept` line. (d) A code catch is written as a detection row before the lens facts are computed, so it also
    counts for the attention check: a lens can be judged valid because its reviewer merely quoted the planted words.
    (e) The check only adds catches. An earlier stage-1 catch whose finding never found the planted error (it was
    matched by position or by a neighbouring line) is not taken back, so recall and the attention statistics can still
    count a false catch; the measurement ledger rows do not say which catches came from the code and which from the
    matcher. *CODE + EVID.*

## What "done" therefore means

`DONE` means: two clean rounds in a row on one version, the second blind with a fresh panel, fresh
planted errors and double verification; every lens passed its attention check; zero verified
blockers and majors in the worst lens; the delivered files are identical to the reviewed ones (text,
JSON and HTML files are compared after removing a BOM and normalising line endings; other files byte
for byte); and the integrity audit passed when `done` ran (a failed audit refuses `done`). If the owner waived
problems, cut requirement lines or loosened limits, the headline says «Готово с вашими исключениями».

The integrity audit cannot always make every comparison. A report of an older run rebuilt by a newer
version of the program cannot compare the program's own word lists (`catalog/*.json`, the list of planted-error
kinds) with the hashes taken when the run froze: the lists changed with the program. The audit then still
runs every other check, and the summary and report section 13 say «пройдена не полностью» with the version
the run started with, the version that rebuilt the report and the lists that were not compared. This is
allowed only when FROZEN.json and the running program both name a version (or a git head) and the two differ;
a copy of the program with no readable git head proves nothing and does not excuse an edit. The same
version with other lists, or any change in the run's own frozen files, fails the audit. Limit: a list edit
that comes with a new commit cannot be told from a program update, and only the «not compared» line of the
summary and of report section 13 shows it; `step`, `owner` and `done` still refuse such a run. In a report
that is being rebuilt, the check of the report numbers compares two readings of the same files, so it
cannot fail; section 13 of a rebuilt report proves the chain, the frozen files and the templates, not the
numbers. A partial pass («пройдена не полностью») exits with 0, like a full pass: a script that wants to tell
them apart must read `notCompared` (the `NOT COMPARED` lines). A report that is
older than the last events of the run is listed as «not compared» too (its numbers describe an earlier
state), never as a failed honesty check and never as a pass. *CODE; the version label is read from
FROZEN.json, which the run's own ledger pins.*

It does not mean the work has no serious problems. The fixed report sentence says it: «Перепроверенных
серьёзных проблем в слепом круге не осталось. Это значит «проверяющие таких не нашли», а не «их
нет».»

## Agent mode vs Workflow mode

| Aspect | Agent mode (default) | Workflow mode (opt-in) |
|---|---|---|
| Who types the spawn calls | the executor window (fixed one-line text) | the script |
| Relay of `step` output | the window reads it | a clerk agent; payload checksum recomputed by an inlined SHA-256 (catches accidents, not forgery: limit 11); job calls must have the fixed shape |
| Answer codes ("DONE <code>") | relayed by the window with `--answer-hash` (it could compute them; unbound answers counted) | relayed by the script every time |
| Panel tokens | self-reported, estimates marked «оценено» (numbers below a quarter of the per-agent estimate replaced) | measured as the sum of `budget.spent()` differences around the script's own agent batches and clerk calls (the last clerk call of an invocation unreported; concurrent main-loop work can leak in; a record above 2x the round estimate is marked `suspect`) |
| An agent that died | spawned once more on the next `step`, then given up | the same: re-spawned once, then given up |
| Canary key during review | sealed on disk for the first wave; in the run folder during a lens rerun (limit 2) | the same (in-memory is v2) |
| Spawn message | typed by the window; added words counted through `instructionReceived` (EVID) | only the fixed call (CODE) |
| Agents' filesystem access | yes | yes |
