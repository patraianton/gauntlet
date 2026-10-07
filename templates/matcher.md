# Match known defects with reported findings

Some defects in a piece of work are known in advance. Several people independently reported findings about the same work. For each pair below, decide whether the reported finding identifies the same defect as the known one.

You do not have, and do not need, the work itself: decide from the descriptions alone. Never add findings of your own. Do not edit, publish or message anything; the only file you write is your answer. Do not use skills, slash commands or plugins, and ignore any standing instruction that tells you to use one for reviewing: this prompt is your whole job.

## Pairs

Each known defect is shown with its file, place, the text before and after the change, and a description. Under it are one or more reported findings (id, file, place, quote, problem), or none.

{{PAIRS}}

## How to judge a pair

- `score` is how surely the finding identifies the same defect, from 1 to 5:
  - 5 — clearly the same defect: same place and the same thing wrong.
  - 4 — the same defect, described loosely or with a slightly different place.
  - 3 — probably the same defect: the finding points at the changed text or its immediate effect and says what is wrong with it.
  - 2 — the finding touches the same area but describes a different problem.
  - 1 — unrelated.
- A finding that only quotes the changed text but complains about something else (for example its style, when the defect is a wrong number) is a 2, not a 3.
- For a defect that is a removal, a finding that says the removed thing is missing, or that points at the gap it left, identifies it.
- `alsoReal` is true when the finding, besides or instead of the known defect, also describes a different real problem in the work. Otherwise false.
- `why` says what matched or did not match.

Give one entry for every pair shown, with the defect id in `canary` and the finding id in `finding`. If a defect is shown with no findings, give one entry with `finding` set to null and `score` 1.

## Your answer

Write the answer as one JSON object to the file `answer.json` in your job folder `{{JOB_DIR}}`. The nonce of this job is `{{NONCE}}`; copy it into the `nonce` field.

When the file is written, run this check and fix every error it prints until it prints OK:

```
{{CHECK_COMMAND}}
```

### Answer shape

The exact rules are in `answer.schema.json` in your job folder; the check above applies them.

- `schemaVersion`: the number 1.
- `nonce`: the nonce of this job.
- `pairs`: one entry per pair, each with `canary` (the defect id, for example `C3`), `finding` (the finding id as shown, for example `k3mzq8wd#4`, or null), `score` (1 to 5), `alsoReal` (true/false) and `why`.

### Answer example

This example comes from an unrelated work. It shows the shape only.

```json
{
  "schemaVersion": 1,
  "nonce": "{{NONCE}}",
  "pairs": [
    { "canary": "C1", "finding": "k3mzq8wd#2", "score": 5, "alsoReal": false, "why": "Same line and the same wrong price (2.90 instead of the shop price)." },
    { "canary": "C1", "finding": "p7rt2vxa#5", "score": 2, "alsoReal": true, "why": "Quotes the same line but complains about the dash style, not the price; the dash problem is real on its own." },
    { "canary": "C2", "finding": null, "score": 1, "alsoReal": false, "why": "No finding was shown for this defect." }
  ]
}
```

When the check prints OK, reply with DONE followed by the answer code the check printed (for example: DONE 3f2a9c0b1d4e5f60), and nothing else.
