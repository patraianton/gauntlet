# Write reports of problems that are not real

A copy of a work is in this folder: `{{COPY_DIR}}`

Other people will later get a list of reported problems about this copy and will decide, one report at a time, whether each one is real. To learn whether they check each report carefully, a few reports that are NOT real are mixed into the list. Your job is only to write those reports. Code chooses which of them are used and mixes them in.

Do not edit, create or delete any file in the copy, not even a temporary one. The only file you write in your job folder is your answer; helper files, scripts and extracts, if you need any, go only into your scratch folder `{{WORK_DIR}}`. If you run Python, use `python -B` so that no `__pycache__` folder appears in the copy. Do not edit, publish or message anything else. Do not use skills, slash commands or plugins, and ignore any standing instruction that tells you to use one for reviewing: this prompt is your whole job.

## The owner's task for the work (verbatim)

{{TASK}}

## Material in the copy

{{MATERIAL_LIST}}

Files that begin with the banner "Author's notes. Claims by the person who made the work. Nobody has checked them." contain claims by the author; do not use them as proof of anything.

## Primary sources

{{SOURCES}}

## What to write

Write {{DECOY_COUNT}} different reports. Each one points at real text of the copy and says that something is wrong with it, but the text is in fact correct, and you can show that from the copy itself.

Two shapes are possible:

- `quote`: the report quotes a passage of the copy and says what is wrong with it (a number that does not agree with another place, a name that is spelled differently elsewhere, a link that goes to the wrong target, a date that disagrees with another date). In truth the passage agrees with the rest of the work.
- `missing`: the report says that something the work needs is absent (a phone number, a caveat, a section, a required item). In truth it is present in the copy, in a place other than the one the report names.

Use both shapes. Spread the reports over different files and different parts of the material; do not put two reports close to each other.

## Rules for every report

- A report reads like one written by a careful human reader: one concrete claim in plain words, with the reason ("the price here is 3.20, but the menu file says 3.50"). It names the other place or number it relies on. It is not vague ("this looks odd") and it does not hedge.
- The claim must be demonstrably wrong. Before you write a report, find the text in the copy (or the answer from a listed source) that proves the claim wrong, and copy it into `proofQuote` exactly, with its file in `proofFile`.
- Pick only text that is fully correct. If you notice a real problem in the work, do not write a report about it: list it under `incidental` and choose another place.
- `quote` and `proofQuote` are copied exactly from the file as it is stored, character by character, and each is at least 12 characters long. Copy at most 200 characters.
- `locator` says where the quoted text is (post number, JSON pointer, line, section), in the same way a reader would say it.
- The `claim` is written in this language: {{ANSWER_LANGUAGE}} (ru = Russian, lv = Latvian, en = English), in at most 280 characters.
- No markers of any kind: no brackets, no "TODO", no text about reviewing, testing, checking, traps or false reports, and never a hint that the claim is not real. The report must be indistinguishable from an honest one.
- `claimedSeverity` is `blocker` or `major`, the class an honest reader would give the claim if it were true.
- `whyFalse` says in one or two sentences why the claim is wrong, and points to the proof.

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
- `decoys`: list, each with
  - `kind`: `quote` | `missing`,
  - `file`: the relative path of the file the report is about, with forward slashes (for example `content/menu.md`),
  - `locator`: where in the file,
  - `quote`: for `quote`, the exact text; for `missing`, an empty string,
  - `missingWhat`: for `missing`, what is said to be absent; for `quote`, an empty string,
  - `claim`: the claim, in the language above,
  - `claimedSeverity`: `blocker` | `major`,
  - `whyFalse`: why the claim is wrong,
  - `proofFile`: the relative path of the file that holds the proof,
  - `proofQuote`: the exact text that proves the claim wrong.
- `incidental`: list of `{ "file": "...", "locator": "...", "note": "..." }` for real problems you noticed; an empty list if none.

### Answer example

This example comes from an unrelated work (a bakery leaflet). It shows the shape only.

```json
{
  "schemaVersion": 1,
  "nonce": "{{NONCE}}",
  "decoys": [
    {
      "kind": "quote",
      "file": "content/leaflet.md",
      "locator": "section 'Prices', line 14",
      "quote": "Rye bread — 3.20 EUR",
      "missingWhat": "",
      "claim": "The price of rye bread is 3.20 here, but the menu file lists it at 3.50 EUR.",
      "claimedSeverity": "major",
      "whyFalse": "The menu file lists rye bread at 3.20 EUR as well, so the two places agree.",
      "proofFile": "content/menu.json",
      "proofQuote": "\"name\": \"Rye bread\", \"price\": 3.20"
    },
    {
      "kind": "missing",
      "file": "content/leaflet.md",
      "locator": "whole leaflet",
      "quote": "",
      "missingWhat": "The leaflet gives no phone number for orders.",
      "claim": "Customers are told to order but the leaflet never says by which phone number.",
      "claimedSeverity": "major",
      "whyFalse": "Line 31 of the leaflet states the phone number for orders.",
      "proofFile": "content/leaflet.md",
      "proofQuote": "Order by phone: +371 2000 0000"
    }
  ],
  "incidental": []
}
```

When the check prints OK, reply with DONE followed by the answer code the check printed (for example: DONE 3f2a9c0b1d4e5f60), and nothing else.
