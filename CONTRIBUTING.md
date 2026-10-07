# Contributing

Thanks for looking. Gauntlet is small and strict on purpose, so a few rules keep it honest.

## Before you start

- Open an issue first for anything bigger than a typo or a one-line fix. Say what you want to change and why.
- Read [docs/SPEC.md](docs/SPEC.md) (it is the contract) and [docs/honesty-limits.md](docs/honesty-limits.md).
  If your change touches behaviour, update the spec in the same pull request.
- The project's main rule: **nobody who benefits from a pass writes the instrument.** A change that lets the
  executor write, soften or skip a reviewer prompt, a canary, a verdict or a report number will not be merged.

## Set up and test

```bash
node --version                    # 24 or newer; there are no npm dependencies
npm test                          # the whole suite
node bin/gauntlet.mjs selftest    # full offline run with scripted agents, no LLM
node bin/gauntlet.mjs doctor
```

- Point the data home at a temporary folder when you run the CLI by hand:
  `GAUNTLET_DATA=$(mktemp -d) node bin/gauntlet.mjs ...`. The tests do this for you.
- Tests must be green. `r2-f21` is known to be flaky under load: re-run it alone
  (`node --test --test-name-pattern r2-f21 tests/cheater/round2.test.mjs`) before blaming your change.
- If you change a file in `templates/`, regenerate the manifest with `node templates/update-manifest.mjs`
  (it bumps the version) and say so in the pull request. Templates are frozen by hash; owners must re-approve them.

## Good first contributions

- **An English owner report.** The report, the summary and the setup summary are generated in Russian only
  (`lib/report/`). A second language behind a setting is the most useful thing to add.
- More example lens sets in `lenses/examples/` (with a task fixture and a file-list fixture in
  `tests/fixtures/templates/`).
- More canary types in `taxonomy/`, with tests.
- Docs: anything that confused you on first read.

## Style

- Plain Node 24, ES modules, no dependencies. Keep it that way.
- Code decides, prompts only ask. If a rule can be a check in code, make it a check in code.
- Be honest in docs: mark every protection with its level (CODE, STRUCT, SEP, EVID, PROMPT) and never claim more.
- No real names, customers, paths or private data in examples, tests or fixtures. Use invented material.

## Pull requests

- One topic per pull request, with tests.
- Describe what changed and what you ran. Do not paste secrets or private run folders.
- By contributing you agree that your work is released under the [MIT licence](LICENSE).
