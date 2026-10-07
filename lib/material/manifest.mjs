// Material manifests (SPEC 9.3).
//
// A manifest lists every material file under its copy-relative POSIX path "<as>/<rel>",
// with sha256 (text/json/html hashed after BOM strip + CRLF->LF, others raw), size and kind.
// versionHash = treeHash([[rel, sha256], ...]). The same rules hash the live roots, a snapshot
// and a review copy, so a snapshot of unchanged live files has the live versionHash.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { fileKind, hashFile, treeHash } from '../core/hash.mjs';
import { listFiles, listSkippedLinks, readText, mtimeMs } from '../core/fsx.mjs';
import { matchGlob, selectFiles } from '../core/glob.mjs';
import { nowDate } from '../core/clock.mjs';

export const RECENT_MS = 24 * 60 * 60 * 1000;
const TEXT_KINDS = new Set(['text', 'json', 'html']);

function absOf(dir, rel) {
  return path.join(dir, ...rel.split('/'));
}

function fileEntry(abs, rel) {
  const kind = fileKind(rel);
  return { rel, sha256: hashFile(abs, kind), bytes: fs.statSync(abs).size, kind };
}

function finish(files, counts = {}, unlistedRecent = []) {
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    schemaVersion: 1,
    versionHash: treeHash(files.map((f) => [f.rel, f.sha256])),
    files,
    counts,
    unlistedRecent,
  };
}

/**
 * The material files of the live roots: [{ root, as, relInRoot, rel, abs }] (sorted by rel).
 * Globs (include/exclude) are matched against the path relative to the root.
 */
export function selectLiveFiles(run) {
  const roots = run?.material?.roots;
  if (!Array.isArray(roots) || roots.length === 0) throw new UsageError('run.json material.roots is empty');
  const out = [];
  const seenAs = new Set();
  for (const root of roots) {
    if (!root || typeof root.path !== 'string' || typeof root.as !== 'string') {
      throw new UsageError('every material root needs "path" and "as"');
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(root.as)) throw new UsageError(`bad root name (as): ${root.as}`);
    if (seenAs.has(root.as)) throw new UsageError(`duplicate root name (as): ${root.as}`);
    seenAs.add(root.as);
    if (!fs.existsSync(root.path) || !fs.statSync(root.path).isDirectory()) {
      throw new UsageError(`material root does not exist or is not a folder: ${root.path}`);
    }
    const all = listFiles(root.path);
    const picked = selectFiles(all, root.include ?? ['**/*'], root.exclude ?? []);
    for (const relInRoot of picked) {
      out.push({ root, as: root.as, relInRoot, rel: `${root.as}/${relInRoot}`, abs: absOf(root.path, relInRoot) });
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * Folder links, junctions and broken links inside the material roots that the include globs would
 * reach and the exclude globs do not drop: their files are never snapshotted or reviewed.
 * -> ["<as>/<rel>"]
 */
export function skippedLinksOf(run) {
  const out = [];
  for (const root of run?.material?.roots || []) {
    if (!root?.path || !fs.existsSync(root.path)) continue;
    for (const rel of listSkippedLinks(root.path)) {
      const probe = `${rel}/x`;
      const included = (root.include ?? ['**/*']).some((g) => matchGlob(probe, g) || matchGlob(rel, g));
      const excluded = (root.exclude ?? []).some((g) => matchGlob(probe, g) || matchGlob(rel, g));
      if (included && !excluded) out.push(`${root.as}/${rel}`);
    }
  }
  return out.sort();
}

/** Files modified in the last 24 h inside a root's folder but not selected by its globs (abs paths). */
export function unlistedRecentOf(run, selected, nowMs = nowDate().getTime()) {
  const picked = new Set(selected.map((s) => s.abs));
  const out = [];
  for (const root of run.material.roots) {
    for (const relInRoot of listFiles(root.path)) {
      const abs = absOf(root.path, relInRoot);
      if (picked.has(abs)) continue;
      const m = mtimeMs(abs);
      if (m !== null && nowMs - m <= RECENT_MS && m <= nowMs + 60_000) out.push(abs);
    }
  }
  return out.sort();
}

/** Count key used in manifest.counts: "<glob>" or "<glob>#<pointer>". */
export function countKey({ glob, pointer }) {
  return pointer ? `${glob}#${pointer}` : glob;
}

/** Resolve a JSON Pointer (RFC 6901). Returns undefined when it does not resolve. */
export function resolvePointer(value, pointer) {
  if (pointer === '' || pointer === undefined || pointer === null) return value;
  if (!String(pointer).startsWith('/')) return undefined;
  let cur = value;
  for (const raw of String(pointer).slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = cur[key];
    } else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Length of the array at `pointer` in a JSON file, or null when the file or pointer does not give an array. */
export function arrayLengthAt(abs, pointer) {
  let data;
  try {
    data = JSON.parse(readText(abs));
  } catch {
    return null;
  }
  const v = resolvePointer(data, pointer);
  return Array.isArray(v) ? v.length : null;
}

function countOverRels(dir, rels, { glob, pointer }) {
  const matched = rels.filter((r) => matchGlob(r, glob));
  if (!pointer) return matched.length;
  let n = 0;
  for (const r of matched) n += arrayLengthAt(absOf(dir, r), pointer) ?? 0;
  return n;
}

/**
 * countFor(dir, { glob, pointer? }) -> n
 * Without a pointer: number of files under dir matching glob (copy-relative paths).
 * With a pointer: sum of the lengths of the arrays at that pointer over the matching JSON files
 * (a file where the pointer does not give an array adds 0).
 */
export function countFor(dir, spec) {
  if (!spec || typeof spec.glob !== 'string') throw new UsageError('countFor needs { glob, pointer? }');
  return countOverRels(dir, listFiles(dir), spec);
}

function countsFromLive(selected, countsFor) {
  const counts = {};
  const rels = selected.map((s) => s.rel);
  const byRel = new Map(selected.map((s) => [s.rel, s.abs]));
  for (const spec of countsFor ?? []) {
    const matched = rels.filter((r) => matchGlob(r, spec.glob));
    let n = matched.length;
    if (spec.pointer) {
      n = 0;
      for (const r of matched) n += arrayLengthAt(byRel.get(r), spec.pointer) ?? 0;
    }
    counts[countKey(spec)] = n;
  }
  return counts;
}

/**
 * buildManifest(run, { countsFor: [{ glob, pointer? }], nowMs? }) -> manifest (9.3), from the live roots.
 */
export function buildManifest(run, opts = {}) {
  const selected = selectLiveFiles(run);
  const files = selected.map((s) => fileEntry(s.abs, s.rel));
  return finish(files, countsFromLive(selected, opts.countsFor), unlistedRecentOf(run, selected, opts.nowMs));
}

/**
 * manifestOfDir(dir, { countsFor? }) -> manifest of a snapshot or a copy (rel = "<as>/..." as stored).
 * unlistedRecent is always empty here.
 */
export function manifestOfDir(dir, opts = {}) {
  const rels = listFiles(dir);
  const files = rels.map((rel) => fileEntry(absOf(dir, rel), rel));
  const counts = {};
  for (const spec of opts.countsFor ?? []) counts[countKey(spec)] = countOverRels(dir, rels, spec);
  return finish(files, counts, []);
}

/** Text/json/html files in reading order: files matching readingOrder globs first (glob by glob), then path order. */
export function readingOrderFiles(rels, readingOrder = []) {
  const textRels = rels.filter((r) => TEXT_KINDS.has(fileKind(r))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const order = [];
  for (const g of readingOrder ?? []) for (const r of textRels) if (!order.includes(r) && matchGlob(r, g)) order.push(r);
  for (const r of textRels) if (!order.includes(r)) order.push(r);
  return order;
}

/**
 * positionIndex(dir, readingOrder) -> { totalChars, files: [{ rel, start, chars }], offsetOf(rel, charIndex) -> fraction|null }
 * Character offsets count the BOM-stripped text of each text/json/html file as stored (line endings kept),
 * concatenated in reading order. offsetOf returns null for a file that is not in the index.
 */
export function positionIndex(dir, readingOrder = []) {
  const order = readingOrderFiles(listFiles(dir), readingOrder);
  const files = [];
  let total = 0;
  for (const rel of order) {
    const chars = readText(absOf(dir, rel)).length;
    files.push({ rel, start: total, chars });
    total += chars;
  }
  const byRel = new Map(files.map((f) => [f.rel, f]));
  return {
    totalChars: total,
    files,
    offsetOf(rel, charIndex) {
      const f = byRel.get(String(rel).replace(/\\/g, '/'));
      if (!f || total === 0) return null;
      const i = Math.max(0, Math.min(Number(charIndex) || 0, f.chars));
      return (f.start + i) / total;
    },
  };
}
