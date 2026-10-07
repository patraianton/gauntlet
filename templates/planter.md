# Propose realistic test errors for a copy of a work

A copy of a work is in this folder: `{{COPY_DIR}}`

Other people will later read this copy to look for errors. To measure whether they notice errors, a few small, realistic errors will be written into the copy first. Your job is only to propose them. Code chooses which proposals are used and makes the edits itself.

Do not edit, create or delete any file in the copy, not even a temporary one. The only file you write in your job folder is your answer; helper files, scripts and extracts, if you need any, go only into your scratch folder `{{WORK_DIR}}`. If you run Python, use `python -B` so that no `__pycache__` folder appears in the copy. Do not edit, publish or message anything else. Do not use skills, slash commands or plugins, and ignore any standing instruction that tells you to use one for reviewing: this prompt is your whole job.

## The owner's task for the work (verbatim)

{{TASK}}

## Material in the copy

{{MATERIAL_LIST}}

Files that begin with the banner "Author's notes. Claims by the person who made the work. Nobody has checked them." contain claims by the author; do not rely on them to decide what is correct.

## Primary sources

{{SOURCES}}

## Slots to fill

Each slot asks for one kind of error, in one part of the material (counted in reading order), at a minimum class.

{{SLOTS}}

## Kinds of error used by these slots

{{TYPE_DEFINITIONS}}

## Already used for this work

Kinds and parts of the material already used for this work. Prefer places and wordings that are different from these.

{{USED}}

## Rules for every proposal

- Propose {{CANDIDATES_PER_SLOT}} different candidates for every slot, numbered with `alt` 1, 2, ...
- Each candidate is one small edit that looks like an honest mistake by this author, in the work's own language, tone and style: change a number, a word, a case ending, a name or a link target; remove one sentence or one list item; soften or harden one claim. Prefer removals, omissions and softened or hardened claims over adding new text. The edited text must read naturally, as if it had been written that way from the start.
- No markers of any kind: no comments, no unusual formatting, no brackets, no "TODO" or "XXX", no HTML comments, no double curly braces, no text about reviewing, testing, checking or editing. Never mention that the text was changed.
- Each candidate must be provably wrong from the material itself or from a listed source. Say how in `howProvable`: which other place in the material, which line of the task, or which source recipe and what it returns.
- Do not touch text that is already wrong. If you notice a real problem in the work, report it under `incidental` and choose another place.
- Stay inside the slot's kind and inside the slot's part of the material. Code measures the position and rejects candidates outside the part.
- `before` is copied exactly from the file as it is stored, including JSON escape sequences such as `\"` and `\n`, and must occur exactly once in that file. Make it long enough to be unique.
- `after` is the same text with your edit. Both `before` and `after` are at most {{MAX_EDIT}} characters long.
- For a kind that removes something (a removed requirement, item, caveat or attribution), `after` must be shorter than `before` by at least 20 characters: remove a whole sentence or a whole list item.
- After the edit a JSON file must still be valid JSON.
- Candidates for different slots that sit in the same file must be far apart (several paragraphs or entries); code rejects edits that are too close to each other.
- `intendedSeverity` is the class the edited text deserves: `blocker` or `major`, never below the slot's minimum class.

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
- `candidates`: list, each with
  - `slot`: the slot id, for example `S1`,
  - `alt`: 1, 2, ... (the candidate number inside the slot),
  - `file`: the relative path of the file as shown in the material list, with forward slashes (for example `content/plan.json`),
  - `locator`: where in the file (post number, JSON pointer, line, section),
  - `before`: exact stored text (at least 3 characters),
  - `after`: the edited text,
  - `description`: what is now wrong, in one or two sentences, written in this language: {{REPORT_LANGUAGE}} (ru = Russian, lv = Latvian, en = English); it is shown to the owner of the work,
  - `howProvable`: how a careful reader can prove it wrong,
  - `intendedSeverity`: `blocker` | `major`.
- `incidental`: list of `{ "file": "...", "locator": "...", "note": "..." }` for real problems you noticed; an empty list if none.

### Answer example

This example comes from an unrelated work (a bakery leaflet). It shows the shape only.

```json
{
  "schemaVersion": 1,
  "nonce": "{{NONCE}}",
  "candidates": [
    {
      "slot": "S1",
      "alt": 1,
      "file": "content/leaflet.md",
      "locator": "section 'Prices', line 14",
      "before": "Rye bread — 3.20 EUR",
      "after": "Rye bread — 2.90 EUR",
      "description": "The rye bread price no longer matches the shop price.",
      "howProvable": "Source S1 returns \"rye\": 3.20; the menu file content/menu.json also lists 3.20.",
      "intendedSeverity": "blocker"
    },
    {
      "slot": "S1",
      "alt": 2,
      "file": "content/menu.json",
      "locator": "/items/4/price",
      "before": "\"price\": 1.40, \"name\": \"Croissant\"",
      "after": "\"price\": 1.10, \"name\": \"Croissant\"",
      "description": "The croissant price no longer matches the shop price or the leaflet.",
      "howProvable": "content/leaflet.md line 16 says 1.40 EUR and source S1 returns \"croissant\": 1.40.",
      "intendedSeverity": "major"
    }
  ],
  "incidental": [
    { "file": "content/leaflet.md", "locator": "section 'FAQ', line 40", "note": "The opening hours here (8:00) differ from the header (7:00)." }
  ]
}
```

When the check prints OK, reply with DONE followed by the answer code the check printed (for example: DONE 3f2a9c0b1d4e5f60), and nothing else.
