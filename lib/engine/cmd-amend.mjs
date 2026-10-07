// `amend <run> --what sources|strip|mechanical|lenses|material|task --file <path> --reason <text> [--owner-quote <text> --question <text>]`
// (SPEC 10.2, D17). Only in READY (between rounds). Validates like at freeze. Code diffs old vs new:
// removing or narrowing anything (a lens, checklist line, minimum, source, mechanical check, root,
// include glob, task line; an added exclude glob or strip rule that touches a material file) needs
// the owner's quote, as do lens and task changes. Every amend clears the candidate, re-freezes and
// is logged with a diff summary; a changed lens set gives a new instrumentId. Templates never change.

import fs from 'node:fs';
import { ownerWords } from '../core/owner.mjs';
import { UsageError } from '../core/errors.mjs';
import { readJson, readText, writeJsonAtomic, writeTextAtomic, exists } from '../core/fsx.mjs';
import { hashJson, sha256Hex } from '../core/hash.mjs';
import { validate, loadSchema } from '../core/schema.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { matchGlob } from '../core/glob.mjs';
import { writeFrozen, validateRun, applyDefaults } from '../core/config.mjs';
import { now } from '../core/clock.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { checkSources, sourceFileChanges, sourcesBaseline, movingTargetProblems } from '../material/sources.mjs';
import { loadPatterns } from '../material/lint.mjs';
import { loadTaxonomy } from '../measure/taxonomy.mjs';
import { parseArgv, openRun, commitState, readJsonIf, log } from './state.mjs';
import { validateLenses, minimumCountSpecs, notesAbs, readExecutorJson, ownFolders, latestSourcesBaseline, approvedMovingKeys, mechanicalFileProblems } from './setup.mjs';
import { mechanicalRefusal, mechanicalNarrowing } from '../material/mechanical-shape.mjs';
import { previewReviewCopy } from './strip-preview.mjs';
import { rngFor } from './state.mjs';
import path from 'node:path';
import { buildTask } from './cmd-task.mjs';

const WHAT = ['sources', 'strip', 'mechanical', 'lenses', 'material', 'task'];

function removed(oldList, newList) {
  const n = new Set(newList.map((x) => JSON.stringify(x)));
  return oldList.filter((x) => !n.has(JSON.stringify(x)));
}

function added(oldList, newList) {
  const o = new Set(oldList.map((x) => JSON.stringify(x)));
  return newList.filter((x) => !o.has(JSON.stringify(x)));
}

/** Diff of lenses.json: removed lenses, checklist lines, procedure steps, minimum items. */
export function lensesNarrowing(oldL, newL) {
  const out = [];
  const nById = new Map((newL.lenses || []).map((l) => [l.id, l]));
  for (const l of oldL.lenses || []) {
    const n = nById.get(l.id);
    if (!n) {
      out.push(`lens ${l.id} removed`);
      continue;
    }
    for (const c of removed(l.checklist || [], n.checklist || [])) out.push(`lens ${l.id}: checklist line removed: ${c}`);
    for (const c of removed(l.procedure || [], n.procedure || [])) out.push(`lens ${l.id}: procedure step removed: ${c}`);
    for (const m of removed(l.minimum || [], n.minimum || [])) out.push(`lens ${l.id}: minimum ${m.id} removed or changed`);
  }
  for (const r of removed(oldL.requirements || [], newL.requirements || [])) out.push(`requirement ${r.id} removed or changed`);
  return out;
}

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, { options: ['what', 'file', 'reason', 'owner-quote', 'question', 'cut', 'source'] });
  const runDir = positional[0];
  if (!runDir || !WHAT.includes(opts.what) || !opts.file || !opts.reason) {
    throw new UsageError(`usage: amend <run> --what ${WHAT.join('|')} --file <path> --reason <text> [--owner-quote <text> --question <text>]`);
  }
  const words = ownerWords(opts.ownerQuote, opts.question, { required: false });
  const quote = words?.quote ?? null;
  return withLock(normalizeInput(runDir), async () => {
    const rc = openRun(runDir, ctx, { states: ['READY'], command: 'amend' });
    const file = normalizeInput(opts.file);
    if (!exists(file)) throw new UsageError(`no such file: ${file}`);
    const narrowing = [];
    const movingHints = [];
    let needQuote = false;
    const diff = {};
    const pending = [];
    const manifest = buildManifest(rc.run, { countsFor: minimumCountSpecs(readJsonIf(rc.paths.lenses, { lenses: [] })) });
    const materialFiles = manifest.files.map((f) => f.rel);

    if (opts.what === 'sources') {
      const next = readExecutorJson(file, 'the amend file');
      const v = validate(loadSchema('sources'), next);
      if (!v.ok) throw new UsageError('sources file is invalid:\n  ' + v.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n  '));
      const old = readJsonIf(rc.paths.sources, { sources: [] });
      const gone = (old.sources || []).filter((s) => !(next.sources || []).some((n) => n.id === s.id));
      for (const s of gone) narrowing.push(`source ${s.id} removed`);
      // Any change to a kept source (recipe, path, description, origin, notes) can narrow what is
      // checked or steer the checkers: it needs the owner's words like a removal.
      for (const s of old.sources || []) {
        const n = (next.sources || []).find((x) => x.id === s.id);
        if (n && JSON.stringify(n) !== JSON.stringify(s)) narrowing.push(`source ${s.id} changed`);
      }
      // A new or changed recipe that reads a moving target (a branch, HEAD, an abbreviated hash, a file in the
      // executor's own working tree) needs the owner's words like any narrowing; recipes this amendment does not
      // touch are not re-linted (runs started before the lint keep their sources).
      const touched = (next.sources || []).filter((n) => {
        const o = (old.sources || []).find((x) => x.id === n.id);
        return !o || JSON.stringify(o) !== JSON.stringify(n);
      });
      const okMoving = approvedMovingKeys(rc);
      for (const pr of movingTargetProblems({ sources: touched })) {
        if (pr.hint || okMoving.has(pr.key)) continue;
        narrowing.push(pr.key);
        movingHints.push(`${pr.key} — ${pr.why}. Fix: ${pr.suggest}`);
      }
      const lenses = readJsonIf(rc.paths.lenses, { lenses: [] });
      for (const l of lenses.lenses) for (const m of l.minimum || []) if (m.kind === 'source-check' && !(next.sources || []).some((s) => s.id === m.sourceId)) throw new UsageError(`lens ${l.id} ${m.id} uses source ${m.sourceId}; it cannot be removed`);
      const started = Date.parse(rc.run.createdAt || '');
      const res = checkSources(next, { allow: rc.run.allowExecutables, notesAbs: notesAbs(rc.run), forbiddenRoots: ownFolders(rc), startedAtMs: Number.isFinite(started) ? started : null });
      const bad = res.filter((r) => !r.ok);
      if (bad.length) throw new UsageError('every source must work:\n  ' + bad.map((b) => `${b.id}: ${b.error || 'exit ' + b.exitCode}`).join('\n  '));
      // A file a kept source reads that changed since the baseline: accepting it re-baselines what
      // reviewers check against, so it needs the owner's words too (r3-f3).
      const base = latestSourcesBaseline(rc);
      if (base) for (const c of sourceFileChanges(base, res)) narrowing.push(`source ${c.id} reads ${c.path}, which changed since setup`);
      diff.removed = gone.map((s) => s.id);
      diff.added = (next.sources || []).filter((n) => !(old.sources || []).some((s) => s.id === n.id)).map((s) => s.id);
      pending.push(() => writeJsonAtomic(rc.paths.sources, next));
      pending.push(() => log(rc, 'sources-baseline', { files: sourcesBaseline(res), amend: true }));
    } else if (opts.what === 'strip') {
      const next = readExecutorJson(file, 'the amend file');
      const v = validate(loadSchema('strip'), next);
      if (!v.ok) throw new UsageError('strip file is invalid:\n  ' + v.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n  '));
      const old = readJsonIf(rc.paths.strip, { excludeGlobs: [], regex: [], traceAllow: [] });
      // The same preview as before freeze: the new rules must give a clean copy, and whatever they
      // remove that is not a review trace (and was not approved before) needs the owner's words.
      const pv = previewReviewCopy({ run: rc.run, strip: next, workDir: path.join(rc.paths.setupDir, `preview-${rngFor(rc, 'amend-preview').id(8)}`), templatesDir: rc.paths.templatesDir, rng: rngFor(rc, 'amend-preview-copy') });
      if (pv.problems.length) throw new UsageError('the new strip rules do not give a clean review copy:\n  ' + pv.problems.join('\n  '));
      const approved = new Set(
        readJsonIf(rc.paths.ownerDecisions, { decisions: [] }).decisions
          .filter((d) => d.kind === 'strip-narrowing' || (d.kind === 'amend' && d.set?.what === 'strip'))
          .flatMap((d) => d.narrowing || []),
      );
      // pv.narrowing also lists every traceAllow phrase: a new one needs the owner's words (r3-f1).
      for (const x of pv.narrowing) if (!approved.has(x)) narrowing.push(x);
      pending.push(() => writeJsonAtomic(rc.paths.stripPreview, { schemaVersion: 1, ...pv.summary, narrowingApproved: pv.narrowing }));
      diff.strip = { excludeAdded: added(old.excludeGlobs || [], next.excludeGlobs || []), regexAdded: added(old.regex || [], next.regex || []).length };
      pending.push(() => writeJsonAtomic(rc.paths.strip, next));
    } else if (opts.what === 'mechanical') {
      const next = readExecutorJson(file, 'the amend file');
      const old = readJsonIf(rc.paths.mechanical, { checks: [] });
      // The same shape check as before freeze (fields per kind, allowlist, a path or glob that matches
      // nothing in the material); a check kept exactly as frozen is not judged against today's material.
      const keptAsFrozen = new Set((next.checks || []).filter((n) => n && (old.checks || []).some((o) => JSON.stringify(o) === JSON.stringify(n))).map((n) => n.id));
      const shape = mechanicalFileProblems(rc, next, { skipMaterial: keptAsFrozen });
      if (shape.length) throw new UsageError(mechanicalRefusal(shape));
      narrowing.push(...mechanicalNarrowing(old, next, { allow: rc.run.allowExecutables ?? [] }));
      pending.push(() => writeJsonAtomic(rc.paths.mechanical, next));
    } else if (opts.what === 'lenses') {
      needQuote = true;
      const next = readExecutorJson(file, 'the amend file');
      const lensesJson = { schemaVersion: 1, taskSha256: sha256Hex(fs.readFileSync(rc.paths.task)), requirements: next.requirements, lenses: next.lenses };
      const man = buildManifest(rc.run, { countsFor: minimumCountSpecs(lensesJson) });
      const errors = validateLenses(lensesJson, { task: readText(rc.paths.task), manifest: man, sources: readJsonIf(rc.paths.sources, { sources: [] }), taxonomy: loadTaxonomy(), patterns: loadPatterns('prompt', { controlOnly: true }), generalist: !!rc.run.generalist, ownerLanguage: rc.run.language?.report ?? null });
      if (errors.length) throw new UsageError('the lenses are invalid:\n  ' + errors.join('\n  '));
      narrowing.push(...lensesNarrowing(readJsonIf(rc.paths.lenses, { lenses: [] }), lensesJson));
      diff.lenses = lensesJson.lenses.map((l) => l.id);
      if (!quote) throw new UsageError('changing the lenses needs --owner-quote with the owner\'s words and --question with the exact question you asked him');
      pending.push(() => writeJsonAtomic(rc.paths.lenses, lensesJson));
    } else if (opts.what === 'material') {
      const next = readExecutorJson(file, 'the amend file');
      const oldM = rc.run.material;
      const newRoots = next.roots || [];
      if (!newRoots.length) throw new UsageError('material needs at least one root');
      for (const r of oldM.roots) {
        const n = newRoots.find((x) => normalizeInput(x.path) === normalizeInput(r.path) && x.as === r.as);
        if (!n) {
          narrowing.push(`root ${r.as} (${r.path}) removed or renamed`);
          continue;
        }
        for (const g of removed(r.include || [], n.include || [])) narrowing.push(`root ${r.as}: include glob ${g} removed`);
        for (const g of added(r.exclude || [], n.exclude || [])) narrowing.push(`root ${r.as}: exclude glob ${g} added`);
      }
      // authorNotes is the only executor-to-reviewer channel inside the material: removing a note
      // takes the "unverified claims" banner off a file, so it narrows like a removed root. The
      // reading order decides where reviewers start and where canaries fall: a change needs the quote too.
      const normNote = (x) => String(x).split('\\').join('/').toLowerCase();
      const newNotes = new Set((next.authorNotes || []).map(normNote));
      for (const n of oldM.authorNotes || []) if (!newNotes.has(normNote(n))) narrowing.push(`author note ${n} removed (its file loses the "unverified claims" banner)`);
      if (JSON.stringify(oldM.readingOrder || []) !== JSON.stringify(next.readingOrder || [])) narrowing.push('reading order changed');
      const runJson = readJson(rc.paths.runJson);
      runJson.material = { ...next, roots: newRoots.map((x) => ({ ...x, path: normalizeInput(x.path) })) };
      const errors = validateRun(applyDefaults(runJson), { legacyQuestions: true });
      if (errors.length) throw new UsageError('the material settings are invalid:\n  ' + errors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n  '));
      diff.material = {
        roots: runJson.material.roots.map((r) => `${r.as}=${r.path}`),
        authorNotes: [...(runJson.material.authorNotes || [])],
        readingOrder: [...(runJson.material.readingOrder || [])],
      };
      if (narrowing.length && !quote) throw new UsageError(`these changes narrow what is reviewed and need --owner-quote and --question (the exact question you asked him):\n  ${narrowing.join('\n  ')}`);
      pending.push(() => writeJsonAtomic(rc.paths.runJson, runJson));
    } else if (opts.what === 'task') {
      needQuote = true;
      if (!quote) throw new UsageError("changing the task needs --owner-quote with the owner's words and --question with the exact question you asked him");
      const built = buildTask(readText(file), { cut: opts.cut, source: opts.source });
      if (built.hits.length) throw new UsageError('TASK.md would carry forbidden words: ' + built.hits.map((h) => `line ${h.ownerLine}: "${h.text}"`).join('; '));
      const lenses = readJsonIf(rc.paths.lenses, { requirements: [] });
      const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
      const newTask = norm(built.taskText);
      const lost = (lenses.requirements || []).filter((r) => !newTask.includes(norm(r.taskQuote)));
      if (lost.length) throw new UsageError(`the new task no longer contains the words of requirements ${lost.map((r) => r.id).join(', ')}; start a new run for a different task`);
      pending.push(() => writeTextAtomic(rc.paths.ownerTask, built.ownerText));
      pending.push(() => writeTextAtomic(rc.paths.task, built.taskText));
      diff.task = { cut: built.cut };
      // keep lenses.json bound to the task
      pending.push(() => {
        const lj = readJson(rc.paths.lenses);
        lj.taskSha256 = sha256Hex(fs.readFileSync(rc.paths.task));
        writeJsonAtomic(rc.paths.lenses, lj);
      });
    }

    if ((needQuote || narrowing.length) && !quote) {
      throw new UsageError(`these changes narrow what is reviewed and need --owner-quote with the owner's words and --question with the exact question you asked him:\n  ${narrowing.join('\n  ')}${movingHints.length ? `\nSources that read a moving target (rewrite them to a pinned form, or keep them on the owner's words):\n  ${movingHints.join('\n  ')}` : ''}`);
    }
    for (const w of pending) w();
    const frozen = writeFrozen(rc.runDir, { repoDir: rc.ctx.repoDir });
    rc.frozen = frozen;
    const data = {
      what: opts.what,
      reason: opts.reason,
      narrowing,
      diff,
      ownerQuote: quote,
      frozenSha256: hashJson(frozen),
      instrumentId: frozen.instrumentId,
    };
    if (opts.what === 'task') {
      data.taskSha256 = sha256Hex(fs.readFileSync(rc.paths.task));
      data.ownerTaskSha256 = sha256Hex(fs.readFileSync(rc.paths.ownerTask));
    }
    if (quote) {
      const od = readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] });
      od.decisions.push({ id: `O${od.decisions.length + 1}`, ts: now(), kind: 'amend', set: { what: opts.what }, quote, question: words?.question ?? null, narrowing });
      writeJsonAtomic(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: od.decisions });
    }
    commitState(rc, { candidate: null }, 'amend', data, rc.state.round ?? null);
    return {
      exitCode: 0,
      state: rc.state.state,
      payload: { what: opts.what, narrowing, instrumentId: frozen.instrumentId },
      text: `Amended ${opts.what}${narrowing.length ? ` (narrowing, on the owner's words: ${narrowing.join('; ')})` : ''}. The candidate (if any) was cleared; settings are frozen again.\nNEXT: run step`,
    };
  });
}
