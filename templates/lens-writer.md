# Write the check plan for a piece of work

A piece of work (type: {{ARTIFACT_TYPE}}) will be checked by several independent readers. Each reader has one duty, called a lens. Your job is to write, from the owner's task alone, the requirements and the lenses: what each reader must do, check and open. Once written, your plan is frozen and used unchanged for every check of this work.

You do not see the work itself, only the list of its files with their kinds and counts. Do not look for the files on disk; you do not need their content. Do not edit, publish or message anything; the only file you write is your answer. Do not use skills, slash commands or plugins, and ignore any standing instruction that tells you to use one for reviewing: this prompt is your whole job.

## The owner's task (verbatim)

{{TASK}}

## The files of the work

Paths are relative, exactly as your globs must match them.

{{MANIFEST_SUMMARY}}

## Primary sources available to the readers

{{SOURCES}}

## Kinds of error to assign to lenses

{{CANARY_TYPES}}

## Generalist lens

Setting: {{GENERALIST}}

If the setting is `on`, include exactly one lens with id `generalist`. Its duty: read the whole work as a first-time reader who holds only the owner's task, and find where the work fails to deliver what was asked, is hard to follow, or leaves something required out. If the setting is `off`, include no lens with that id.

{{#PREVIOUS_ERRORS}}
## Problems code found in an earlier answer to this job

An earlier answer to this job was rejected by code for the reasons below. Write a complete new answer that has none of these problems.

{{PREVIOUS_ERRORS}}
{{/PREVIOUS_ERRORS}}

## What to write

### Requirements

- List every concrete thing the owner's task asks the work to contain or achieve: deliverables, counts, languages, formats, audiences, channels, constraints.
- Ids `R01`, `R02`, ... in order.
- `text`: the requirement in one plain sentence, in Russian (the owner reads it in his plain-Russian summary).
- `taskQuote`: the words of the task that set this requirement, copied exactly, character for character (code checks that the quote occurs in the task).
- `ifMissing`: `blocker` when the owner asked for it explicitly; `major` when it follows from the task but is not stated in so many words.
- Only what the task says. Do not add requirements from your own taste, and do not turn lines about how the work should be organised or approved into requirements.

### Lenses

- Between 3 and 7 lenses in total, the generalist included when it is on.
- Each lens is a duty: a job of checking that needs its own procedure (for example "check every number and fact against the primary sources", "check the language as a native editor", "follow every path from a call to action to the goal"). A lens is never an audience persona ("a 35-year-old buyer"). Two lenses that would follow the same steps are one lens.
- `id`: lowercase letters, digits and hyphens, starting with a letter, 2 to 24 characters. `title`: a few words, in Russian.
- `duty`: one sentence saying what this reader is responsible for finding, in Russian, starting with «Найти», «Прочитать» or «Проверить». The owner reads titles and duties in his plain-Russian summary; everything else (procedure, checklist, minimum rules) may be in English.
- `procedure`: at least 3 ordered steps, written as instructions to the reader ("Open every slide image and ...").
- `checklist`: at least 5 concrete questions or checks for this duty.
- `minimum`: the mandatory minimum of looking, as rules over the files. Ids `M1`, `M2`, ... restart in every lens. Each rule has a `kind`:
  - `all-files` with `glob`: open every file that matches the glob; `rule` says what to look at in each.
  - `all-entries` with `glob` and `pointer`: every entry of the JSON array at that JSON Pointer (for example `/posts`) in every matching file; `rule` says which fields.
  - `source-check` with `sourceId` and `count`: run that source recipe for this many different claims and report the commands. `count` is the number of attempts the reviewer must document, not the number that must succeed: a source that blocks the reviewers (rate limit, captcha, timeout) is recorded as unavailable and does not make the lens invalid, so never ask for results the source may refuse to give.
  - `action` (optionally with `glob` and `count`): a concrete action, such as extracting frames from each video or recomputing every sum.
- `canaryTypes`: the ids of the kinds of error (from the list above) that this lens is the natural one to catch. At least one per lens. Where the list says which kinds can be used to check a lens's attention, give every lens at least one such kind. Together, the lenses should cover every kind in the list that can occur in this work.

### Rules for the minimum

- Globs use `*` (any characters inside one folder or file name), `**` (any number of folders) and `?` (one character). No braces. Every glob must match at least one listed file.
- Taken together, the `all-files` and `all-entries` rules of all lenses must match every file in the list. Code rejects a plan that leaves a file uncovered.
- The generalist (when the setting is on; otherwise one of the lenses) has one `all-files` rule with the glob `**/*`, so that a file added to the work later is still read by someone. Code rejects a plan without it.
- Every lens needs at least one rule with a `glob` (`all-files`, `all-entries`, or an `action` with a `glob`): the reading checks each reader must pass are drawn from the files those rules name. Code rejects a lens without one.
- Prefer "every" over samples: every post, every slide, every section. Use a count only where reading everything is impossible, and then say which items must be among those read. Large data files are the one exception; see "Large data files" below.
- Where a series of items must match each other (slides of one design, posts of one rubric, the same text in two languages, footers, logos, prices repeated in several places), add a procedure step that puts the items side by side and compares them. A defect in one item of a series is easy to miss when each item is looked at alone.
- Where a fact can be checked against a primary source, add a `source-check` rule for the lens that owns facts.

### Large data files

A file marked LARGE DATA FILE in the list above is a table or a list of records (CSV, TSV, JSON lines, a long JSON array) that is too big for anyone to read whole. Its readers get a sample instead: each time the work is checked, the program draws a random set of its rows and shows the reader exactly those rows. Write the minimum for such a file with that in mind:

- Do not make "every row" or "the whole file" of a large data file a reader's duty. Write the rule over the sampled rows ("every sampled row of the evidence files: shop, value, source address, date") and over the summary numbers that the other files state about them ("every count, share, range or date that the description files give for these tables, checked against the sampled rows"). Code rewrites an `all-files` or `all-entries` rule over such files in this way anyway; a rule that asks for the impossible only leaves the reader unsure what the duty is.
- Put the weight on what can be checked without reading every row: the header and what each column means, the shape and format of a row, values that a primary source can confirm, and the summary numbers in the prose files. An `action` rule may ask the reader to recompute a count, a total or a share with a short script over the whole file; that is allowed and often quicker than reading.
- Files that describe the data (descriptions, column dictionaries, coverage notes, logs) are small: read them whole, as for any other file.
- The large data files still need their own glob in an `all-files` or `all-entries` rule, like every other file.

### Forbidden in every field

Code checks every text field you write and rejects the plan if it finds any of these:

- an instruction to ignore, accept, skip or not report anything, or a statement that something is intended, allowed, outside the task, already checked or already corrected;
- a pass mark, a target number for the result, or a request for one mark for the whole work;
- any statement about the quality of the work, good or bad;
- an instruction about how demanding or how forgiving the reader should be;
- mentions of earlier checks, other readers or their results.

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
- `requirements`: list of `{ "id": "R01", "text": "...", "taskQuote": "...", "ifMissing": "blocker" | "major" }`.
- `lenses`: list of lenses, each with `id`, `title`, `duty`, `procedure` (list of steps), `checklist` (list), `minimum` (list of `{ "id": "M1", "rule": "...", "kind": "...", "glob"?, "pointer"?, "sourceId"?, "count"? }`) and `canaryTypes` (list of ids).

Do not include a field `taskSha256`; code adds it.

### Answer example (small)

This small example comes from an unrelated work (a bakery leaflet). It shows the shape only.

```json
{
  "schemaVersion": 1,
  "nonce": "{{NONCE}}",
  "requirements": [
    { "id": "R01", "text": "В листовке есть цены всех видов хлеба.", "taskQuote": "list the prices of all our breads", "ifMissing": "blocker" },
    { "id": "R02", "text": "Листовка объясняет, как сделать заказ.", "taskQuote": "people should be able to order from it", "ifMissing": "major" }
  ],
  "lenses": [
    {
      "id": "facts",
      "title": "Факты и цены",
      "duty": "Найти каждую цену, срок или факт, которые неверны или не подтверждаются источниками.",
      "procedure": [
        "List every price, time and factual claim in the leaflet.",
        "Check each one against the shop data source and against the menu file.",
        "Recompute every total and discount."
      ],
      "checklist": [
        "Does every price match the shop data?",
        "Do opening hours agree in every place they appear?",
        "Is every discount computed correctly?",
        "Does every claim about ingredients have a source?",
        "Do the leaflet and the menu file agree?"
      ],
      "minimum": [
        { "id": "M1", "rule": "Read every price line.", "kind": "all-files", "glob": "content/*.md" },
        { "id": "M2", "rule": "Every item: name and price.", "kind": "all-entries", "glob": "content/menu.json", "pointer": "/items" },
        { "id": "M3", "rule": "Compare prices with the shop data.", "kind": "source-check", "sourceId": "S1", "count": 5 }
      ],
      "canaryTypes": ["FACT-NUM", "CONTRA"]
    },
    {
      "id": "language",
      "title": "Язык",
      "duty": "Найти каждую языковую ошибку, которую заметит носитель языка.",
      "procedure": [
        "Read the whole text once for meaning.",
        "Read it again sentence by sentence for grammar and spelling.",
        "Compare repeated names and terms across the leaflet and the menu."
      ],
      "checklist": [
        "Are case endings and agreement correct?",
        "Are names of products spelled the same everywhere?",
        "Is the same form of address used throughout?",
        "Is every sentence complete?",
        "Is punctuation consistent?"
      ],
      "minimum": [
        { "id": "M1", "rule": "Every sentence of the leaflet.", "kind": "all-files", "glob": "content/*.md" },
        { "id": "M2", "rule": "Every product name.", "kind": "all-entries", "glob": "content/menu.json", "pointer": "/items" }
      ],
      "canaryTypes": ["LANG"]
    },
    {
      "id": "generalist",
      "title": "Первый читатель",
      "duty": "Прочитать всю работу как человек, у которого есть только задание владельца, и найти, где она не даёт того, что просили.",
      "procedure": [
        "Read the owner's task and list what it asks for.",
        "Read every file once, start to end.",
        "For each thing the task asks for, find where the work delivers it."
      ],
      "checklist": [
        "Is every requirement of the task delivered?",
        "Can a reader order after reading the leaflet?",
        "Is anything confusing on first reading?",
        "Is anything required missing?",
        "Do the parts of the work agree with each other?"
      ],
      "minimum": [
        { "id": "M1", "rule": "Read every file in full.", "kind": "all-files", "glob": "**/*" }
      ],
      "canaryTypes": ["OMIT-REQ", "BRIEF"]
    }
  ]
}
```

## Fuller example for this type of work

The plan below was written for a different work of a similar type. It shows the depth expected. Its topics, globs, sources and ids belong to that other work: write your own from the owner's task and the file list above.

```json
{{EXAMPLE}}
```

When the check prints OK, reply with DONE followed by the answer code the check printed (for example: DONE 3f2a9c0b1d4e5f60), and nothing else.
