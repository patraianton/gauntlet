// Strip preview (SPEC 9.5, failure points 8 and 15): what strip.json and run.rebuild do to the
// copy reviewers will read, computed BEFORE freeze (and before an amend of strip.json), on a
// throw-away snapshot and copy that are deleted again.
//
// It returns:
//   problems   a regex that does not compile, a violated `expect`, a JSON file broken by a rule,
//              a review trace left in the copy, a failed rebuild, or a rebuild whose output differs
//              from the material although strip changed none of the rebuild sources. Any problem
//              refuses the freeze (exit 20 with the list) — the same checks that would otherwise
//              surface only as BLOCKED_TRACE after freeze.
//   narrowing  what strip removes or rewrites that is NOT a review trace: an excluded file whose
//              path and content carry no trace, a regex match without a trace in it, a replacement
//              that writes new text, a match longer than MAX_MATCH_CHARS. Narrowing needs the
//              owner's quoted words (step --owner-quote at setup, amend --owner-quote later).
//              Every traceAllow phrase is narrowing too (it lets a trace-like word through to
//              reviewers), so each one needs the owner's words, before freeze as well (r3-f1).
//   summary    excluded files (with "trace" / "no trace"), every regex rule with its match count,
//              every traceAllow phrase with its match count, and the rebuild command — listed in
//              SETUP-SUMMARY.ru.md and the owner report.

import path from 'node:path';
import { fileKind } from '../core/hash.mjs';
import { listFiles, readRaw, safeRemove, ensureDir } from '../core/fsx.mjs';
import { matchGlob } from '../core/glob.mjs';
import { makeRng } from '../core/rand.mjs';
import { takeSnapshot } from '../material/snapshot.mjs';
import { makeReviewCopy } from '../material/copy.mjs';
import { decodeKeepBom } from '../material/strip.mjs';
import { traceAdvice } from '../material/trace-advice.mjs';
import { loadPatterns, lintPath, compileAllow, scanTrace, scanString, allowMatchCounts, MAX_NOTES_CHARS } from '../material/lint.mjs';

export const MAX_MATCH_CHARS = 600;
const TEXT_KINDS = new Set(['text', 'json', 'html']);

function regexFlags(flags) {
  const set = new Set(String(flags ?? '').split('').filter(Boolean));
  set.add('g');
  return [...set].join('');
}

function hasTrace(text, patterns, allowRes) {
  return scanString(text, patterns, allowRes, ['both', 'content']).length > 0;
}

function filesOf(dir) {
  return listFiles(dir);
}

function readTextOf(dir, rel) {
  return decodeKeepBom(readRaw(path.join(dir, ...rel.split('/')))).text;
}

/** The narrowing line of one traceAllow entry; stable (no counts), so an approval is found again. */
export function allowNarrowingLine(a) {
  return `trace allow "${a.phrase}" lets this phrase through to reviewers (why: ${a.why})`;
}

/**
 * Trace-aware narrowing of a strip.json over a snapshot folder (laid out as <as>/<rel>).
 * Pure apart from reading the snapshot. -> { narrowing: [string], excluded: [...], rules: [...], allow: [...], traceCoverage }
 * traceCoverage: which data files the trace scan read with every pattern and which with a reduced set (scanTrace stats).
 */
export function stripNarrowing(snapshotDir, strip, { patterns = loadPatterns('trace') } = {}) {
  const s = strip ?? {};
  const allow = s.traceAllow ?? [];
  const allowRes = compileAllow(allow);
  const narrowing = allow.map(allowNarrowingLine);
  const allowCounts = allowMatchCounts(snapshotDir, allow);
  const excluded = [];
  const all = filesOf(snapshotDir);
  const traceCoverage = {};
  const traceFiles = new Set(scanTrace(snapshotDir, patterns, allow, { stats: traceCoverage }).map((h) => h.file));
  for (const rel of all) {
    const i = (s.excludeGlobs ?? []).findIndex((g) => matchGlob(rel, g));
    if (i < 0) continue;
    // A text file counts as a review trace only by its content: a file merely named like review
    // notes ("…-FEEDBACK.md") but holding plain material must not vanish whole (r2-f40). Other kinds
    // (images, binaries) can only be judged by their path.
    const trace = traceFiles.has(rel) || (!TEXT_KINDS.has(fileKind(rel)) && lintPath(rel, patterns, allow).length > 0);
    excluded.push({ file: rel, glob: s.excludeGlobs[i], trace });
    if (!trace) narrowing.push(`exclude glob ${s.excludeGlobs[i]} drops ${rel}, which carries no review trace`);
  }
  const kept = all.filter((rel) => !excluded.some((e) => e.file === rel));
  const rules = [];
  (s.regex ?? []).forEach((rule, i) => {
    const info = { index: i, glob: rule.glob, pattern: rule.pattern, replace: rule.replace ?? '', why: rule.why ?? '', matches: 0, files: [], nonTrace: 0 };
    rules.push(info);
    let re;
    try {
      re = new RegExp(rule.pattern, regexFlags(rule.flags));
    } catch {
      return; // reported as a problem by the copy itself
    }
    const replacement = String(rule.replace ?? '');
    if (replacement.trim() !== '') narrowing.push(`strip rule ${i} (/${rule.pattern}/ on ${rule.glob}) writes new text ("${replacement.slice(0, 60)}"); a strip rule may only delete review traces`);
    for (const rel of kept) {
      if (!TEXT_KINDS.has(fileKind(rel))) continue;
      if (!matchGlob(rel, rule.glob ?? '**/*')) continue;
      const text = readTextOf(snapshotDir, rel);
      let n = 0;
      for (const m of text.matchAll(re)) {
        n++;
        const t = m[0];
        if (t.length > MAX_MATCH_CHARS) {
          info.nonTrace++;
          narrowing.push(`strip rule ${i} (/${rule.pattern}/) removes ${t.length} characters at once in ${rel}; a strip rule may delete at most ${MAX_MATCH_CHARS} characters per match`);
        } else if (!hasTrace(t, patterns, allowRes)) {
          info.nonTrace++;
          narrowing.push(`strip rule ${i} (/${rule.pattern}/) changes text in ${rel} that carries no review trace: "${t.replace(/\s+/g, ' ').slice(0, 80)}"`);
        }
      }
      if (n) {
        info.matches += n;
        info.files.push(rel);
      }
    }
  });
  return { narrowing, excluded, rules, allow: allowCounts, traceCoverage };
}

function hashOutputs(dir, globs) {
  const out = new Map();
  for (const rel of listFiles(dir)) {
    if (!(globs || []).some((g) => matchGlob(rel, g))) continue;
    out.set(rel, readRaw(path.join(dir, ...rel.split('/'))).toString('base64'));
  }
  return out;
}

/**
 * rebuildOutputsCheck({ run, nar, snapDir, copyDir }) -> { differs: [rel], stripTouchedSources } or null
 * (no rebuild). Output files of the rebuilt copy that differ from the snapshot; a difference is a
 * problem only when strip changed none of the rebuild sources (reviewers would see another build
 * than the one delivered). Used by the setup preview and again on every round's copy (r2-f43).
 */
export function rebuildOutputsCheck({ run, nar, snapDir, copyDir }) {
  const rb = run.rebuild;
  if (!rb) return null;
  const srcGlobs = rb.sourcesGlob || [];
  const stripTouchedSources = nar.excluded.some((e) => srcGlobs.some((g) => matchGlob(e.file, g))) || nar.rules.some((r) => r.files.some((f) => srcGlobs.some((g) => matchGlob(f, g))));
  const want = hashOutputs(snapDir, rb.outputsGlob);
  const have = hashOutputs(copyDir, rb.outputsGlob);
  const differs = [];
  for (const [rel, h] of have) if (want.has(rel) && want.get(rel) !== h) differs.push(rel);
  for (const rel of want.keys()) if (!have.has(rel)) differs.push(rel);
  return { differs: differs.sort(), stripTouchedSources };
}

/**
 * previewReviewCopy({ run, strip, workDir, templatesDir, rng? }) ->
 *   { problems, narrowing, summary: { excluded, rules, allow, rebuild } }
 * Builds a snapshot under workDir and a review copy under run.reviewBase, inspects them, and
 * deletes both before returning.
 */
export function previewReviewCopy({ run, strip, workDir, templatesDir, rng = makeRng() }) {
  const patterns = loadPatterns('trace');
  const snap = path.join(workDir, 'snapshot');
  ensureDir(workDir);
  let copy = null;
  try {
    takeSnapshot(run, snap, { countsFor: [] });
    const nar = stripNarrowing(snap, strip, { patterns });
    copy = makeReviewCopy({ run, strip, snapshotDir: snap, reviewBase: run.reviewBase, rng, patterns, templatesDir });
    const problems = [];
    for (const v of copy.stripViolations || []) problems.push(`Strip rule ${v.rule} expected ${v.expect} but matched ${v.matches}${v.why ? ` (${v.why})` : ''}${v.error ? `: ${v.error}` : ''}.`);
    for (const h of copy.notesHits || []) problems.push(`Author notes ${h.file}${h.line ? ` line ${h.line}` : ''}: "${h.text}" (${h.patternId}). Notes may only point reviewers to where things are; claims of intent, of fixes or checks, and of what is not an error are refused, and a notes file may hold at most ${MAX_NOTES_CHARS} characters. Edit the notes file.`);
    for (const h of copy.traceHits || []) problems.push(`Review trace left in ${h.file || 'the copy path'}${h.line ? ` line ${h.line}` : ''}: "${h.text}" (${h.patternId}). Read what to do at the end of this list before you touch anything.`);
    problems.push(...traceAdvice(copy.traceHits || [], { patterns }));
    let rebuild = null;
    if (run.rebuild) {
      const rb = run.rebuild;
      rebuild = { cmd: [rb.cmd, ...(rb.args || [])].join(' '), exitCode: copy.rebuild?.exitCode ?? null, changedOutputs: copy.rebuild?.outputs || [], differsFromMaterial: [] };
      if (copy.rebuild && copy.rebuild.exitCode !== 0) problems.push(`The rebuild of the copy failed (exit ${copy.rebuild.exitCode}): ${String(copy.rebuild.stderrTail || copy.rebuild.error || '').slice(-400)}`);
      else {
        const { differs, stripTouchedSources } = rebuildOutputsCheck({ run, nar, snapDir: snap, copyDir: copy.copyDir });
        rebuild.differsFromMaterial = differs;
        rebuild.stripTouchedSources = stripTouchedSources;
        if (differs.length && !stripTouchedSources) {
          problems.push(`The rebuild on the review copy gives output files that differ from the material although strip changed none of the rebuild sources: ${differs.slice(0, 10).join(', ')}. Reviewers would see a different build than the one delivered.`);
        }
      }
    }
    return { problems, narrowing: nar.narrowing, summary: { excluded: nar.excluded, rules: nar.rules, allow: nar.allow, traceCoverage: nar.traceCoverage, rebuild } };
  } finally {
    if (copy?.copyDir) safeRemove(copy.copyDir);
    safeRemove(workDir);
  }
}
