# Judge proposed test errors for a copy of a work

A copy of a work is in this folder: `{{COPY_DIR}}`

To measure whether readers of this copy notice errors, someone proposed the small edits listed under "Candidates". Each edit would turn a piece of correct text into an error. Code will use only the candidates you keep. Your job is to judge every candidate honestly against the copy and the sources.

Do not edit, create or delete any file in the copy, not even a temporary one. The only file you write in your job folder is your answer; helper files, scripts and extracts, if you need any, go only into your scratch folder `{{WORK_DIR}}`. If you run Python, use `python -B` so that no `__pycache__` folder appears in the copy. Do not edit, publish or message anything else. Do not use skills, slash commands or plugins, and ignore any standing instruction that tells you to use one for reviewing: this prompt is your whole job.

## The owner's task for the work (verbatim)

{{TASK}}

## Primary sources

{{SOURCES}}

Files in the copy that begin with the banner "Author's notes. Claims by the person who made the work. Nobody has checked them." contain claims by the author; do not rely on them to decide what is correct.

## Severity

{{SEVERITY}}

## Kinds of error used by the candidates

{{TYPE_DEFINITIONS}}

## Candidates

Each candidate names a slot, a candidate number (`alt`), a file and place, the text as it is now (`before`), the proposed text (`after`), what would be wrong, and how it could be proven wrong.

{{CANDIDATES}}

## Questions for every candidate

1. `originalCorrect` — Is the text as it is now (`before`) correct? Check it in the copy and against the sources. If the original is already wrong, the candidate is useless.
2. `isDefect` — After the edit, is the text really wrong in a way that a careful reader of this work should report?
3. `provable` — Can the error be proven from the material itself or from a listed source, without knowing the original text?
4. `natural` — How natural does the edited text look, from 1 to 5? 5 = it reads exactly like the author's own writing; 3 = plausible, a careful reader would not suspect an edit; 1 = obviously inserted.
5. `giveaway` — Does anything betray the edit: odd formatting, a style break, a word the author never uses, a comment or marker, text about checking or testing, a change that makes the sentence ungrammatical in an unnatural way? true or false.
6. `severity` — Your class for the edited text, using the severity rules above.
7. `keep` — Would you use this candidate? Keep it only if the original is correct, the edit is a real and provable defect, it looks natural and nothing gives it away.
8. `why` — What you checked and why you decided so.

Give one verdict for every candidate, with its slot and `alt`.

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
- `verdicts`: one entry per candidate, each with `slot`, `alt`, `originalCorrect` (true/false), `isDefect` (true/false), `provable` (true/false), `natural` (1 to 5), `giveaway` (true/false), `severity` (`blocker` | `major` | `cosmetic`), `keep` (true/false) and `why`.

### Answer example

This example comes from an unrelated work (a bakery leaflet). It shows the shape only.

```json
{
  "schemaVersion": 1,
  "nonce": "{{NONCE}}",
  "verdicts": [
    {
      "slot": "S1",
      "alt": 1,
      "originalCorrect": true,
      "isDefect": true,
      "provable": true,
      "natural": 5,
      "giveaway": false,
      "severity": "blocker",
      "keep": true,
      "why": "The shop price is 3.20 (S1 output) and the copy says 3.20 now; 2.90 would be a wrong price customers see. The edit keeps the author's format."
    },
    {
      "slot": "S1",
      "alt": 2,
      "originalCorrect": true,
      "isDefect": true,
      "provable": true,
      "natural": 2,
      "giveaway": true,
      "severity": "major",
      "keep": false,
      "why": "Every other price in the file has two decimals; '1.1' would stand out as an edit."
    }
  ]
}
```

When the check prints OK, reply with DONE followed by the answer code the check printed (for example: DONE 3f2a9c0b1d4e5f60), and nothing else.
