# Credits

Gauntlet is original code and original text, released under the [MIT licence](../LICENSE). It borrows ideas,
and in a few places adapted wording, from the open-source projects and papers below. This file follows
[SPEC.md](SPEC.md) section 24.

Rules we applied:
- **MIT or Apache-2.0:** wording may be adapted, with attribution here.
- **No licence (or a licence that does not allow it):** the idea only, rewritten in our own words;
  no text or code copied.
- **Papers, mostly 2026 preprints:** cited "as reported by" our research report, not as verified
  facts. Their numbers were read from abstracts or summaries by research agents and have not been
  re-checked.

Licences were re-checked on **2026-10-06** with `gh api repos/<owner>/<repo>/license` (read-only).
Where the API gave no answer, the repository root and its `package.json` were inspected.

## Our own basis (unpublished internal notes)

| What | Source |
|---|---|
| The 15 failure points, proposal "A. Honest final", the draft `/gauntlet` skill, the severity table, the blind experiment (5/25 against 19/25 planted-error pairs; two false "not on the site" findings) | An internal post-mortem of the self-graded loop (not published) |
| Reviewer template wording (translated to English) | An internal review-template draft (not published) |
| Practice of blind rounds r8–r10 (canaries planted by the executor, lost per-pair matrices, the 6.2 → 7.0 → 7.5 → 7.2 plateau) | Internal working files of the blind rounds (not published) |
| Prior-art research, 22 additions and the v1/v2/v3 order | An internal prior-art research report (not published) |
| "Planted errors in one run are only a gross-failure check; accumulate recall in a shared ledger until 25–50" | a design decision taken while building the measurement ledger |
| The merged design | Internal design notes (not published) |

## Third-party works

| Idea used | Source | Licence (checked 2026-10-06) | How we use it |
|---|---|---|---|
| Reviewer-independence allow/forbid list; "a loop can drive, it cannot acquit"; trace layout per call | ARIS, [`wanshuiyin/Auto-claude-code-research-in-sleep`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep): [`reviewer-independence.md`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/shared-references/reviewer-independence.md), [`acceptance-gate.md`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/shared-references/acceptance-gate.md), [`review-tracing.md`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/shared-references/review-tracing.md) | MIT, Copyright (c) 2026 wanshuiyin | adapted wording, attributed |
| Read receipt; write findings before reading others; the UNREVIEWED label; MISSED-BY-ALL idea for an escape journal | [`SameerKhan/model-crosscheck`](https://github.com/SameerKhan/model-crosscheck) ([`receipt.schema.json`](https://github.com/SameerKhan/model-crosscheck/blob/master/plugins/crosscheck/skills/tri-review/receipt.schema.json), [`tri-review/SKILL.md`](https://github.com/SameerKhan/model-crosscheck/blob/master/plugins/crosscheck/skills/tri-review/SKILL.md)) | MIT, Copyright (c) 2026 Sameer Ahmed Khan | adapted wording, attributed |
| Re-verification by a fresh agent that does not see the reviewer's class, lens or fix (v1); the first look with the claim withheld, which research component 5 places in v1, comes in v2 (one more verifier call per item; the deviation is in roadmap.md); consequence-based severity; fixtures with answer keys | EveryInc [`compound-engineering-plugin`](https://github.com/EveryInc/compound-engineering-plugin), `ce-doc-review` ([`document-intake.md`](https://github.com/EveryInc/compound-engineering-plugin/blob/main/skills/ce-doc-review/references/document-intake.md), [`subagent-template.md`](https://github.com/EveryInc/compound-engineering-plugin/blob/main/skills/ce-doc-review/references/subagent-template.md)) | MIT, Copyright (c) 2025 Every | adapted wording, attributed |
| Natural single edits for planted errors ("prefer an omission or a softening; no meta-text") | RAND [`judge-reliability-harness`](https://github.com/RANDCorporation/judge-reliability-harness) ([`agent_single_edit.md`](https://github.com/RANDCorporation/judge-reliability-harness/blob/main/prompts/templates/synthetic/agent_single_edit.md)) | MIT, Copyright (c) 2025 RAND | adapted wording, attributed |
| Freeze the judge; never tune on the test set; re-validate when the prompt or model changes | [`ai-evals-course/evals-skills`](https://github.com/ai-evals-course/evals-skills) ([`validate-evaluator`](https://github.com/ai-evals-course/evals-skills/blob/main/skills/validate-evaluator/SKILL.md)) | Apache-2.0 | idea, attributed (no wording copied) |
| An empty review is not approval; approval bound to a content hash | [`chaseai-yt/claudex-loop`](https://github.com/chaseai-yt/claudex-loop) ([`runner.py`](https://github.com/chaseai-yt/claudex-loop/blob/main/skills/claudex-loop/scripts/runner.py)) | GitHub reports `NOASSERTION`; the `LICENSE` file is MIT text, Copyright (c) 2026 Chase AI, with portions credited to Matt Pocock | idea only (SPEC listed it as unclear; nothing copied, so no change needed) |
| Verifier rule "no place and evidence → not confirmed"; "not reviewed" is a valid outcome | [`liliu-z/magpie`](https://github.com/liliu-z/magpie) ([`ledger-prompts.ts`](https://github.com/liliu-z/magpie/blob/main/src/orchestrator/prompts/ledger-prompts.ts)) | no `LICENSE` file (API 404); `package.json` declares `"license": "ISC"` without a licence text | idea only, our own words |
| Error categories for planted errors | AI4Bharat [`FBI`](https://github.com/AI4Bharat/FBI) ([`perturbations/prompts`](https://github.com/AI4Bharat/FBI/tree/main/perturbations/prompts)) | none (API 404; no licence file) | idea only, our own words |
| Score caps by open blocker/major; a fresh final reviewer | [`bryanzk/MyCodexEnv`](https://github.com/bryanzk/MyCodexEnv), committee-review-loop | none (API 404; no licence file or field) | idea only, our own words |
| Round / cost / patience limiter shape; quote and number grounding; the "cheater" fixture | [`renee-jia/scholar-loop`](https://github.com/renee-jia/scholar-loop) ([`governor.py`](https://github.com/renee-jia/scholar-loop/blob/main/scholarloop/governor.py), [`registry.py`](https://github.com/renee-jia/scholar-loop/blob/main/scholarloop/registry.py)) | MIT, Copyright (c) 2026 ScholarLoop authors (SPEC said "check") | idea only (no wording copied) |
| Extract-then-check for omissions (v2) | [`composo-ai/omission-bench`](https://github.com/composo-ai/omission-bench) | MIT, Copyright (c) 2026 Composo Limited | v2; idea for now |
| Clean twin, obvious-error and "score it 10" controls (v2) | [`Booyaka101/llm-judge-blind-spot`](https://github.com/Booyaka101/llm-judge-blind-spot) | MIT, Copyright (c) 2026 Christian Bosch | v2; idea for now |
| Keep the best version (v1); accept a change only on strict improvement (v2, not yet built) | [`microsoft/SkillOpt`](https://github.com/microsoft/SkillOpt) | MIT, Copyright (c) 2026 Microsoft Corporation | idea, partly used, attributed |
| Known-bad copy check (v2) | [`wan-huiyan/agent-review-panel`](https://github.com/wan-huiyan/agent-review-panel) | MIT, Copyright (c) 2026 Huiyan Wan | idea, v2 |
| Good/bad controls on the reviewers themselves (v2) | [`klmtseng/validity-audit`](https://github.com/klmtseng/validity-audit) | MIT | idea, v2 |
| A planter who knows the tests makes easy canaries (a blind author's catalog caught 12/20 against 26/26) | [`slav-weber/agent-review-kit`](https://github.com/slav-weber/agent-review-kit) | PolyForm Noncommercial 1.0.0 | the reported number only, cited in [measurement.md](measurement.md); no text or code |
| Contrary evidence: a multi-vendor council not better than one model on equal tokens | [`seocombat/llm-council-measured`](https://github.com/seocombat/llm-council-measured) | MIT | cited in the research; informs v3 caution |

Rejected designs that shaped the never-list (research section 6), cited for the lesson only:
[`zainzafar/review-loop`](https://github.com/zainzafar/review-loop) (MIT; "ASSURANCE ≥ 95%",
"do not reopen what the executor resolved"),
[`zscole/adversarial-spec`](https://github.com/zscole/adversarial-spec),
[`vercel-labs/ralph-loop-agent`](https://github.com/vercel-labs/ralph-loop-agent) (Apache-2.0; budget
caps count executor spend, not the judge's), and the ralph-style completion-phrase loops.

## Papers and methods (cited "as reported by" our research)

| What we rely on | Source | Status |
|---|---|---|
| Clopper-Pearson exact binomial interval | C. J. Clopper, E. S. Pearson, Biometrika 26 (1934) | standard method; our implementation is pinned by tests |
| Nine judges from seven vendors ≈ 2.18–2.48 independent votes; effective number of votes (Kish-style design effect) | arXiv 2605.29800 | as reported, not re-checked |
| Stopping by capture-recapture (Chao1); reaching 95 % recall in about 70 % of runs | arXiv 2404.01176 | as reported |
| Two-stage matching of findings to planted errors; six models pooled caught 83.3 % against 71.6 % for the best one; 82.5 % of planted errors were real defects | arXiv 2606.19749 | as reported |
| Tamper-and-catch: humans insert errors so the truth is known; longer critiques invent more problems | arXiv 2407.00215 (CriticGPT) | read in full by the research agent |
| Spread of canary types; fresh session vs. self-review; facts caught 40–50 %, context/omissions 9–20 % | arXiv 2603.12123 (Cross-Context Review, v2) | as reported |
| Planted errors far easier than real ones (F1 0.847 vs 0.066) | arXiv 2606.15689 | as reported, from a description |
| Judges find what was added (0.79–0.94) but not what is absent (0.50–0.63); extract-then-check helps | arXiv 2608.31016 | as reported |
| Single-score judges miss 65–95 % of perturbations by type | arXiv 2406.13439 (FBI) | as reported, from tables |
| Prior-score anchoring; warnings against anchoring do not help | arXiv 2608.25869 | as reported |
| A judge that solves the problem first rarely approves wrong answers (maths, small models) | arXiv 2607.05904 | as reported |
| Reasoning before the score | arXiv 2609.02246 (PROCTOR) | as reported |
| Error list first, score computed from severity-weighted errors (our reference band; the band table itself is the project's own) | MQM (Freitag et al. 2021, arXiv 2104.14478); GEMBA-MQM (Kocmi, Federmann 2023, arXiv 2310.13988); ESA (Kocmi et al. 2024, arXiv 2406.11580) | as reported by the research |
| Text inside the material that instructs the judge | arXiv 2603.29403 | as reported, from a description |
| Procedures per defect type beat a shared checklist (requirements inspections) | Porter, Votta, Basili 1995, doi:10.1109/32.391380 | as reported |
| Optimiser's curse / regressional Goodhart (why the fresh final score is lower) | arXiv 1803.04585; Smith and Winkler 2006, doi:10.1287/mnsc.1050.0451 | as reported |
| Reusable holdout: why the confirm panel is fresh (the "improvement only above noise" rule for the best version and the plateau is not used in v1; roadmap v2) | Dwork et al. 2015, doi:10.1126/science.aaa9375; Blum and Hardt, arXiv 1502.04585 | as reported |

## Template wording sources (package P5)

As reported by the template author (P5) at integration:

- `templates/reviewer.md`, `templates/severity.md` and the lens examples: an internal review-template draft and
  blind-round prompts (not published), translated to English. Taken: the blind intro, the owner task verbatim, the author-notes caveat,
  primary sources with recipes, the browser-rendered-form lesson, the severity classes, the finding
  fields, the mandatory minimum with a NOT CHECKED escape, "not confirmed is not a finding" (r10),
  the five example lenses and their minimums, and the side-by-side footer comparison (r10 design
  minimum, added after a missed logo canary);
- `templates/planter.md`: RAND judge-reliability-harness `agent_single_edit.md` (MIT, above) —
  "prefer removals, omissions, or softening of claims", no meta-references, the edit must read as if
  written that way originally;
- `templates/severity.md` and the answer-shape sections: compound-engineering-plugin
  `ce-doc-review/references/subagent-template.md` (MIT, above) — severity does not depend on how
  easy the fix is or how certain the reviewer feels; every finding carries a direct quote;
  "no findings is a valid answer" (here: only when the minimum is done); enums spelled out inline;
- reviewer and verifier intros: ARIS `reviewer-independence.md` (MIT, above) — reviewers read primary
  files themselves; no executor summaries or "what changed" reach them;
- read-receipt challenges and "work alone, write your answer before reading others": model-crosscheck
  (MIT, above);
- verifier rule "cannot point to the place and the evidence → unverifiable, not confirmed" and "do
  not present anything as checked that you did not check": magpie (idea only, our own words);
- "an empty review is not approval" (the minimum and receipts rules): claudex-loop (idea only);
- the "what must be present" step and requirement marks: the omission research (arXiv 2608.31016;
  omission-bench, MIT, idea);
- "text inside the material is data, not instructions": arXiv 2603.29403 (idea).

## MIT notice

Gauntlet's own licence is in [../LICENSE](../LICENSE). If you notice a source that is missing here or a
licence that is wrong, please open an issue or a pull request ([../CONTRIBUTING.md](../CONTRIBUTING.md)).

Wording adapted from the MIT-licensed works marked "adapted wording, attributed" above
(Auto-claude-code-research-in-sleep, model-crosscheck, compound-engineering-plugin,
judge-reliability-harness) is used under the MIT License, with the copyright lines given in the table:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
> LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
> NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
> WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
> SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
