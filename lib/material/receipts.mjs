// Read receipts (SPEC 9.8, 15.4, D12).
//
// Each reviewer job gets 3 challenges drawn with a generator the caller seeds from the round seed
// and the job id: `line` ("copy line N of <file> exactly") and `count` ("how many files match
// <glob>" / "how many entries are in <pointer> of <file>"). Expected line answers are stored only
// as sha256(normalizeLine(line)); the pass rule (2 of 3) is applied by the engine (12.2).

import path from 'node:path';
import { fileKind, sha256Hex } from '../core/hash.mjs';
import { listFiles, readText } from '../core/fsx.mjs';
import { matchGlob } from '../core/glob.mjs';
import { normalizeLine } from './lint.mjs';
import { arrayLengthAt, countFor } from './manifest.mjs';

export const LINE_MIN = 8;
export const LINE_MAX = 300;
const TEXT_KINDS = new Set(['text', 'json', 'html']);

function absOf(dir, rel) {
  return path.join(dir, ...rel.split('/'));
}

/** Escape glob metacharacters so a file path can be used as a glob that matches only itself. */
export function literalGlob(rel) {
  return String(rel).replace(/[*?[\]{}]/g, (c) => `[${c}]`);
}

/** Lines of a copy file eligible for a line challenge: [{ line (1-based), text }]. */
export function eligibleLines(abs) {
  const lines = readText(abs).split(/\r?\n/);
  const out = [];
  lines.forEach((t, i) => {
    const n = normalizeLine(t);
    if (n.length >= LINE_MIN && t.length <= LINE_MAX) out.push({ line: i + 1, text: t });
  });
  return out;
}

function minimumGlobs(lens) {
  return (lens?.minimum ?? []).filter((m) => typeof m.glob === 'string' && m.glob !== '');
}

/**
 * makeChallenges({ copyDir, lens, manifest?, rng, n = 3 }) -> [challenge]
 *   { id: "Q1", kind: "line", file, line, expectedSha256 } | { id: "Q2", kind: "count", glob, pointer?, expected }
 * Line files: text/json/html copy files matched by the lens's minimum globs ("all-files" minimums first).
 * Count questions: the lens's minimum globs, and glob#pointer as "entries at <pointer> of <one file>".
 * At least one line challenge when a line file exists; all count otherwise. Fewer than n challenges are
 * returned only when the lens's globs give nothing to ask about. `manifest` is accepted for the
 * contract but counts and lines are always read from the copy (the copy is what the reviewer sees).
 * `sample` (Map rel -> [{ line, text }]) lists the receipt lines of large data files that are reviewed
 * through a sample: such a file is never read whole here, its lines come from the sampled rows only,
 * and no "entries at <pointer>" count is asked about it (a reviewer who reads the sample cannot count).
 */
export function makeChallenges({ copyDir, lens, rng, n = 3, sample = null }) {
  const rels = listFiles(copyDir);
  const mins = minimumGlobs(lens);

  // line candidates: files of all-files minimums first, then other minimums
  const primary = [];
  const secondary = [];
  for (const m of mins) {
    for (const r of rels) {
      if (!TEXT_KINDS.has(fileKind(r)) || !matchGlob(r, m.glob)) continue;
      const bucket = m.kind === 'all-files' ? primary : secondary;
      if (!primary.includes(r) && !bucket.includes(r)) bucket.push(r);
    }
  }
  const lineFiles = [...primary, ...secondary.filter((r) => !primary.includes(r))]
    .map((r) => ({ rel: r, lines: sample && sample.has(r) ? sample.get(r) : eligibleLines(absOf(copyDir, r)) }))
    .filter((f) => f.lines.length > 0);

  // count candidates
  const countCands = [];
  for (const m of mins) {
    if (m.pointer) {
      const files = rels.filter((r) => fileKind(r) === 'json' && matchGlob(r, m.glob) && !(sample && sample.has(r)));
      for (const r of files) {
        const len = arrayLengthAt(absOf(copyDir, r), m.pointer);
        if (len !== null) countCands.push({ glob: literalGlob(r), pointer: m.pointer, file: r });
      }
    } else if (!countCands.some((c) => !c.pointer && c.glob === m.glob)) {
      countCands.push({ glob: m.glob });
    }
  }

  let nLine;
  if (lineFiles.length === 0) nLine = 0;
  else if (countCands.length === 0) nLine = n;
  else nLine = Math.max(1, n - 1);
  let nCount = n - nLine;
  if (nCount > countCands.length) {
    nLine = lineFiles.length ? n - countCands.length : 0;
    nCount = countCands.length;
  }

  const challenges = [];
  // line challenges: distinct files when possible, distinct lines always
  const used = new Set();
  const fileOrder = rng.shuffle(lineFiles.map((_, i) => i));
  for (let k = 0; k < nLine; k++) {
    let picked = null;
    for (let tries = 0; tries < fileOrder.length * 2 && !picked; tries++) {
      const f = lineFiles[fileOrder[(k + tries) % fileOrder.length]];
      const free = f.lines.filter((l) => !used.has(`${f.rel}#${l.line}`));
      if (free.length === 0) continue;
      const l = rng.pick(free);
      picked = { f, l };
    }
    if (!picked) break;
    used.add(`${picked.f.rel}#${picked.l.line}`);
    challenges.push({
      kind: 'line',
      file: picked.f.rel,
      line: picked.l.line,
      expectedSha256: sha256Hex(normalizeLine(picked.l.text)),
    });
  }
  const counts = rng.shuffle(countCands).slice(0, nCount);
  for (const c of counts) {
    const ch = { kind: 'count', glob: c.glob, expected: countFor(copyDir, { glob: c.glob, pointer: c.pointer }) };
    if (c.pointer) ch.pointer = c.pointer;
    challenges.push(ch);
  }
  return rng.shuffle(challenges).map((c, i) => ({ id: `Q${i + 1}`, ...c }));
}

/** The question text of one challenge (no expected answer in it). */
export function challengeQuestion(c) {
  if (c.kind === 'line') return `Copy line ${c.line} of ${c.file} exactly (the whole line as it is stored in the file).`;
  if (c.pointer) return `How many entries are in the JSON array at ${c.pointer} of ${c.glob.replace(/\[(.)\]/g, '$1')}? Answer with the number only.`;
  return `How many files match ${c.glob} (paths relative to the material folder)? Answer with the number only.`;
}

/** renderChallenges(challenges) -> markdown list for the prompt. */
export function renderChallenges(challenges) {
  if (!challenges || challenges.length === 0) return '(no read checks for this task)';
  return challenges.map((c) => `- ${c.id}. ${challengeQuestion(c)}`).join('\n');
}

function parseCount(answer) {
  if (typeof answer === 'number') return Number.isInteger(answer) ? answer : null;
  const s = String(answer ?? '').trim();
  const ints = s.match(/-?\d+/g);
  if (!ints || ints.length !== 1) return null;
  if (/\d[.,]\d/.test(s)) return null;
  return Number(ints[0]);
}

/**
 * checkReceipts(challenges, receipt[]) -> { correct, total, results: [{ id, ok }] }
 * line: sha256(normalizeLine(answer)) == expectedSha256; count: the single integer in the answer equals.
 * A missing or duplicated answer for an id counts as wrong.
 */
export function checkReceipts(challenges, receipt) {
  const list = Array.isArray(receipt) ? receipt : [];
  const results = [];
  for (const c of challenges ?? []) {
    const answers = list.filter((r) => r && r.id === c.id);
    let ok = false;
    if (answers.length === 1) {
      const a = answers[0].answer;
      if (c.kind === 'line') ok = typeof a === 'string' && sha256Hex(normalizeLine(a)) === c.expectedSha256;
      else if (c.kind === 'count') ok = parseCount(a) === c.expected;
    }
    results.push({ id: c.id, ok });
  }
  return { correct: results.filter((r) => r.ok).length, total: results.length, results };
}
