// Review copy (SPEC 7, 11.2 step 6, D26).
//
// makeReviewCopy builds <reviewBase>/<8 neutral chars>/<as>/<rel> from the round snapshot, then:
//   1. strip (excludeGlobs, then regex rules with expect checks)            -> strip.mjs
//   2. lints the contents of each run.material.authorNotes file (prompt lint of executor text and a
//      length cap, r3-f2: hits are returned as notesHits and block the copy like trace hits), then
//      prepends the bilingual author-notes banner to it
//   3. runs run.rebuild (if set) on the copy with {copy}/{snapshot} substituted and strip.rebuildEnv added
//   4. trace-scans the contents and every path component, minus strip.traceAllow
// It does NOT delete the copy when there are trace hits or strip violations: the caller turns them
// into BLOCKED_TRACE and removes the copy with safeRemove (it needs the hit list for the to-do).

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { fileKind } from '../core/hash.mjs';
import { copyFiles, listFiles, readRaw, readText, writeRaw } from '../core/fsx.mjs';
import { matchGlob } from '../core/glob.mjs';
import { NEUTRAL_ALPHABET } from '../core/rand.mjs';
import { runAllowed } from '../core/proc.mjs';
import { applyStrip, decodeKeepBom, encodeKeepBom } from './strip.mjs';
import { scanTrace, scanPaths, lintPath, loadPatterns, notesProblems } from './lint.mjs';
import { manifestOfDir } from './manifest.mjs';

export const BANNER_TEMPLATE = 'author-notes-banner.md';
const MAX_NAME_TRIES = 100;
const DEFAULT_REBUILD_TIMEOUT_S = 600;

/** A fresh neutral folder name under base: 8 chars of NEUTRAL_ALPHABET, no trace hit, not existing. */
export function neutralName(base, rng, patterns, len = 8) {
  for (let i = 0; i < MAX_NAME_TRIES; i++) {
    const name = rng.id(len, NEUTRAL_ALPHABET);
    if (lintPath(name, patterns).length > 0) continue;
    if (fs.existsSync(path.join(base, name))) continue;
    return name;
  }
  throw new UsageError(`could not find a free neutral folder name under ${base}`);
}

/** Tree hash of a copy (same rules as a manifest). Used before and after reviewers to detect writes. */
export function copyTreeHash(copyDir) {
  return manifestOfDir(copyDir).versionHash;
}

/**
 * copyListing(copyDir) -> { treeHash, files: [{ rel, sha256, bytes, mtimeMs }] }
 * The tree hash of copyTreeHash plus, for every file, what is needed to say afterwards which file
 * changed: its hash, its size and its modification time. The listing of the planted copy is kept
 * (sealed) while reviewers work; if the hash then differs, diffListings names the files.
 */
export function copyListing(copyDir) {
  const m = manifestOfDir(copyDir);
  const files = m.files.map((f) => {
    let mtimeMs = null;
    try {
      mtimeMs = Math.round(fs.statSync(path.join(copyDir, ...f.rel.split('/'))).mtimeMs);
    } catch {
      /* the file went away between the two calls: no time */
    }
    return { rel: f.rel, sha256: f.sha256, bytes: f.bytes, mtimeMs };
  });
  return { treeHash: m.versionHash, files };
}

/**
 * diffListings(before, after) -> { added: [{rel, bytes, mtimeMs}], changed: [{rel, bytesBefore, bytes, mtimeMs}],
 *   removed: [{rel, bytesBefore, mtimeMsBefore}] }, each sorted by path.
 * "changed" is a different content hash (the same one the tree hash uses: BOM and line endings of
 * text files do not count). Either side may be null (a copy folder that is gone): then nothing
 * is known about that side and the result lists everything as removed or added.
 */
export function diffListings(before, after) {
  const b = new Map((before?.files ?? []).map((f) => [f.rel, f]));
  const a = new Map((after?.files ?? []).map((f) => [f.rel, f]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, f] of a) {
    const old = b.get(rel);
    if (!old) added.push({ rel, bytes: f.bytes, mtimeMs: f.mtimeMs });
    else if (old.sha256 !== f.sha256) changed.push({ rel, bytesBefore: old.bytes, bytes: f.bytes, mtimeMs: f.mtimeMs });
  }
  for (const [rel, f] of b) if (!a.has(rel)) removed.push({ rel, bytesBefore: f.bytes, mtimeMsBefore: f.mtimeMs });
  const byRel = (x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0);
  return { added: added.sort(byRel), changed: changed.sort(byRel), removed: removed.sort(byRel) };
}

/**
 * Scratch that a tool writes by itself when a reviewer runs a script, not a file anyone made on
 * purpose: Python byte-code (__pycache__/*.pyc) and the pytest cache (.pytest_cache/...). Only ADDED
 * files at such a place are tolerated (the engine removes them and the copy is the planted one again).
 * Nothing else is: a helper script, a parsed extract or a note left in the copy may have been read
 * by another reviewer, and a changed or removed existing file changes what was reviewed.
 *
 * The tolerance is narrow on purpose (a free-form file at such a path could carry a note from one
 * reviewer to another, and the engine would delete it unseen): the pytest cache accepts only the
 * layout pytest itself writes, and byte-code only when it looks like byte-code.
 */
export const SCRATCH_DIRS = Object.freeze(['__pycache__', '.pytest_cache']);

/** Files pytest writes under .pytest_cache (copy-relative to that folder) and how each must look. */
const PYTEST_CACHE_FILES = Object.freeze({
  'README.md': { prefix: '# pytest cache directory #', maxBytes: 4096 },
  '.gitignore': { prefix: '# Created by pytest automatically.', maxBytes: 4096 },
  'CACHEDIR.TAG': { prefix: 'Signature: 8a477f597d28d172789f06886806bc55', maxBytes: 4096 },
  'v/cache/lastfailed': { json: true, maxBytes: 1048576 },
  'v/cache/nodeids': { json: true, maxBytes: 1048576 },
  'v/cache/stepwise': { json: true, maxBytes: 1048576 },
});

/** True when the first 16 bytes look like a CPython byte-code header (magic ending in CR LF, flags word 0..3). */
function looksLikePycHeader(buf) {
  return buf.length >= 16 && buf[2] === 0x0d && buf[3] === 0x0a && buf.readUInt32LE(4) < 4;
}

/**
 * isScratchPath(rel, copyDir?) -> true when rel (copy-relative POSIX path) is tool scratch of the kind
 * SCRATCH_DIRS describes. By name alone (copyDir omitted): byte-code is a *.pyc|*.pyo directly in a
 * __pycache__ folder; the pytest cache is only the files pytest writes (PYTEST_CACHE_FILES).
 * With copyDir the content is looked at too: byte-code needs a valid header and its source file
 * (<folder>/<name up to the first dot>.py) in the copy; the pytest cache files must start the way
 * pytest writes them (or parse as JSON) and stay small. A file that fails that is not scratch.
 */
export function isScratchPath(rel, copyDir = null) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) {
    if (parts[i] === '__pycache__') {
      if (!(i === last - 1 && /\.(pyc|pyo)$/i.test(parts[last]))) return false;
      if (copyDir === null) return true;
      const abs = path.join(copyDir, ...parts);
      const stem = parts[last].split('.')[0];
      const source = path.join(copyDir, ...parts.slice(0, i), `${stem}.py`);
      try {
        if (!fs.existsSync(source)) return false;
        const fd = fs.openSync(abs, 'r');
        try {
          const buf = Buffer.alloc(16);
          const n = fs.readSync(fd, buf, 0, 16, 0);
          return looksLikePycHeader(buf.subarray(0, n));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return false;
      }
    }
    if (parts[i] === '.pytest_cache') {
      const spec = PYTEST_CACHE_FILES[parts.slice(i + 1).join('/')];
      if (!spec) return false;
      if (copyDir === null) return true;
      try {
        const abs = path.join(copyDir, ...parts);
        if (fs.statSync(abs).size > spec.maxBytes) return false;
        const text = fs.readFileSync(abs, 'utf8');
        if (spec.json) {
          JSON.parse(text);
          return true;
        }
        return text.replace(/^﻿/, '').startsWith(spec.prefix);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * removeScratch(copyDir, rels) -> { removed: [rel], failed: [{ rel, error }] }
 * Deletes the given scratch files (isScratchPath, with the content check, must hold for each; anything else is refused) and
 * then the scratch folders that are now empty. Never touches any other file or folder.
 */
export function removeScratch(copyDir, rels) {
  const removed = [];
  const failed = [];
  const dirs = new Set();
  for (const rel of rels) {
    if (!isScratchPath(rel, copyDir)) {
      failed.push({ rel, error: 'not a scratch path' });
      continue;
    }
    const abs = path.join(copyDir, ...rel.split('/'));
    try {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
      dirs.add(path.dirname(abs));
    } catch (e) {
      failed.push({ rel, error: e.message });
    }
  }
  // Empty folders from the deepest up, but only folders that are themselves scratch folders or lie inside one.
  const root = path.resolve(copyDir);
  for (const d of [...dirs].sort((x, y) => y.length - x.length)) {
    let cur = path.resolve(d);
    while (cur.startsWith(root + path.sep)) {
      const rel = path.relative(root, cur).split(path.sep).join('/');
      const inside = rel.split('/').some((c) => SCRATCH_DIRS.includes(c));
      if (!inside) break;
      try {
        fs.rmdirSync(cur);
      } catch {
        break;
      }
      cur = path.dirname(cur);
    }
  }
  return { removed, failed };
}

function resolveBanner({ bannerText, templatesDir }) {
  if (typeof bannerText === 'string') return bannerText;
  if (templatesDir) return readText(path.join(templatesDir, BANNER_TEMPLATE));
  return null;
}

/** Prepend the banner to one copy file, keeping its BOM and line-ending style. */
export function prependBanner(abs, banner) {
  const { bom, text } = decodeKeepBom(readRaw(abs));
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const b = banner.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').join(eol);
  writeRaw(abs, encodeKeepBom(b + eol + eol + text, bom));
}

function substitute(s, map) {
  return String(s).replace(/\{(copy|snapshot)\}/g, (all, k) => (map[k] === undefined ? all : map[k]));
}

function hashOutputs(copyDir, globs) {
  const out = new Map();
  if (!globs || globs.length === 0) return out;
  for (const rel of listFiles(copyDir)) {
    if (!globs.some((g) => matchGlob(rel, g))) continue;
    out.set(rel, readRaw(path.join(copyDir, ...rel.split('/'))).toString('base64'));
  }
  return out;
}

/**
 * rebuildCopy(run, strip, copyDir, { snapshotDir? }) -> { exitCode, stdout, stderr, timedOut, changedOutputs: [rel], error? }
 * Runs run.rebuild through the allowlisted process runner. {copy} and {snapshot} are replaced in
 * args and cwd; env = process env + rebuild.env + strip.rebuildEnv.
 */
export function rebuildCopy(run, strip, copyDir, opts = {}) {
  const rb = run?.rebuild;
  if (!rb) return { exitCode: 0, stdout: '', stderr: '', timedOut: false, changedOutputs: [] };
  const map = { copy: copyDir, snapshot: opts.snapshotDir };
  const before = hashOutputs(copyDir, rb.outputsGlob);
  let res;
  try {
    res = runAllowed({
      cmd: rb.cmd,
      args: (rb.args ?? []).map((a) => substitute(a, map)),
      cwd: rb.cwd ? substitute(rb.cwd, map) : copyDir,
      env: { ...process.env, ...(rb.env ?? {}), ...(strip?.rebuildEnv ?? {}) },
      timeoutS: rb.timeoutS ?? DEFAULT_REBUILD_TIMEOUT_S,
      allow: run.allowExecutables ?? [],
    });
  } catch (e) {
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, changedOutputs: [], error: e.message };
  }
  const after = hashOutputs(copyDir, rb.outputsGlob);
  const changed = [];
  for (const [rel, h] of after) if (before.get(rel) !== h) changed.push(rel);
  for (const rel of before.keys()) if (!after.has(rel)) changed.push(rel);
  return {
    exitCode: res.exitCode,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: Boolean(res.timedOut),
    changedOutputs: changed.sort(),
  };
}

/**
 * makeReviewCopy({ run, strip, snapshotDir, reviewBase, rng, patterns?, templatesDir?, bannerText? }) ->
 *   { copyDir, copyId, stripLog, stripViolations, excluded, bannerFiles, bannerMissing, notesHits,
 *     rebuild: null|{ exitCode, outputs, timedOut, error?, stderrTail }, traceHits: [], copyTreeHash, listing }
 * listing: copyListing() of the finished copy (the file list the engine keeps to say which file changed later).
 * patterns: trace patterns (default: catalog/trace-patterns.json).
 * The banner text comes from bannerText, else from <templatesDir>/author-notes-banner.md (the run's
 * frozen templates). It is required when run.material.authorNotes is not empty.
 */
export function makeReviewCopy(opts) {
  const { run, strip, snapshotDir, reviewBase, rng } = opts;
  if (!run || !snapshotDir || !reviewBase || !rng) throw new UsageError('makeReviewCopy needs run, snapshotDir, reviewBase and rng');
  const patterns = opts.patterns ?? loadPatterns('trace');
  const allow = strip?.traceAllow ?? [];
  fs.mkdirSync(reviewBase, { recursive: true });
  const copyId = neutralName(reviewBase, rng, patterns);
  const copyDir = path.join(reviewBase, copyId);
  fs.mkdirSync(copyDir);

  // byte-exact copy of the snapshot (already laid out as <as>/<rel>)
  copyFiles(snapshotDir, listFiles(snapshotDir), copyDir);

  // 1. strip
  const { log: stripLog, violations: stripViolations, excluded } = applyStrip(copyDir, strip ?? {});

  // 2. author-notes banner
  const notes = run.material?.authorNotes ?? [];
  const bannerFiles = [];
  const bannerMissing = [];
  const notesHits = [];
  if (notes.length > 0) {
    const banner = resolveBanner(opts);
    if (banner === null) throw new UsageError('author notes are configured but no banner text was given (templatesDir or bannerText)');
    for (const rel of notes) {
      const r = String(rel).replace(/\\/g, '/');
      const abs = path.join(copyDir, ...r.split('/'));
      if (!fs.existsSync(abs)) {
        bannerMissing.push(r);
        continue;
      }
      const kind = fileKind(r);
      if (kind !== 'text' && kind !== 'html') throw new UsageError(`author notes must be a text file (md, txt, html): ${r}`);
      for (const h of notesProblems(decodeKeepBom(readRaw(abs)).text)) notesHits.push({ file: r, ...h });
      prependBanner(abs, banner);
      bannerFiles.push(r);
    }
  }

  // 3. rebuild on the copy
  let rebuild = null;
  if (run.rebuild) {
    const r = rebuildCopy(run, strip, copyDir, { snapshotDir });
    rebuild = {
      exitCode: r.exitCode,
      outputs: r.changedOutputs,
      timedOut: r.timedOut,
      stderrTail: String(r.stderr ?? '').slice(-2000),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  // 4. trace scan: contents, then the copy path and every path component inside it
  const traceHits = [...scanTrace(copyDir, patterns, allow), ...scanPaths(copyDir, patterns, allow)];
  const listing = copyListing(copyDir);

  return {
    copyDir,
    copyId,
    stripLog,
    stripViolations,
    excluded,
    bannerFiles,
    bannerMissing,
    notesHits,
    rebuild,
    traceHits,
    copyTreeHash: listing.treeHash,
    listing,
  };
}
