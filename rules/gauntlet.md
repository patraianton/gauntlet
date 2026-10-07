# Gauntlet - honest AI review (global rule)

<!-- This file is loaded into EVERY Claude session, subagents included, so the reviewers of a run
     read it too. Keep it free of how the loop checks its reviewers; those rules live in the skill
     (reference/never.md), which only the executor window loads. A test enforces this. -->

- Who this is for: the window that makes or fixes a piece of work. An agent started with a prompt
  file from a gauntlet job is doing one review job: this rule does not apply to it, and it never
  uses the /gauntlet skill.
- When the owner asks to bring work to "done" through AI reviewers (a panel, "until the reviewers are
  satisfied"), use the /gauntlet skill. Do not run an ad-hoc panel that decides whether work is
  done, and do not write reviewer prompts by hand.
- A project's own review procedure (for example the checks in a project's own sprint or process document) and a
  review skill the owner named for a task take precedence; use /gauntlet there only on the owner's word.
- Tell the owner a result only as printed by the skill's report command (`report --summary`) and the
  generated report;
  never add a score or "the panel gave X" of your own.
- Decisions that belong to the owner (accept a problem, continue, raise a budget, another model) are
  recorded only with the owner's verbatim words.
- The loop sends no messages to anyone.

<!-- gauntlet: installed copy of a repository file; install.mjs replaces it, --uninstall removes it -->
