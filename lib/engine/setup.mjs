// Setup: NEW -> AWAIT_LENS_WRITER -> READY (SPEC 11.1, 9.6).
//
// The lens writer is a separate fresh agent briefed only by code (D27): it sees the owner's task,
// the artifact type, a manifest summary (names, kinds, counts — no content), source ids and
// descriptions, one library example and the canary type ids. The executor never writes lenses.
// Its answer is validated by code (validateLenses); one re-issue with the error list; a second
// failure stops setup (STOP_INCONCLUSIVE, reason lens-writer). A valid answer is frozen.

import fs from 'node:fs';
import { ownerWords } from '../core/owner.mjs';
import path from 'node:path';
import { UsageError, IntegrityError } from '../core/errors.mjs';
import { readText, readJson, writeJsonAtomic, writeTextAtomic, exists, ensureDir, listFiles } from '../core/fsx.mjs';
import { sha256Hex, hashJson, fileKind, hashFile } from '../core/hash.mjs';
import { matchGlob } from '../core/glob.mjs';
import { validate, loadSchema } from '../core/schema.mjs';
import { validateRun, writeFrozen, effectiveModel, looserLimits } from '../core/config.mjs';
import { agentDefaults } from '../core/agenthome.mjs';
import { buildManifest, skippedLinksOf, selectLiveFiles } from '../material/manifest.mjs';
import { mechanicalProblems, mechanicalRefusal } from '../material/mechanical-shape.mjs';
import { isUnder, components, runRoots, runRootOf } from '../core/paths.mjs';
import { now } from '../core/clock.mjs';
import { checkSources, sourceFileChanges, sourcesBaseline, movingTargetProblems } from '../material/sources.mjs';
import { loadPatterns, lintValues, lintPath, normalizeQuote, decodeForScan } from '../material/lint.mjs';
import { loadTaxonomy } from '../measure/taxonomy.mjs';
import { decoysWanted } from '../measure/decoys.mjs';
import { controlsWanted } from '../measure/controls.mjs';
import { log, move, readJsonIf, rootsKey, ledgerLines, rngFor } from './state.mjs';
import { previewReviewCopy } from './strip-preview.mjs';
import { samplingSettings, dataFilesOfRun, annotateForLensWriter } from '../material/sample.mjs';
import { issueJob, ingestAnswer, spawnResult, setupJobs } from './ingest.mjs';

export const LENS_COUNT = Object.freeze({ min: 3, max: 7 });
export const COST_PER_LENS = 230000;
export const COST_BASE = 500000;

// ---------------------------------------------------------------- shared prompt values

export function taskText(rc) {
  return readText(rc.paths.task).replace(/\s+$/, '');
}

/**
 * Read a JSON file the executor writes (sources.json, strip.json, mechanical.json, an amend file).
 * Missing -> dflt. Unreadable JSON is a usage error (exit 4) naming the file and the position, never
 * a silent default: an empty source list would let `sources check` pass and `step` crash later.
 */
export function readExecutorJson(p, name, dflt = undefined) {
  if (!exists(p)) {
    if (dflt === undefined) throw new UsageError(`no such file: ${p}`);
    return dflt;
  }
  try {
    return readJson(p);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).replace(/^invalid JSON in [^:]*:\s*/i, '');
    throw new UsageError(
      `${name} is not valid JSON (${p}): ${msg}. ` +
        'Hint: inside a JSON string a Windows path needs doubled backslashes (C:\\\\Users\\\\...) or forward slashes (C:/Users/...).',
    );
  }
}

export function loadSourcesFile(rc) {
  return readExecutorJson(rc.paths.sources, 'sources.json', { schemaVersion: 1, sources: [] });
}

export function loadStrip(rc) {
  return readExecutorJson(rc.paths.strip, 'strip.json', { schemaVersion: 1, excludeGlobs: [], regex: [], traceAllow: [] });
}

export function loadMechanical(rc) {
  return readExecutorJson(rc.paths.mechanical, 'mechanical.json', { schemaVersion: 1, checks: [] });
}

export function loadLenses(rc) {
  return readJsonIf(rc.paths.lenses, null);
}

/** Absolute paths of the author-notes files in the live material. */
export function notesAbs(run) {
  const out = [];
  for (const rel of run.material?.authorNotes || []) {
    const r = String(rel).replace(/\\/g, '/');
    const [as, ...rest] = r.split('/');
    const root = (run.material.roots || []).find((x) => x.as === as);
    if (root) out.push(path.join(root.path, ...rest));
  }
  return out;
}

/**
 * Folders whose files can never be primary sources: the material roots, the run folder and the
 * project working folder. A file there is the author's own work or notes (failure point 7).
 */
export function ownFolders(rc) {
  const out = [];
  for (const r of rc.run.material?.roots || []) out.push({ path: r.path, what: `the material root "${r.as}"` });
  out.push({ path: rc.runDir, what: 'the run folder' });
  if (rc.run.projectDir) out.push({ path: rc.run.projectDir, what: 'the project working folder' });
  return out;
}

/**
 * Run every source recipe. A file the recipe reads that was written after the run started is
 * refused every time: at setup, at amend, at every round start and in the `sources check` preview
 * (r3-f3, r3-f4). The age is the file's modification time, so a backdated file passes this rule;
 * at round start code therefore also compares the hash of every file a source reads with the
 * setup baseline (sourceChangeProblems).
 */
export function runSourcesCheck(rc) {
  const src = loadSourcesFile(rc);
  const started = Date.parse(rc.run.createdAt || '');
  return checkSources(src, {
    allow: rc.run.allowExecutables,
    notesAbs: notesAbs(rc.run),
    forbiddenRoots: ownFolders(rc),
    startedAtMs: Number.isFinite(started) ? started : null,
  });
}

/** The latest hash-chained baseline of the files sources read ({ <id>: [{ path, sha256 }] }), or null. */
export function latestSourcesBaseline(rc) {
  const ev = [...ledgerLines(rc)].reverse().find((l) => l.type === 'sources-baseline');
  return ev ? ev.data?.files || {} : null;
}

/** Files a source reads that changed since the setup (or amend) baseline -> [string] problems (r3-f3). */
export function sourceChangeProblems(rc, results) {
  const base = latestSourcesBaseline(rc);
  if (!base) return [];
  return sourceFileChanges(base, results).map(
    (c) => `Primary source ${c.id} reads ${c.path}, which ${c.now === null ? 'is gone' : 'changed'} since setup (sha256 ${String(c.was).slice(0, 12)} -> ${c.now === null ? 'none' : String(c.now).slice(0, 12)}). A source file edited during the run is the executor's own words, not a primary source. Restore the file, or (only on the owner's words) amend --what sources --owner-quote "<the owner's words>" --question "<the exact question you asked the owner>".`,
  );
}

/**
 * Sources as shown to reviewers / verifiers / planter: id, recipe, and the executor's own words
 * (what / origin / notes) under an "unverified" banner — they are claims of the author, not
 * facts; only what the recipe prints counts. withRecipes=false gives the lens writer's view.
 */
export function sourcesValue(rc, check = null, { withRecipes = true } = {}) {
  const src = loadSourcesFile(rc).sources || [];
  if (src.length === 0) return '(no primary sources were configured for this work)';
  const lines = [];
  for (const s of src) {
    lines.push(`- ${s.id}`);
    if (withRecipes) {
      if (s.kind === 'command') lines.push(`  Recipe (run it yourself): ${[s.cmd, ...(s.args || [])].map(quoteArg).join(' ')}`);
      else lines.push(`  File: ${s.path}`);
    }
    lines.push("  The author's description of this source (unverified claims of the author; only what the recipe gives counts):");
    lines.push(`    What: ${s.what}`);
    if (s.origin) lines.push(`    Origin: ${s.origin}`);
    if (s.notes) lines.push(`    Note: ${s.notes}`);
  }
  return lines.join('\n');
}

/**
 * One argument of a printed recipe, safe to paste into Bash (the agents' shell): anything outside a
 * plain set of characters is single-quoted, so &, ?, ;, |, $, *, ( ) and the like stay literal (r2-f17).
 */
export function quoteArg(a) {
  const s = String(a);
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Every material file with kinds and counts, as the reviewer sees it. */
export function materialListValue(copyDir, manifest, { lensMinimumCounts = null, annotate = null } = {}) {
  const lines = [`Material folder: ${copyDir}`, '', 'Files (path relative to the material folder, kind, size):'];
  for (const f of manifest.files) lines.push(`- ${f.rel} (${f.kind}, ${f.bytes} bytes)${annotate ? annotate(f.rel) : ''}`);
  const kinds = {};
  for (const f of manifest.files) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  lines.push('');
  lines.push(`Total: ${manifest.files.length} files (` + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ') + ').');
  if (lensMinimumCounts && Object.keys(lensMinimumCounts).length) {
    lines.push('');
    lines.push('Counts:');
    for (const [k, n] of Object.entries(lensMinimumCounts)) lines.push(`- ${k}: ${n}`);
  }
  return lines.join('\n');
}

function manifestSummaryValue(manifest, annotate = null) {
  const lines = [];
  for (const f of manifest.files) lines.push(`- ${f.rel} (${f.kind})${annotate ? annotate(f.rel) : ''}`);
  const kinds = {};
  for (const f of manifest.files) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  lines.push('');
  lines.push(`Total: ${manifest.files.length} files (` + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ') + ').');
  const jsonCounts = Object.entries(manifest.counts || {});
  if (jsonCounts.length) {
    lines.push('');
    for (const [k, n] of jsonCounts) lines.push(`- ${k}: ${n}`);
  }
  return lines.join('\n');
}

export function canaryTypesValue(taxonomy, { visualAllowed = false } = {}) {
  return taxonomy.types
    .filter((t) => visualAllowed || !t.needsRebuild)
    .map(
      (t) =>
        `- ${t.id} — ${t.title}: ${t.definition}` +
        (t.attentionEligible ? ' (can be used to check a lens\'s attention' + (t.id === 'OMIT-REQ' ? ', only for a lens that lists it' : '') + ')' : ''),
    )
    .join('\n');
}

function exampleValue(ctx, artifactType) {
  const dir = path.join(ctx.repoDir, 'lenses', 'examples');
  for (const name of [`${artifactType}.json`, 'marketing-plan.json']) {
    const p = path.join(dir, name);
    if (exists(p)) return readText(p).replace(/\s+$/, '');
  }
  return '(no example available)';
}

// ---------------------------------------------------------------- lens validation (9.6)

function normWs(s) {
  return normalizeQuote(String(s ?? '')).replace(/\s+/g, ' ').trim();
}

/** Every glob/pointer used by lens minimums (for manifest counts). */
export function minimumCountSpecs(lensesJson) {
  const specs = [];
  const seen = new Set();
  for (const l of lensesJson?.lenses || []) {
    for (const m of l.minimum || []) {
      if (!m.glob) continue;
      const key = m.pointer ? `${m.glob}#${m.pointer}` : m.glob;
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push(m.pointer ? { glob: m.glob, pointer: m.pointer } : { glob: m.glob });
    }
  }
  return specs;
}

/**
 * validateLenses(lenses, { task, manifest, sources, taxonomy, patterns, generalist }) -> errors[]
 * lenses: { requirements, lenses } (answer or lenses.json). manifest: from buildManifest with
 * countsFor = minimumCountSpecs(lenses).
 */
export function validateLenses(lensesJson, { task, manifest, sources, taxonomy, patterns, generalist = true, schemaName = 'lenses', ownerLanguage = null }) {
  const errors = [];
  const sch = validate(loadSchema(schemaName), lensesJson);
  if (!sch.ok) for (const e of sch.errors.slice(0, 30)) errors.push(`schema ${e.path || '/'}: ${e.message}`);
  const lenses = Array.isArray(lensesJson?.lenses) ? lensesJson.lenses : [];
  const reqs = Array.isArray(lensesJson?.requirements) ? lensesJson.requirements : [];
  if (lenses.length < LENS_COUNT.min || lenses.length > LENS_COUNT.max) errors.push(`there must be ${LENS_COUNT.min} to ${LENS_COUNT.max} lenses (got ${lenses.length})`);
  const ids = lenses.map((l) => l.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) errors.push(`lens ids are not unique: ${[...new Set(dup)].join(', ')}`);
  const hasGen = ids.includes('generalist');
  if (generalist && !hasGen) errors.push('a lens with id "generalist" is required (the setting is on)');
  if (!generalist && hasGen) errors.push('no lens with id "generalist" is allowed (the setting is off)');
  // A file added by a later fix must be read by someone, or the next round is blocked until the
  // owner widens the lenses (r2-f18): the generalist carries one catch-all reading rule.
  const rootNames = [...new Set((manifest?.files || []).map((f) => String(f.rel).split('/')[0]))];
  const catchAll = (l) => {
    const globs = new Set((l?.minimum || []).filter((m) => m.kind === 'all-files').map((m) => m.glob));
    if (globs.has('**/*') || globs.has('**')) return true;
    return rootNames.length > 0 && rootNames.every((r) => globs.has(`${r}/**/*`) || globs.has(`${r}/**`));
  };
  if (generalist && hasGen && !catchAll(lenses.find((l) => l.id === 'generalist'))) {
    errors.push('lens generalist: needs an all-files minimum rule with glob "**/*" (or "<root>/**/*" for every root; files added by later fixes must be read by someone)');
  }
  if (!generalist && lenses.length && !lenses.some(catchAll)) {
    errors.push('one lens needs an all-files minimum rule with glob "**/*" (or "<root>/**/*" for every root; files added by later fixes must be read by someone)');
  }
  const rids = reqs.map((r) => r.id);
  const rdup = rids.filter((x, i) => rids.indexOf(x) !== i);
  if (rdup.length) errors.push(`requirement ids are not unique: ${[...new Set(rdup)].join(', ')}`);

  // Titles, duties and requirement texts reach the owner's plain-Russian summary and report (r2-f26).
  if (ownerLanguage === 'ru') {
    const cyr = (s) => /[А-Яа-яЁё]/.test(String(s ?? ''));
    for (const l of lenses) if (!cyr(l.title) || !cyr(l.duty)) errors.push(`lens ${l.id}: title and duty must be written in Russian (the owner reads them)`);
    for (const r of reqs) if (!cyr(r.text)) errors.push(`requirement ${r.id}: text must be written in Russian (the owner reads it)`);
  }

  // 2. task quotes
  const taskN = normWs(task);
  for (const r of reqs) {
    if (!r.taskQuote || !taskN.includes(normWs(r.taskQuote))) errors.push(`requirement ${r.id}: taskQuote is not a verbatim part of the task: "${String(r.taskQuote ?? '').slice(0, 120)}"`);
  }

  // 3–4. coverage and globs
  const files = (manifest?.files || []).map((f) => f.rel);
  const covered = new Set();
  const sourceIds = new Set((sources?.sources || sources || []).map((s) => s.id));
  for (const l of lenses) {
    const mids = (l.minimum || []).map((m) => m.id);
    const mdup = mids.filter((x, i) => mids.indexOf(x) !== i);
    if (mdup.length) errors.push(`lens ${l.id}: minimum ids are not unique: ${[...new Set(mdup)].join(', ')}`);
    for (const m of l.minimum || []) {
      if (m.kind === 'all-files' || m.kind === 'all-entries') {
        if (!m.glob) {
          errors.push(`lens ${l.id} ${m.id}: ${m.kind} needs a glob`);
          continue;
        }
        if (m.kind === 'all-entries' && !m.pointer) errors.push(`lens ${l.id} ${m.id}: all-entries needs a pointer`);
      }
      if (m.glob) {
        const hits = files.filter((f) => matchGlob(f, m.glob));
        if (hits.length === 0) errors.push(`lens ${l.id} ${m.id}: glob "${m.glob}" matches no file`);
        if (m.kind === 'all-files' || m.kind === 'all-entries') for (const h of hits) covered.add(h);
        if (m.pointer) {
          const n = manifest?.counts?.[`${m.glob}#${m.pointer}`];
          if (!n) errors.push(`lens ${l.id} ${m.id}: pointer ${m.pointer} gives no entries in "${m.glob}"`);
        }
      }
      if (m.kind === 'source-check') {
        if (!m.sourceId || !sourceIds.has(m.sourceId)) errors.push(`lens ${l.id} ${m.id}: source-check names an unknown source "${m.sourceId ?? ''}"`);
      }
    }
    // Reading checks (receipts) are drawn from the files a lens's glob rules name: a lens without one
    // would pass the receipts rule with nothing to answer.
    if (!(l.minimum || []).some((m) => m.glob)) errors.push(`lens ${l.id}: needs at least one minimum rule with a glob (all-files, all-entries, or an action with a glob); reading checks are drawn from it`);
    // 5. canary types
    for (const t of l.canaryTypes || []) if (!taxonomy.byId(t)) errors.push(`lens ${l.id}: unknown canary type "${t}"`);
  }
  const uncovered = files.filter((f) => !covered.has(f));
  if (uncovered.length) errors.push(`these files are not covered by any all-files/all-entries minimum: ${uncovered.slice(0, 20).join(', ')}`);

  // 6. prompt lint over every string value
  const { nonce: _n, taskSha256: _t, schemaVersion: _s, ...lintable } = lensesJson || {};
  const hits = lintValues(lintable, patterns);
  for (const h of hits.slice(0, 30)) errors.push(`forbidden text in ${h.name}: "${h.text}" (${h.patternId})`);
  return errors;
}

// ---------------------------------------------------------------- issue / ingest

function ensureConfigFiles(rc, opts) {
  const notes = [];
  if (!exists(rc.paths.sources)) {
    if (!opts.noSources) return { todo: ['Write sources.json with recipes you have actually run (or run step --no-sources once if the work has no primary sources).'] };
    writeJsonAtomic(rc.paths.sources, { schemaVersion: 1, sources: [] });
    log(rc, 'sources-check', { noSources: true, results: [] });
    notes.push('sources.json created empty (--no-sources); the report lists this.');
  } else {
    const src = loadSourcesFile(rc);
    if ((src.sources || []).length === 0 && !opts.noSources) {
      const done = rcHasNoSources(rc);
      if (!done) return { todo: ['sources.json lists no sources. Add recipes, or run step --no-sources once to confirm the work has no primary sources.'] };
    } else if ((src.sources || []).length === 0 && opts.noSources) {
      log(rc, 'sources-check', { noSources: true, results: [] });
    }
  }
  if (!exists(rc.paths.strip)) {
    writeJsonAtomic(rc.paths.strip, { schemaVersion: 1, excludeGlobs: [], regex: [], traceAllow: [] });
    notes.push('strip.json was missing; an empty one was written.');
  }
  if (!exists(rc.paths.mechanical)) {
    writeJsonAtomic(rc.paths.mechanical, { schemaVersion: 1, checks: [] });
    notes.push('mechanical.json was missing; an empty one was written.');
  }
  for (const [name, p] of [['sources', rc.paths.sources], ['strip', rc.paths.strip]]) {
    const v = validate(loadSchema(name), readExecutorJson(p, `${name}.json`));
    if (!v.ok) throw new UsageError(`${name}.json is invalid:\n  ` + v.errors.slice(0, 20).map((e) => `${e.path || '/'}: ${e.message}`).join('\n  '));
  }
  // The shape of every mechanical check, before anything is frozen: a check that cannot run would
  // otherwise block round 1 and need the owner's words to change. The window fixes its own file here.
  const mechProblems = mechanicalFileProblems(rc, readExecutorJson(rc.paths.mechanical, 'mechanical.json'));
  if (mechProblems.length) return { notes, todo: [mechanicalRefusal(mechProblems)] };
  return { notes };
}

/**
 * Every shape problem of a mechanical.json (schema, fields per kind, allowlist, "matches nothing in
 * the material"), judged against the files the round snapshot will hold. [] = sound.
 */
export function mechanicalFileProblems(rc, mechanical, { skipMaterial = null } = {}) {
  const schemaErrors = validate(loadSchema('mechanical'), mechanical).errors;
  let files = null;
  try {
    files = selectLiveFiles(rc.run);
  } catch {
    files = null; // an unusable root is reported by the material checks; do not hide the shape problems behind it
  }
  return mechanicalProblems(mechanical, { files, allow: rc.run.allowExecutables ?? [], schemaErrors, skipMaterial });
}

function rcHasNoSources(rc) {
  return ledgerLines(rc).some((l) => l.type === 'sources-check' && l.data && l.data.noSources === true);
}

function todoResult(rc, items, next, decision = null) {
  const todo = items.map((t) => ({ kind: 'setup', text: t }));
  return {
    exitCode: 20,
    state: rc.state.state,
    payload: { decision, todoPath: null, todo, summary: items[0] || '' },
    text: [...items.map((t) => `- ${t}`), '', `NEXT: ${next}`].join('\n'),
  };
}

/** NEW -> AWAIT_LENS_WRITER (or exit 20 with what is missing). */
export function issueLensWriter(rc, opts = {}) {
  if (!exists(rc.paths.task)) return todoResult(rc, ['Save the owner\'s words verbatim to a file and run `task set <run> --from <file>`.'], 'run task set, then step');
  const runErrors = validateRun(rc.run);
  if (runErrors.length) throw new UsageError('run.json is invalid:\n  ' + runErrors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n  '), { errors: runErrors });
  const cfg = ensureConfigFiles(rc, opts);
  if (cfg.todo) return todoResult(rc, cfg.todo, 'fix the settings, then step');

  // Review base path must be neutral and far from run files (D26, 15.5).
  const baseProblems = reviewBaseProblems(rc);
  if (baseProblems.length) return todoResult(rc, baseProblems, 'edit run.json reviewBase, then step');

  // Folder links and junctions inside the roots are never reviewed: say so before anything runs.
  const links = skippedLinksOf(rc.run);
  if (links.length) {
    return todoResult(
      rc,
      [`These folder links or junctions inside the material roots would be skipped (their files would never be reviewed): ${links.slice(0, 20).join(', ')}. Replace each with a real folder, add its target as another --root, or exclude it in run.json material.roots[].exclude.`],
      'fix the material roots, then step',
    );
  }

  const check = runSourcesCheck(rc);
  log(rc, 'sources-check', { results: check });
  const failing = check.filter((c) => !c.ok);
  if (failing.length) {
    return todoResult(
      rc,
      failing.map((c) => `Source ${c.id} failed: ${c.error || 'exit ' + c.exitCode}. Fix the recipe in sources.json (it must return data).${/written after the run started/.test(c.error || '') ? ' A script or file a source reads must exist before init: abort this run (abort <run> --reason ...) and start a new one after the file is in place.' : ''}`),
      'fix sources.json, then step',
    );
  }
  // Recipes that read a moving target (a branch, HEAD, an abbreviated hash, a file in the executor's own
  // working tree): refused unless the owner agreed to keep exactly these (night 06-07.10.2026).
  const moving = movingTargetProblems(loadSourcesFile(rc));
  let movingMissing = moving.filter((p) => !p.hint && !approvedMovingKeys(rc).has(p.key));
  if (movingMissing.length && opts.ownerQuote) {
    const w = ownerWords(opts.ownerQuote, opts.question);
    recordOwnerDecision(rc, { kind: 'moving-sources', quote: w.quote, question: w.question, narrowing: movingMissing.map((p) => p.key) });
    log(rc, 'owner-decision', { kind: 'moving-sources', quote: w.quote, question: w.question, narrowing: movingMissing.map((p) => p.key) });
    movingMissing = [];
  }
  if (movingMissing.length) return todoResult(rc, movingSourceTodo(movingMissing), 'fix sources.json, then step');
  // What the sources read now is the baseline every round start compares against (r3-f3).
  log(rc, 'sources-baseline', { files: sourcesBaseline(check) });

  // What strip.json and run.rebuild do to the reviewers' copy, checked before freeze (failure points 8, 15).
  const preview = previewReviewCopy({ run: rc.run, strip: loadStrip(rc), workDir: path.join(rc.paths.setupDir, `preview-${rngFor(rc, 'preview').id(8)}`), templatesDir: rc.paths.templatesDir, rng: rngFor(rc, 'preview-copy') });
  if (preview.problems.length) {
    return todoResult(rc, [...preview.problems, 'Fix strip.json, the material or run.rebuild; this check runs again at the next step.'], 'fix strip.json, then step');
  }
  const approved = new Set(ownerDecisionsOf(rc).filter((d) => d.kind === 'strip-narrowing').flatMap((d) => d.narrowing || []));
  let missing = preview.narrowing.filter((x) => !approved.has(x));
  if (missing.length && opts.ownerQuote) {
    const w = ownerWords(opts.ownerQuote, opts.question);
    recordOwnerDecision(rc, { kind: 'strip-narrowing', quote: w.quote, question: w.question, narrowing: missing });
    log(rc, 'owner-decision', { kind: 'strip-narrowing', quote: w.quote, question: w.question, narrowing: missing });
    missing = [];
  }
  if (missing.length) {
    return todoResult(
      rc,
      [
        'strip.json removes or rewrites material that is not a review trace, or lets a trace-like phrase through to reviewers (traceAllow); reviewers would see less, or more history, than the owner agreed to:',
        ...missing.map((x) => `  ${x}`),
        'Narrow the rules to review traces only (a rule may only delete text that carries a trace), drop the traceAllow phrases you cannot justify, or, if the owner agrees to exactly this (show the owner each item), run step again with --owner-quote "<the owner\'s words>" --question "<the exact question you asked the owner>".',
      ],
      'fix strip.json, then step',
    );
  }
  writeJsonAtomic(rc.paths.stripPreview, { schemaVersion: 1, stripSha256: hashOrNullFile(rc.paths.strip), ...preview.summary, narrowingApproved: preview.narrowing });

  const attempt = setupJobs(rc).length + 1;
  // Every lens-writer issue counts, resets included: changing a setting after reading the lens
  // writer's answer discards it and briefs a fresh writer, so without a cap the executor could
  // re-roll the lenses until it likes them (r2-f4). Beyond the cap, only on the owner's words.
  if (attempt > MAX_LENS_WRITER_ISSUES) {
    if (!opts.ownerQuote) {
      return todoResult(
        rc,
        [
          `The lens writer was already briefed ${attempt - 1} times in this run (resets after a settings change included); a further brief needs the owner's words.`,
          "Run step again with --owner-quote \"<the owner's words>\" --question \"<the exact question you asked the owner>\", or start a new run (that also needs the owner's words and the question).",
        ],
        'ask the owner, then step --owner-quote --question',
      );
    }
    const w = ownerWords(opts.ownerQuote, opts.question);
    recordOwnerDecision(rc, { kind: 'lens-writer-reissue', quote: w.quote, question: w.question, attempt });
    log(rc, 'owner-decision', { kind: 'lens-writer-reissue', quote: w.quote, question: w.question, attempt });
  }
  return renderLensWriter(rc, attempt, null, cfg.notes || []);
}

/** Lens-writer briefs per run (resets included) before the owner's words are needed. */
export const MAX_LENS_WRITER_ISSUES = 3;

function hashOrNullFile(p) {
  return exists(p) ? sha256Hex(fs.readFileSync(p)) : null;
}

/** Hash of every setting the lens writer and the freeze depend on (re-checked before freeze). */
export function settingsHash(rc) {
  return hashJson({
    run: hashOrNullFile(rc.paths.runJson),
    sources: hashOrNullFile(rc.paths.sources),
    strip: hashOrNullFile(rc.paths.strip),
    mechanical: hashOrNullFile(rc.paths.mechanical),
    task: hashOrNullFile(rc.paths.task),
  });
}

/** The owner's approvals of moving-target recipes: setup decisions and sources amendments. */
export function approvedMovingKeys(rc) {
  return new Set(
    ownerDecisionsOf(rc)
      .filter((d) => d.kind === 'moving-sources' || (d.kind === 'amend' && d.set?.what === 'sources'))
      .flatMap((d) => d.narrowing || []),
  );
}

/** What to tell the executor when recipes read moving targets (setup todo and amend error). */
export function movingSourceTodo(problems) {
  const lines = ['These sources read something that can change during the run, so a later round could see a different answer than the first one:'];
  for (const p of problems) lines.push(`  ${p.key} — ${p.why}. Fix: ${p.suggest}`);
  lines.push("Rewrite each recipe to a pinned form, or, if the owner agrees to keep exactly these (show the owner each item), run again with --owner-quote \"<the owner's words>\" --question \"<the exact question you asked the owner>\".");
  return lines;
}

function ownerDecisionsOf(rc) {
  return readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] }).decisions || [];
}

function recordOwnerDecision(rc, entry) {
  const decisions = ownerDecisionsOf(rc);
  decisions.push({ id: `O${decisions.length + 1}`, ts: now(), ...entry });
  writeJsonAtomic(rc.paths.ownerDecisions, { schemaVersion: 1, decisions });
}

/**
 * Problems with run.json reviewBase (D26, 15.5): it must be an absolute path under a run root
 * (GAUNTLET_RUN_ROOTS; any folder when the roots include `*`), outside the material roots, the run folder, the repository and the data home,
 * with no run folders, repository, data home or canary key files in it or next to it (a reviewer
 * is one or two `..` away from those), and with no review traces in its path.
 */
export function reviewBaseProblems(rc) {
  const base = rc.run.reviewBase;
  const out = [];
  const test = process.env.GAUNTLET_TEST === '1';
  if (typeof base !== 'string' || !path.isAbsolute(base) || (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(base))) {
    return [`run.json reviewBase "${base}" is not an absolute path. Set it to a neutral folder such as <run root>/_wc.`];
  }
  if (!test && !runRoots().any && !runRootOf(base)) {
    out.push(`run.json reviewBase ${base} is not under a run root (${runRoots().roots.join(', ')}; env GAUNTLET_RUN_ROOTS).`);
  }
  const near = [
    ...(rc.run.material?.roots || []).map((r) => ({ p: r.path, what: `the material root "${r.as}"` })),
    { p: rc.runDir, what: 'the run folder' },
    ...(rc.ctx?.repoDir ? [{ p: rc.ctx.repoDir, what: 'the gauntlet repository' }] : []),
    ...(!test && rc.dataPaths?.root ? [{ p: rc.dataPaths.root, what: 'the gauntlet data home' }] : []),
  ];
  for (const n of near) {
    if (isUnder(base, n.p)) out.push(`run.json reviewBase ${base} lies inside ${n.what} (${n.p}).`);
    else if (isUnder(n.p, base)) out.push(`run.json reviewBase ${base} contains ${n.what} (${n.p}).`);
  }
  const NEAR_NAMES = /^(?:gauntlet-runs|gauntlet|gauntlet-data|sealed)$|\.key\.json$/i;
  for (const dir of [base, path.dirname(base)]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const bad = names.filter((n) => NEAR_NAMES.test(n));
    if (bad.length) out.push(`run.json reviewBase ${base}: ${dir} holds ${bad.join(', ')}; reviewers would be one or two folders away from run files or answer keys. Use a separate folder such as <run root>/_wc.`);
  }
  const baseHits = lintPath(base, loadPatterns('trace'));
  if (baseHits.length) out.push(`The review base ${base} has review traces in its path (${baseHits.map((h) => h.component).join(', ')}). Set run.json reviewBase to a neutral folder under a run root.`);
  return out;
}

function renderLensWriter(rc, attempt, previousErrors, notes = []) {
  const taxonomy = loadTaxonomy();
  const manifest = buildManifest(rc.run, { countsFor: [] });
  if (manifest.files.length === 0) {
    return todoResult(rc, ['The material roots select no files. Check run.json material.roots and the include/exclude globs.'], 'fix run.json, then step');
  }
  const sampling = samplingSettings(rc.run);
  const { large: largeFiles, unsampled: unsampledFiles } = dataFilesOfRun(rc.run, manifest, sampling);
  const values = {
    TASK: taskText(rc),
    ARTIFACT_TYPE: rc.run.artifactType,
    MANIFEST_SUMMARY: manifestSummaryValue(manifest, largeFiles.length || unsampledFiles.length ? annotateForLensWriter(largeFiles, sampling, unsampledFiles) : null),
    SOURCES: sourcesValue(rc, null, { withRecipes: false }),
    EXAMPLE: exampleValue(rc.ctx, rc.run.artifactType),
    CANARY_TYPES: canaryTypesValue(taxonomy, { visualAllowed: !!rc.run.canaries?.visualAllowed }),
    GENERALIST: rc.run.generalist ? 'on' : 'off',
    PREVIOUS_ERRORS: previousErrors ? previousErrors.map((e) => `- ${e}`).join('\n') : '',
  };
  const dir = path.join(rc.paths.setupDir, `lens-writer-${attempt}`);
  ensureDir(dir);
  const rec = issueJob(rc, { round: null, role: 'lens-writer', attempt, values, promptsDir: dir, lintSkip: ['NONCE', 'JOB_DIR', 'CHECK_COMMAND', 'EXAMPLE', 'CANARY_TYPES', 'PREVIOUS_ERRORS', 'MANIFEST_SUMMARY'] });
  writeJsonAtomic(path.join(dir, 'job.json'), rec);
  move(rc, 'issue-lens-writer', { pendingJobs: [rec.job] }, 'lens-writer-issued', { job: rec.job, attempt, previousErrors: previousErrors || [], settingsSha256: settingsHash(rc) });
  return spawnResult(rc, [rec], notes.join('\n'));
}

/** AWAIT_LENS_WRITER: ingest, validate, freeze (or re-issue / stop). */
export function ingestLensWriter(rc, opts = {}) {
  const jobs = setupJobs(rc);
  const rec = jobs[jobs.length - 1];
  if (!rec) throw new UsageError('no lens-writer job was issued');
  const dir = path.join(rc.paths.setupDir, `lens-writer-${rec.attempt}`);
  const giveUp = opts.giveUp && (opts.giveUp.includes('missing') || opts.giveUp.includes(rec.job));
  const base = ingestAnswer(rc, null, rec, { dest: path.join(dir, 'answer.json') });
  if (!base) {
    if (!giveUp) return spawnResult(rc, [rec], 'The lens-writer answer is not there yet.');
    log(rc, 'job-given-up', { job: rec.job, role: 'lens-writer', attempt: rec.attempt });
    writeJsonAtomic(path.join(dir, 'job.json'), { ...rec, status: 'given-up' });
    return retryOrStop(rc, rec, ['the previous writer gave no answer']);
  }
  writeJsonAtomic(path.join(dir, 'job.json'), { ...rec, status: 'answered', answerSha256: base.answerSha256 });
  // Settings changed after the lens writer was briefed (run.json, sources, strip, mechanical, task):
  // the checks before the lens writer ran no longer describe what would be frozen. Start setup again.
  const issued = [...ledgerLines(rc)].reverse().find((l) => l.type === 'lens-writer-issued');
  if (issued?.data?.settingsSha256 && issued.data.settingsSha256 !== settingsHash(rc)) {
    move(rc, 'reset-setup', { pendingJobs: [] }, 'setup-reset', { reason: 'settings changed after the lens writer was briefed', job: rec.job });
    return { next: true };
  }
  let errors = [];
  if (!base.kept) {
    errors = [...base.reasons.map((r) => `answer rejected: ${r}`), ...base.schemaErrors.map((e) => `schema ${e.path || '/'}: ${e.message}`)];
  } else {
    const answer = base.json;
    const lensesJson = { schemaVersion: 1, requirements: answer.requirements, lenses: answer.lenses };
    const manifest = buildManifest(rc.run, { countsFor: minimumCountSpecs(lensesJson) });
    errors = validateLenses(
      { ...lensesJson, taskSha256: sha256Hex(fs.readFileSync(rc.paths.task)) },
      {
        task: readText(rc.paths.task),
        manifest,
        sources: loadSourcesFile(rc),
        taxonomy: loadTaxonomy(),
        patterns: loadPatterns('prompt', { controlOnly: true }),
        generalist: !!rc.run.generalist,
        ownerLanguage: rc.run.language?.report ?? null,
      },
    );
    if (errors.length === 0) return freeze(rc, lensesJson);
  }
  log(rc, 'lenses-ingested', { job: rec.job, ok: false, errors: errors.slice(0, 40) });
  return retryOrStop(rc, rec, errors);
}

function retryOrStop(rc, rec, errors) {
  if (rec.attempt < 2) return renderLensWriter(rc, rec.attempt + 1, errors);
  return { stop: true, decision: 'STOP_INCONCLUSIVE', reason: 'lens-writer', errors };
}

/** Write lenses.json and FROZEN.json, the setup summary; state READY. */
export function freeze(rc, lensesJson, { event = 'freeze' } = {}) {
  // The run's template copy must still be what init copied (and checked against the MANIFEST):
  // a template edited in the run folder before freeze would otherwise be frozen as is (r2-f12).
  const initEv = ledgerLines(rc).find((l) => l.type === 'init');
  const atInit = initEv?.data?.templates;
  if (atInit && typeof atInit === 'object') {
    const now = {};
    if (exists(rc.paths.templatesDir)) for (const rel of listFiles(rc.paths.templatesDir)) now[rel] = hashFile(path.join(rc.paths.templatesDir, ...rel.split('/')));
    const keys = new Set([...Object.keys(atInit), ...Object.keys(now)]);
    const diff = [...keys].filter((k) => atInit[k] !== now[k]).sort();
    if (diff.length) throw new IntegrityError('TEMPLATE_MISMATCH', `run templates changed after init: ${diff.join(', ')}`);
  }
  const lenses = { schemaVersion: 1, taskSha256: sha256Hex(fs.readFileSync(rc.paths.task)), requirements: lensesJson.requirements, lenses: lensesJson.lenses };
  writeJsonAtomic(rc.paths.lenses, lenses);
  log(rc, 'lenses-ingested', { ok: true, sha256: sha256Hex(fs.readFileSync(rc.paths.lenses)), lenses: lenses.lenses.map((l) => l.id), requirements: lenses.requirements.map((r) => r.id) });
  const frozen = writeFrozen(rc.runDir, { repoDir: rc.ctx.repoDir });
  rc.frozen = frozen;
  rc.run = readJson(rc.paths.runJson);
  writeTextAtomic(rc.paths.setupSummary, setupSummaryRu(rc, lenses, frozen));
  const ad = agentDefaults();
  move(rc, 'freeze', { frozen: true, pendingJobs: [] }, event, { frozenSha256: hashJson(frozen), instrumentId: frozen.instrumentId, agentDefaults: { model: ad.model, modelFrom: ad.modelFrom, effort: ad.effort, sonnet: ad.sonnet, effortHigh: ad.effortHigh } });
  const items = [
    'Setup is frozen. SETUP-SUMMARY.ru.md describes the plan in plain Russian; show it to the owner on request.',
    'Run step to start round 1.',
  ];
  return {
    exitCode: 20,
    state: rc.state.state,
    payload: { decision: null, todoPath: rc.paths.setupSummary, todo: items.map((t) => ({ kind: 'setup', text: t })), summary: 'setup frozen' },
    text: [...items.map((t) => `- ${t}`), '', 'NEXT: run step to start round 1'].join('\n'),
  };
}

export function unguardedLenses(lensesJson, taxonomy, run) {
  const out = [];
  for (const l of lensesJson.lenses) {
    const ok = (l.canaryTypes || []).some((id) => {
      const t = taxonomy.byId(id);
      if (!t || !t.attentionEligible) return false;
      if (t.needsRebuild && !(run.canaries?.visualAllowed && run.rebuild)) return false;
      return true;
    });
    if (!ok) out.push(l.id);
  }
  return out;
}

const ARTIFACT_RU = { 'marketing-plan': 'маркетинговый план', copy: 'тексты', slides: 'слайды', report: 'отчёт', code: 'код', other: 'работу' };
const ROLE_RU = { reviewer: 'проверяющий', verifier: 'перепроверка', planter: 'подкладывающий ошибки', validator: 'проверка подложенных ошибок', matcher: 'сопоставление', 'lens-writer': 'составитель плана', 'confirm-extra': 'дополнительный проверяющий в последнем круге' };

/** A size as the owner reads it: «2,4 МБ» or «300 КБ». */
export function sizeRu(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** The note after a file that belongs to a group of files of one kind in one folder (sample.mjs classifyEntries). */
function groupRu(g) {
  return g ? ` (один из ${g.files} файлов одного вида в этой папке, вместе ${sizeRu(g.bytes)}; поодиночке они ниже порога, но вместе это один набор данных, и проверяются они как один)` : '';
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function setupSummaryRu(rc, lensesJson, frozen) {
  const run = rc.run;
  const taxonomy = loadTaxonomy();
  const n = lensesJson.lenses.length;
  const perRound = n * COST_PER_LENS + COST_BASE;
  const mln = (x) => (x / 1e6).toFixed(1).replace('.', ',');
  const lines = [];
  lines.push(`# План проверки — ${run.project}`);
  lines.push('');
  lines.push(`Запуск: ${run.runId}. Что проверяем: ${ARTIFACT_RU[run.artifactType] || 'работу'}.`);
  if (run.ownerTarget) lines.push(`Ваша планка «${run.ownerTarget}» понимается так: два круга подряд без перепроверенных серьёзных проблем, второй — слепой, свежими проверяющими. Самим проверяющим эта цифра не показывается.`);
  lines.push('');
  lines.push('## Что требует задание');
  lines.push('');
  for (const r of lensesJson.requirements) lines.push(`- ${r.id}. ${r.text} — по словам задания: «${r.taskQuote}» (${r.ifMissing === 'blocker' ? 'без этого работа не готова' : 'серьёзное требование'})`);
  lines.push('');
  lines.push(`## Кто проверяет (${n} ${plural(n, 'взгляд', 'взгляда', 'взглядов')})`);
  lines.push('');
  lines.push('Взгляд — это одна обязанность проверки, например «факты и цифры» или «понятно ли новому читателю». У каждого взгляда в каждом круге свой новый проверяющий.');
  lines.push('');
  for (const l of lensesJson.lenses) lines.push(`- ${l.title}: ${l.duty}`);
  const ung = unguardedLenses(lensesJson, taxonomy, run);
  if (ung.length) {
    lines.push('');
    const titles = ung.map((id) => `«${(lensesJson.lenses.find((l) => l.id === id) || {}).title || id}»`);
    lines.push(`Внимание: для взглядов ${titles.join(', ')} нельзя подложить проверочную ошибку, поэтому они не смогут подтвердить готовность.`);
  }
  lines.push('');
  lines.push('## Как идёт работа');
  lines.push('');
  lines.push(`- Не больше ${run.limits.maxRounds} кругов и не больше ${mln(run.limits.maxPanelTokens)} млн токенов на проверяющих.`);
  lines.push('- Кругом считается только то, что дошло до проверяющих. Попытка круга, которая не прошла проверки до начала, номера не получает и в лимит не входит; в отчёте и в сообщениях программы будут настоящие номера кругов, а номер папки запуска — в скобках, если он другой («круг 3 (папка 04)»).');
  lines.push(`- Готово, только если чистый круг подтверждён ещё одним слепым кругом на той же версии (подтверждающих кругов не больше ${run.limits.maxConfirms}).`);
  lines.push(`- Если ${run.limits.plateauRounds} круга подряд серьёзных проблем не становится меньше — остановка и вопрос вам.`);
  if (run.canaries?.fixedKey) {
    const fk = run.canaries.fixedKey;
    lines.push(`- Это проверочный прогон (по вашему слову «${fk.quote}», ${fk.date}): в каждом круге используются одни и те же заранее известные подложенные ошибки из файла \`${fk.path}\`. Готовой работу такой прогон не объявляет, и его числа не идут в общий журнал внимательности.`);
  } else {
    lines.push(`- В каждый круг подкладывается по одной ошибке на каждый взгляд и ещё ${run.canaries.measurementWorking} для замера (в подтверждающем круге — ${run.canaries.measurementConfirm}). Это только грубая проверка, что проверяющие не спали; насколько хорошо они ловят ошибки, видно лишь по общему журналу за много запусков.`);
    if (decoysWanted(run) > 0 && exists(path.join(rc.paths.templatesDir, 'decoy-writer.md'))) {
      lines.push(`- На перепроверку в каждом круге подмешиваются заведомо ложные замечания (не больше ${decoysWanted(run)} на круг): они выглядят как настоящие, но в работе их нет. Если агент, который перепроверяет находки, подтвердил такое, всё остальное, что он подтвердил в той же пачке, проверяет другой агент. В отчёте будет сказано, сколько ложных замечаний отклонила перепроверка.`);
    }
    if (controlsWanted(run) > 0) {
      lines.push(`- На перепроверку в каждом круге подмешиваются и настоящие проблемы, о которых мы почти наверняка знаем (не больше ${controlsWanted(run)} на круг): это ошибки, которые программа сама подложила в проверяемую копию и которые проверяющие нашли. Если агент отверг такую проблему или счёл её менее серьёзной, чем она есть, всё остальное, что он отверг или признал мелочью в той же пачке, проверяет другой агент. В отчёте будет сказано, сколько настоящих проблем перепроверка ошибочно отвергла.`);
    }
  }
  let images = 0;
  try {
    images = buildManifest(run, { countsFor: [] }).files.filter((f) => f.kind === 'image' || f.kind === 'video').length;
  } catch {
    images = 0;
  }
  if (images && !run.canaries?.visualAllowed) {
    lines.push(`- В работе ${images} ${plural(images, 'картинка или видео', 'картинки или видео', 'картинок и видео')}, но ошибки в них не подкладываются (${run.rebuild ? 'это выключено в настройках' : 'нет команды пересборки копии'}). Поэтому то, что проверяющие смотрят картинки, этот запуск не проверяет.`);
  }
  const loose = looserLimits(run);
  if (loose.length) {
    lines.push(`- Пределы шире обычных по вашему слову «${run.limitsOptIn?.quote ?? 'слова не записаны'}»: ${loose.map((l) => `${LIMIT_RU[l.key] || l.key} ${l.value} (обычно ${l.default})`).join(', ')}.`);
  }
  lines.push('');
  lines.push(...historySummaryRu(rc));
  lines.push(...sourcesSummaryRu(rc));
  lines.push(...stripSummaryRu(rc));
  // Files the program cannot read as text (r2-f22): no trace scan, no strip rule, no quote check.
  let opaque = [];
  try {
    // genuinely binary only: a file that decodes as text is trace-scanned like text (r3-f15)
    const absOf = (rel) => {
      const [as, ...rest] = rel.split('/');
      const root = (run.material?.roots || []).find((r) => r.as === as);
      return root ? path.join(root.path, ...rest) : null;
    };
    opaque = buildManifest(run, { countsFor: [] })
      .files.filter((f) => f.kind === 'binary')
      .filter((f) => {
        const abs = absOf(f.rel);
        try {
          return !abs || decodeForScan(fs.readFileSync(abs)) === null;
        } catch {
          return true;
        }
      })
      .map((f) => f.rel);
  } catch {
    opaque = [];
  }
  if (opaque.length) {
    lines.push('## Файлы, которые программа не читает как текст');
    lines.push('');
    lines.push(`Их ${opaque.length}. В них программа не ищет следы прошлых проверок, правила вырезания их не трогают, а цитату из них нельзя сверить. Проверяющие их открывают, но этим файлам защита слабее.`);
    for (const rel of opaque.slice(0, 20)) lines.push(`- \`${rel}\``);
    if (opaque.length > 20) lines.push(`- и ещё ${opaque.length - 20}`);
    lines.push('');
  }
  const sampling = samplingSettings(run);
  let largeFiles = [];
  let unsampledFiles = [];
  try {
    ({ large: largeFiles, unsampled: unsampledFiles } = dataFilesOfRun(run, buildManifest(run, { countsFor: [] }), sampling));
  } catch {
    largeFiles = [];
    unsampledFiles = [];
  }
  if (largeFiles.length) {
    lines.push('## Большие файлы с данными');
    lines.push('');
    lines.push(`Их ${largeFiles.length}. Проверяющий не может прочитать такой файл целиком, поэтому в каждом круге программа сама, наугад, выбирает из каждого до ${sampling.rows} строк (и все строки, куда подложена проверочная ошибка), а проверяющие читают именно их. Выбор делается уже после того, как версия работы зафиксирована на круг, и каждый круг он новый; исполнитель заранее его не знает. В отчёте будет честно написано, сколько строк из скольких проверяющие видели; ошибки вне выборки могли остаться.`);
    for (const x of largeFiles.slice(0, 20)) lines.push(`- \`${x.file}\`: ${x.rows} ${plural(x.rows, 'строка', 'строки', 'строк')}, ${sizeRu(x.bytes)}${groupRu(x.grouped)}`);
    if (largeFiles.length > 20) lines.push(`- и ещё ${largeFiles.length - 20}`);
    lines.push('');
  }
  if (unsampledFiles.length) {
    lines.push('## Большие файлы, из которых нельзя выбрать строки');
    lines.push('');
    lines.push(`Их ${unsampledFiles.length}. Это файлы с данными, которые слишком велики для чтения целиком и не делятся на отдельные записи: один большой объект (формат json), xml, выгрузка базы (sql), текстовый файл или журнал (txt, log). Выборку из них программа сделать не может. Проверяющему в списке работы написано, что файл слишком большой: он проверяет его устройство и отдельные места, а чего не читал, называет среди непроверенного. Подложенные ошибки в такие файлы не кладутся. В отчёте каждый такой файл назван, и там честно сказано, что целиком он не проверен.`);
    for (const x of unsampledFiles.slice(0, 20)) lines.push(`- \`${x.file}\`: ${sizeRu(x.bytes)}${groupRu(x.grouped)}`);
    if (unsampledFiles.length > 20) lines.push(`- и ещё ${unsampledFiles.length - 20}`);
    lines.push('');
  }
  lines.push('## Цена');
  lines.push('');
  lines.push(`- Примерно ${mln(perRound)} млн токенов за круг.`);
  // the stop rule budgets with roundTokenEstimate until real rounds are measured (r3-f32)
  const est = run.limits?.roundTokenEstimate;
  if (Number.isFinite(est) && Math.abs(est - perRound) >= 50000) lines.push(`- Для остановки по бюджету программа считает каждый следующий круг в ${mln(est)} млн токенов, пока не измерит настоящий расход, и не меньше этого после; поэтому остановка по токенам может наступить раньше, чем выходит по строке выше.`);
  const opt = run.models?.optIn || [];
  // Only what the Claude home actually says (r3-f20): no explicit model is passed to the agents.
  const ad = agentDefaults();
  const workflow = run.driver?.mode === 'workflow';
  if (opt.length === 0) {
    if (ad.sonnet && (ad.effortHigh || workflow)) lines.push('- Все проверяющие и помощники — модель Sonnet с высоким уровнем старания (так настроен Claude в этом окне).');
    else lines.push(`- Модель проверяющих задаёт настройка Claude в этом окне, программа её не выбирает. Проверить не удалось: модель в настройках — ${ad.model ?? 'не указана'}, уровень старания — ${workflow ? 'высокий (его задаёт Workflow)' : ad.effort ?? 'не указан'}. Слова «Sonnet, высокий уровень старания» здесь не подтверждены.`);
  }
  else for (const o of opt) lines.push(`- Для роли «${ROLE_RU[o.role] || o.role}» по вашему слову «${o.quote}» (${o.date}) — модель ${o.model}.`);
  lines.push('');
  const initEv2 = ledgerLines(rc).find((l) => l.type === 'init');
  const appr = initEv2?.data?.templatesApproval;
  lines.push(appr
    ? `Вопросы проверяющим составлены по шаблонам версии ${initEv2?.data?.templatesManifestVersion ?? '?'}; вы одобрили эту версию ${appr.date}: «${String(appr.quote).replace(/[«»]/g, '"')}».`
    : `Вопросы проверяющим составлены по шаблонам версии ${initEv2?.data?.templatesManifestVersion ?? '?'}; вашего одобрения этой версии в записях нет.`);
  lines.push('');
  lines.push(`Для технической сверки: отпечаток плана ${String(frozen.instrumentId).slice(0, 12)}, отпечаток шаблонов ${String(initEv2?.data?.templatesManifestSha256 ?? '?').slice(0, 12)}.`);
  return lines.join('\n') + '\n';
}

const LIMIT_RU = Object.freeze({
  maxRounds: 'кругов',
  maxConfirms: 'подтверждающих кругов',
  maxPanelTokens: 'токенов',
  plateauRounds: 'кругов без улучшения до остановки',
  maxLensReruns: 'повторов одного взгляда',
  verifierBatchMax: 'находок на одного агента-перепроверки',
  roundTokenEstimate: 'оценка токенов на круг',
  sampleThresholdBytes: 'размер файла с данными, с которого проверка идёт по выборке, байт',
  sampleThresholdRows: 'число строк в файле, с которого проверка идёт по выборке',
  sampleRows: 'строк в выборке из большого файла',
  sampleMaxBytes: 'наибольший объём выборки из одного файла, знаков',
  sampleTotalBytes: 'наибольший объём выборок из всех больших файлов вместе, знаков',
  'canaries.attentionPerLens': 'подложенных ошибок на один взгляд',
  'canaries.measurementWorking': 'ошибок для замера в рабочем круге',
  'canaries.measurementConfirm': 'ошибок для замера в подтверждающем круге',
  'canaries.candidatesPerSlot': 'вариантов на одну подложенную ошибку',
  'canaries.maxEditChars': 'наибольшая длина подложенной правки, знаков',
  'canaries.minDistanceChars': 'наименьшее расстояние между подложенными ошибками, знаков',
  'canaries.decoysPerRound': 'заведомо ложных замечаний в круге',
  'canaries.controlsPerRound': 'известных настоящих проблем, подмешиваемых к перепроверке, в круге',
});

/**
 * «Что было до этого плана» (r2-f4, r2-f8): earlier runs on the same material with the problems
 * they left open, how many times the lens writer was briefed (resets included), and task lines
 * cut on the owner's words.
 */
export function historySummaryRu(rc) {
  const lines = ledgerLines(rc);
  const out = [];
  const init = lines.find((l) => l.type === 'init');
  const earlier = init?.data?.earlierRuns || [];
  const issued = lines.filter((l) => l.type === 'lens-writer-issued').length;
  const resets = lines.filter((l) => l.type === 'setup-reset').length;
  const taskEv = [...lines].reverse().find((l) => l.type === 'task-set');
  const reqCuts = (taskEv?.data?.cut || []).filter((c) => c && c.control === false);
  if (!earlier.length && issued <= 1 && !resets && !reqCuts.length) return out;
  out.push('## Что было до этого плана');
  out.push('');
  for (const e of earlier) {
    out.push(`- Раньше по этой же работе был запуск ${e.runId} (${e.status || 'состояние неизвестно'}${e.lastDecision ? `, ${e.lastDecision}` : ''}). Открытых перепроверенных серьёзных проблем в нём осталось: ${e.openSerious.length}.`);
    for (const c of e.openSerious.slice(0, 10)) out.push(`  - ${c.severity === 'blocker' ? 'блокер' : 'существенная'}, \`${c.file || '?'}\`: «${String(c.problem).replace(/[«»]/g, '"')}»`);
  }
  if (issued > 1 || resets) out.push(`- Составитель заданий для проверяющих вызывался ${issued} ${plural(issued, 'раз', 'раза', 'раз')}, из них после смены настроек заново: ${resets}.`);
  if (reqCuts.length) {
    out.push(`- Из задания по вашему слову «${taskEv.data.ownerQuote || ''}» убраны строки-требования:`);
    for (const c of reqCuts) out.push(`  - строка ${c.line}: «${String(c.text).replace(/[«»]/g, '"')}»`);
  }
  out.push('');
  return out;
}

/** «С чем проверяющие сверяют цифры»: every source with its origin and recipe (failure point 7). */
export function sourcesSummaryRu(rc) {
  const out = ['## С чем проверяющие сверяют цифры', ''];
  let src = [];
  try {
    src = loadSourcesFile(rc).sources || [];
  } catch {
    src = [];
  }
  if (!src.length) out.push('Первоисточников нет: проверяющим не с чем сверять цифры и факты, кроме самой работы.');
  for (const s of src) {
    const recipe = s.kind === 'command' ? [s.cmd, ...(s.args || [])].map(quoteArg).join(' ') : s.path;
    out.push(`- ${s.id}: «${String(s.what).replace(/[«»]/g, '"')}» (со слов исполнителя)`);
    out.push(`  Откуда (со слов исполнителя): ${String(s.origin || 'не указано').replace(/[.\s]+$/, '')}.`);
    out.push(`  Как получить: \`${recipe}\``);
  }
  out.push('');
  return out;
}

/** «Что убрано из копии для проверяющих»: strip rules, excluded files, rebuild (failure points 8, 15). */
export function stripSummaryRu(rc) {
  const pv = readJsonIf(rc.paths.stripPreview, null);
  const out = ['## Что убрано из копии для проверяющих', ''];
  if (!pv) {
    out.push('Сведений о подготовке копии нет.');
    out.push('');
    return out;
  }
  const ex = pv.excluded || [];
  if (!ex.length) out.push('- Ни один файл работы не убран из копии.');
  else {
    out.push(`- Убрано файлов: ${ex.length}.`);
    for (const e of ex.slice(0, 30)) out.push(`  - \`${e.file}\` (${e.trace ? 'в нём следы прошлых проверок' : 'следов прошлых проверок в нём нет; убран с вашего согласия'})`);
  }
  const rules = pv.rules || [];
  if (!rules.length) out.push('- Правил, вырезающих текст, нет.');
  for (const r of rules) {
    const extra = r.nonTrace ? `, из них ${r.nonTrace} без следов проверок, с вашего согласия` : '';
    out.push(`- Правило ${r.index + 1}: «${String(r.why).replace(/[«»]/g, '"')}» (со слов исполнителя). Вырезает \`${JSON.stringify(r.pattern).slice(1, -1)}\` в \`${r.glob}\`; совпадений ${r.matches}, файлов ${(r.files || []).length}${extra}.`);
  }
  const allow = pv.allow || [];
  if (!allow.length) out.push('- Исключений из поиска следов прошлых проверок нет.');
  for (const a of allow) {
    out.push(`- Пропущено к проверяющим, хотя похоже на след проверки: «${String(a.phrase).replace(/[«»]/g, '"')}» — совпадений ${a.matches}, файлов ${a.files}. Причина со слов исполнителя: «${String(a.why).replace(/[«»]/g, '"')}». Записано только с вашего согласия.`);
  }
  const tc = pv.traceCoverage;
  if (tc && tc.dataFiles > 0) {
    out.push(`- Файлов с данными: ${tc.dataFiles}. Маленькие, до 1 МБ и до 2000 строк (${tc.fullDataFiles ?? 0}), просматриваются на следы прошлых проверок всеми правилами, как обычный текст.`);
    const red = tc.reducedFiles || [];
    if (red.length) {
      out.push(`- Больших файлов с данными: ${red.length}. В них короткие значения (числа, названия, оценки) проверяются только самыми однозначными правилами, иначе пришлось бы переписывать настоящие данные; не применяется правил: ${red[0].patternsReduced ?? 0}. Значения длиннее трёх слов или 30 знаков проверяются всеми правилами.`);
      for (const x of red.slice(0, 10)) out.push(`  - \`${x.file}\`: ${x.rows} ${plural(x.rows, 'строка', 'строки', 'строк')}, коротких значений ${x.shortValues} (не всеми правилами), длинных ${x.proseValues} (всеми)`);
      if (red.length > 10) out.push(`  - и ещё ${red.length - 10}`);
    }
  }
  if (pv.rebuild) {
    out.push(`- Перед проверкой копия пересобирается командой \`${pv.rebuild.cmd}\`.`);
    const diff = pv.rebuild.differsFromMaterial || [];
    if (diff.length) out.push(`  После пересборки от вашей версии отличаются файлы ${diff.slice(0, 10).map((f) => `\`${f}\``).join(', ')}, потому что правила выше меняли исходники.`);
  }
  out.push('');
  return out;
}

export { effectiveModel, rootsKey, fileKind };
