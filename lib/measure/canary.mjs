// Planted errors (canaries): validation, choice, application, sealing (SPEC 14.4, 14.5, 9.10).
//
// The planter only proposes. Code checks each proposal, takes the first candidate per
// slot that both code and the validator approve, applies the exact before -> after
// replacement to the review copy (keeping the file's BOM and line endings), and seals
// the key in the data home. commitment = hashJson(key) is logged before any reviewer
// prompt exists; reveal checks the commitment and deletes the sealed file.

import fs from 'node:fs';
import path from 'node:path';
import { hashJson, sha256Hex, fileKind } from '../core/hash.mjs';
import { readJson, writeJsonAtomic, readRaw, writeRaw } from '../core/fsx.mjs';
import { IntegrityError, UsageError } from '../core/errors.mjs';
import { matchGlob } from '../core/glob.mjs';
import { loadPatterns, scanString } from '../material/lint.mjs';
import { loadTaxonomy } from './taxonomy.mjs';
import { canarySettings, bandOf } from './slots.mjs';

export const BAND_TOLERANCE = 0.05;
export const OMISSION_MIN_SHORTER = 20;
export const MIN_BEFORE_CHARS = 3;
/** Text that `after` may not add (counted occurrences must not grow). */
export const GIVEAWAY_TOKENS = Object.freeze(['[', 'TODO', 'XXX', '<!--', '{{']);
/** Fixed keys may name a binary file (e.g. a rendered slide): `after` is then "sha256:<hex of the file bytes>". */
export const BINARY_AFTER_PREFIX = 'sha256:';

const TEXT_KINDS = new Set(['text', 'json', 'html']);
const SEV_RANK = { cosmetic: 0, major: 1, blocker: 2 };

export function severityRank(s) {
  return Object.prototype.hasOwnProperty.call(SEV_RANK, s) ? SEV_RANK[s] : -1;
}

// ------------------------------------------------------------------ text helpers

function safeRel(rel) {
  const r = String(rel ?? '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.split('/').some((c) => c === '..' || c === '' || c === '.')) return null;
  return r;
}

function absIn(copyDir, rel) {
  return path.join(copyDir, ...rel.split('/'));
}

/** Read a copy file: { raw, bom, text } (text has the BOM removed, line endings kept). */
export function readCopyFile(copyDir, rel) {
  const raw = readRaw(absIn(copyDir, rel));
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = (bom ? raw.subarray(3) : raw).toString('utf8');
  return { raw, bom, text };
}

/** Occurrences of needle in text (overlapping ones counted): [index]. */
export function occurrences(text, needle) {
  const out = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * CRLF-aware search: try the string as given; if it is absent, try it with the file's
 * line endings (LF -> CRLF when the file has CRLF; CRLF -> LF otherwise).
 * -> { needle, indexes }
 */
export function locate(text, s) {
  const str = String(s ?? '');
  let idx = occurrences(text, str);
  if (idx.length || !/[\r\n]/.test(str)) return { needle: str, indexes: idx };
  const alt = text.includes('\r\n') ? str.replace(/\r?\n/g, '\r\n') : str.replace(/\r\n/g, '\n');
  if (alt !== str) {
    idx = occurrences(text, alt);
    if (idx.length) return { needle: alt, indexes: idx };
  }
  return { needle: str, indexes: [] };
}

/** The same edit expressed with the file's line endings. */
function withFileEol(text, s) {
  const str = String(s ?? '');
  if (text.includes('\r\n')) return str.replace(/\r?\n/g, '\r\n');
  return str;
}

function countOf(s, token) {
  return occurrences(String(s ?? ''), token).length;
}

function tracePatterns(patterns) {
  if (Array.isArray(patterns)) return patterns;
  if (patterns && Array.isArray(patterns.patterns)) return patterns.patterns;
  return loadPatterns('trace');
}

function compiledForScan(patterns) {
  return patterns.map((p) => (p.re instanceof RegExp ? p : { ...p, re: new RegExp(p.regex, [...new Set(`${p.flags ?? ''}gu`)].join('')) }));
}

function gapBetween(a, b) {
  // a, b: { start, end } -> characters between the two spans (negative = overlap)
  if (b.start >= a.end) return b.start - a.end;
  if (a.start >= b.end) return a.start - b.end;
  return -1;
}

function positionFractionOf(positionIndex, rel, index) {
  if (!positionIndex || typeof positionIndex.offsetOf !== 'function') return null;
  const f = positionIndex.offsetOf(rel, index);
  return typeof f === 'number' && Number.isFinite(f) ? f : null;
}

// ------------------------------------------------------------------ validation

/**
 * validateCandidate(candidate, { copyDir, slot, run, otherEdits, patterns, positionIndex, taxonomy })
 *   -> { ok, errors: [string], index, positionFraction }
 *
 * otherEdits: edits of the same round already accepted, [{ file, index, before } | candidate]
 *   (an edit without `index` is located by its `before`). Distance between edits in one
 *   file must be at least run.canaries.minDistanceChars.
 * patterns: trace patterns (array, or the catalog object); default: catalog/trace-patterns.json.
 * positionIndex: P2 positionIndex of the pre-canary copy; without it the band check is skipped
 *   and positionFraction is null.
 * sample: makeSampleGuard() of the round's sample of large data files; an edit in such a file must
 *   lie inside a sampled row (SPEC 14.10).
 */
export function validateCandidate(candidate, opts = {}) {
  const { copyDir, slot = null, run = {}, otherEdits = [], positionIndex = null } = opts;
  const settings = canarySettings(run);
  const taxonomy = opts.taxonomy ?? loadTaxonomy();
  const errors = [];
  const res = { ok: false, errors, index: null, positionFraction: null };
  const c = candidate ?? {};

  if (slot && c.slot !== undefined && c.slot !== slot.slot) errors.push(`slot-mismatch: candidate ${c.slot} vs slot ${slot.slot}`);
  const typeId = slot?.type ?? c.type ?? null;
  const type = typeId ? taxonomy.byId(typeId) : null;
  if (typeId && !type) errors.push(`unknown-type: ${typeId}`);

  const rel = safeRel(c.file);
  if (!rel) {
    errors.push(`file-path-unsafe: ${c.file}`);
    return res;
  }
  const abs = absIn(copyDir, rel);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    /* missing */
  }
  if (!st || !st.isFile()) {
    errors.push(`file-missing: ${rel}`);
    return res;
  }
  const kind = fileKind(rel);
  if (!TEXT_KINDS.has(kind)) {
    errors.push(`not-a-text-file: ${rel} (${kind})`);
    return res;
  }

  const before = typeof c.before === 'string' ? c.before : '';
  const after = typeof c.after === 'string' ? c.after : null;
  if (after === null) errors.push('after-missing');
  if (before.length < MIN_BEFORE_CHARS) errors.push(`before-too-short: ${before.length} < ${MIN_BEFORE_CHARS}`);
  if (after !== null && after === before) errors.push('after-equals-before');
  if (before.length > settings.maxEditChars) errors.push(`before-too-long: ${before.length} > ${settings.maxEditChars}`);
  if (after !== null && after.length > settings.maxEditChars) errors.push(`after-too-long: ${after.length} > ${settings.maxEditChars}`);
  if (type?.omission && after !== null && after.length > before.length - OMISSION_MIN_SHORTER) {
    errors.push(`omission-not-shorter: after must be at least ${OMISSION_MIN_SHORTER} characters shorter than before`);
  }

  if (type?.needsRebuild) {
    if (!settings.visualAllowed) errors.push('visual-not-allowed');
    const globs = run?.rebuild?.sourcesGlob ?? [];
    if (!globs.some((g) => matchGlob(rel, g))) errors.push(`visual-not-rebuild-source: ${rel}`);
  }

  const { text } = readCopyFile(copyDir, rel);
  const found = before.length >= MIN_BEFORE_CHARS ? locate(text, before) : { needle: before, indexes: [] };
  if (found.indexes.length === 0) errors.push('before-not-found');
  else if (found.indexes.length > 1) errors.push(`before-not-unique: ${found.indexes.length} occurrences`);

  if (found.indexes.length === 1 && after !== null) {
    const index = found.indexes[0];
    res.index = index;
    const afterNeedle = withFileEol(text, after);
    const edited = text.slice(0, index) + afterNeedle + text.slice(index + found.needle.length);

    // Band (position over the concatenated text, SPEC 14.2 point 3).
    const fraction = positionFractionOf(positionIndex, rel, index);
    res.positionFraction = fraction;
    if (slot && Array.isArray(slot.range) && fraction !== null) {
      const [lo, hi] = slot.range;
      if (fraction < lo - BAND_TOLERANCE || fraction > hi + BAND_TOLERANCE) {
        errors.push(`outside-band: position ${fraction.toFixed(3)} not in ${slot.band} [${lo.toFixed(3)}, ${hi.toFixed(3)}] +/- ${BAND_TOLERANCE}`);
      }
    }

    // A large data file is reviewed through a sample: an edit goes only into a sampled row and must
    // leave that row's shape alone (SPEC 14.10).
    if (opts.sample && opts.sample.has(rel)) {
      const g = opts.sample.check(rel, index, found.needle.length, afterNeedle);
      if (!g.ok) errors.push(g.error);
    }

    // Distance to other edits of this round in the same file.
    const mine = { start: index, end: index + found.needle.length };
    for (const o of otherEdits ?? []) {
      if (!o || safeRel(o.file) !== rel || o === candidate) continue;
      let oi = Number.isInteger(o.index) ? o.index : null;
      let olen = typeof o.before === 'string' ? o.before.length : 0;
      if (oi === null && typeof o.before === 'string') {
        const f = locate(text, o.before);
        if (f.indexes.length === 1) {
          oi = f.indexes[0];
          olen = f.needle.length;
        }
      }
      if (oi === null) continue;
      const gap = gapBetween(mine, { start: oi, end: oi + olen });
      if (gap < settings.minDistanceChars) errors.push(`too-close: ${gap < 0 ? 'overlaps' : gap + ' characters from'} another edit in ${rel} (minimum ${settings.minDistanceChars})`);
    }

    // JSON must still parse.
    if (kind === 'json') {
      try {
        JSON.parse(edited);
      } catch (e) {
        errors.push(`json-broken: ${e.message}`);
      }
    }

    // No review trace and no giveaway markers in the new text.
    const pats = compiledForScan(tracePatterns(opts.patterns));
    for (const h of scanString(after, pats, [], ['both', 'content'])) errors.push(`trace-in-after: ${h.patternId} "${h.text}"`);
    for (const tok of GIVEAWAY_TOKENS) {
      if (countOf(after, tok) > countOf(before, tok)) errors.push(`giveaway: adds "${tok}"`);
    }
  }

  res.ok = errors.length === 0;
  return res;
}

// ------------------------------------------------------------------ choice

function keyOf(slot, alt) {
  return `${slot}#${alt}`;
}

function checkMap(codeChecks) {
  const m = new Map();
  if (Array.isArray(codeChecks)) {
    for (const c of codeChecks) if (c) m.set(keyOf(c.slot, c.alt), c);
  } else if (codeChecks && typeof codeChecks === 'object') {
    for (const [k, v] of Object.entries(codeChecks)) m.set(k, v);
  }
  return m;
}

/** The validator's keep rule (SPEC 9.9). */
export function validatorKeeps(v, slot) {
  if (!v) return false;
  return (
    v.keep === true &&
    v.originalCorrect === true &&
    v.isDefect === true &&
    v.provable === true &&
    Number(v.natural) >= 3 &&
    v.giveaway !== true &&
    severityRank(v.severity) >= severityRank(slot?.severityFloor ?? 'major')
  );
}

/**
 * chooseApproved(slots, candidates, validatorVerdicts, codeChecks, opts?) -> { approved, unfilled }
 *   For each slot, the first candidate (by alt) that passed code checks and the validator.
 *   codeChecks: [{ slot, alt, ok, index?, positionFraction? }] or { "S1#1": {...} }.
 *   opts.minDistanceChars (default from run settings or 400): approved edits in one file
 *   must be this far apart (needs `index` from the code checks).
 *   Each approved candidate carries validatorSeverity, index and positionFraction.
 */
export function chooseApproved(slots, candidates, validatorVerdicts, codeChecks, opts = {}) {
  const checks = checkMap(codeChecks);
  const verdicts = new Map((validatorVerdicts ?? []).map((v) => [keyOf(v.slot, v.alt), v]));
  const minDistance = Number(opts.minDistanceChars ?? opts.run?.canaries?.minDistanceChars ?? 400);
  const approved = [];
  const unfilled = [];
  for (const slot of slots ?? []) {
    const mine = (candidates ?? []).filter((c) => c && c.slot === slot.slot).sort((a, b) => Number(a.alt) - Number(b.alt));
    let chosen = null;
    for (const c of mine) {
      const k = keyOf(c.slot, c.alt);
      const chk = checks.get(k);
      if (!chk || chk.ok !== true) continue;
      const v = verdicts.get(k);
      if (!validatorKeeps(v, slot)) continue;
      if (Number.isInteger(chk.index)) {
        const span = { start: chk.index, end: chk.index + String(c.before ?? '').length };
        const clash = approved.some(
          (a) => safeRel(a.file) === safeRel(c.file) && Number.isInteger(a.index) && gapBetween(span, { start: a.index, end: a.index + String(a.before ?? '').length }) < minDistance,
        );
        if (clash) continue;
      }
      chosen = {
        ...c,
        validatorSeverity: v.severity,
        index: Number.isInteger(chk.index) ? chk.index : null,
        positionFraction: typeof chk.positionFraction === 'number' ? chk.positionFraction : null,
      };
      break;
    }
    if (chosen) approved.push(chosen);
    else unfilled.push(slot.slot);
  }
  return { approved, unfilled };
}

// ------------------------------------------------------------------ application

/**
 * applyEdits(copyDir, approved, opts?) -> { applied: [{ ...candidate, positionFraction }] }
 * Exact replacements; every `before` must still occur exactly once. The file keeps its
 * BOM and its line endings. opts.positionIndex (pre-canary) fills positionFraction when the
 * candidate does not already carry one.
 */
export function applyEdits(copyDir, approved, opts = {}) {
  const byFile = new Map();
  (approved ?? []).forEach((a, order) => {
    const rel = safeRel(a.file);
    if (!rel) throw new UsageError(`applyEdits: unsafe file ${a.file}`);
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push({ a, order });
  });
  const applied = [];
  for (const [rel, edits] of byFile) {
    const { bom, text } = readCopyFile(copyDir, rel);
    const located = edits.map(({ a: e, order }) => {
      const f = locate(text, e.before);
      if (f.indexes.length !== 1) {
        throw new UsageError(`applyEdits: "before" of ${e.slot ?? '?'} occurs ${f.indexes.length} times in ${rel}`);
      }
      return { e, order, index: f.indexes[0], needle: f.needle, afterNeedle: withFileEol(text, e.after) };
    });
    located.sort((a, b) => a.index - b.index);
    for (let i = 1; i < located.length; i++) {
      if (located[i].index < located[i - 1].index + located[i - 1].needle.length) {
        throw new UsageError(`applyEdits: overlapping edits in ${rel}`);
      }
    }
    let out = text;
    for (const l of [...located].reverse()) {
      out = out.slice(0, l.index) + l.afterNeedle + out.slice(l.index + l.needle.length);
    }
    const body = Buffer.from(out, 'utf8');
    writeRaw(absIn(copyDir, rel), bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
    for (const l of located) {
      const pf =
        typeof l.e.positionFraction === 'number' ? l.e.positionFraction : positionFractionOf(opts.positionIndex, rel, l.index);
      applied.push({ order: l.order, item: { ...l.e, file: rel, index: l.index, positionFraction: pf } });
    }
  }
  // Keep the caller's order (slot order).
  applied.sort((x, y) => x.order - y.order);
  return { applied: applied.map((x) => x.item) };
}

// ------------------------------------------------------------------ key

/**
 * buildKey({ runId, round, seedHex, applied, slots, validator }) -> key (SPEC 9.10)
 * validator: the validator answer (or its verdicts array), used when an applied candidate
 * has no validatorSeverity of its own.
 */
export function buildKey({ runId, round, seedHex, applied, slots, validator }) {
  const slotById = new Map((slots ?? []).map((s) => [s.slot, s]));
  const verdicts = Array.isArray(validator) ? validator : validator?.verdicts ?? [];
  const vmap = new Map(verdicts.map((v) => [keyOf(v.slot, v.alt), v]));
  const ordered = [...(applied ?? [])].sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
  const canaries = ordered.map((a, i) => {
    const s = slotById.get(a.slot) ?? {};
    const pf = typeof a.positionFraction === 'number' ? a.positionFraction : null;
    return {
      canary: `C${i + 1}`,
      slot: a.slot,
      purpose: s.purpose ?? a.purpose ?? 'measurement',
      targetLens: s.targetLens ?? a.targetLens ?? null,
      type: s.type ?? a.type,
      file: a.file,
      locator: a.locator ?? '',
      before: a.before,
      after: a.after,
      description: a.description ?? '',
      howProvable: a.howProvable ?? '',
      intendedSeverity: a.intendedSeverity ?? null,
      validatorSeverity: a.validatorSeverity ?? vmap.get(keyOf(a.slot, a.alt))?.severity ?? null,
      positionFraction: pf,
      band: pf !== null ? bandOf(pf) : s.band ?? null,
      prePlanted: false,
    };
  });
  return { schemaVersion: 1, runId, round, seedHex: seedHex ?? '', canaries };
}

function slotNumber(s) {
  const m = /^S(\d+)$/.exec(String(s ?? ''));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function sealedPath(dataPaths, runId, round) {
  if (typeof dataPaths?.sealedKey === 'function') return dataPaths.sealedKey(runId, roundLabel(round));
  if (typeof dataPaths?.sealedDir === 'function') return path.join(dataPaths.sealedDir(runId), `${roundLabel(round)}.key.json`);
  throw new UsageError('sealKey: dataPaths has no sealedDir()');
}

function roundLabel(round) {
  const n = Number(round);
  return Number.isInteger(n) && n >= 0 ? String(n).padStart(2, '0') : String(round);
}

/** sealKey(dataPaths, runId, round, key) -> { path, commitment }; commitment = hashJson(key). */
export function sealKey(dataPaths, runId, round, key) {
  const p = sealedPath(dataPaths, runId, round);
  writeJsonAtomic(p, key);
  return { path: p, commitment: hashJson(key) };
}

/**
 * revealKey(dataPaths, runId, round, commitment) -> key
 * Missing file or hashJson(key) != commitment -> IntegrityError('COMMITMENT_MISMATCH');
 * the file is then kept as evidence. On success the sealed file is deleted.
 */
export function revealKey(dataPaths, runId, round, commitment) {
  const p = sealedPath(dataPaths, runId, round);
  let key;
  try {
    key = readJson(p);
  } catch (e) {
    throw new IntegrityError('COMMITMENT_MISMATCH', `sealed canary key unreadable or missing: ${p} (${e.message})`, { path: p });
  }
  const h = hashJson(key);
  if (h !== commitment) {
    throw new IntegrityError('COMMITMENT_MISMATCH', `sealed canary key does not match its commitment`, { path: p, expected: commitment, actual: h });
  }
  fs.rmSync(p, { force: true });
  try {
    const dir = path.dirname(p);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }
  return key;
}

// ------------------------------------------------------------------ fixed (bench) keys

/**
 * validateFixedKey(key, copyDir, { prePlanted, taxonomy? }) -> { ok, errors }
 * prePlanted: true  -> every `after` occurs exactly once in its file (the edit is already in the copy);
 *                      a binary file uses after = "sha256:<hex>" and must hash to it.
 * prePlanted: false -> every `before` occurs exactly once in its file (the edit will be applied).
 */
export function validateFixedKey(key, copyDir, opts = {}) {
  const prePlanted = opts.prePlanted ?? true;
  const taxonomy = opts.taxonomy ?? loadTaxonomy();
  const errors = [];
  if (!key || typeof key !== 'object') return { ok: false, errors: ['key is not an object'] };
  if (key.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(key.canaries) || key.canaries.length === 0) return { ok: false, errors: [...errors, 'canaries must be a non-empty array'] };
  const ids = new Set();
  for (const [i, c] of key.canaries.entries()) {
    const at = `canaries[${i}] (${c?.canary ?? '?'})`;
    if (!c || typeof c.canary !== 'string' || !/^C\d+$/.test(c.canary)) errors.push(`${at}: bad canary id`);
    else if (ids.has(c.canary)) errors.push(`${at}: duplicate id`);
    else ids.add(c.canary);
    if (!['attention', 'measurement'].includes(c?.purpose)) errors.push(`${at}: purpose must be attention or measurement`);
    if (!taxonomy.byId(c?.type)) errors.push(`${at}: unknown type ${c?.type}`);
    if (typeof c?.after !== 'string' || c.after === '') errors.push(`${at}: after missing`);
    if (typeof c?.before !== 'string' || c.before === '') errors.push(`${at}: before missing`);
    if (c?.before === c?.after) errors.push(`${at}: after equals before`);
    if (Boolean(c?.prePlanted) !== Boolean(prePlanted)) errors.push(`${at}: prePlanted must be ${Boolean(prePlanted)}`);
    const rel = safeRel(c?.file);
    if (!rel) {
      errors.push(`${at}: unsafe file ${c?.file}`);
      continue;
    }
    const abs = absIn(copyDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      errors.push(`${at}: file missing in the copy: ${rel}`);
      continue;
    }
    const kind = fileKind(rel);
    if (!TEXT_KINDS.has(kind)) {
      if (!prePlanted) {
        errors.push(`${at}: a binary file can only be pre-planted`);
        continue;
      }
      const want = String(c.after ?? '');
      if (!want.startsWith(BINARY_AFTER_PREFIX)) {
        errors.push(`${at}: binary file needs after = "${BINARY_AFTER_PREFIX}<hex>"`);
        continue;
      }
      const have = sha256Hex(readRaw(abs));
      if (have !== want.slice(BINARY_AFTER_PREFIX.length).toLowerCase()) errors.push(`${at}: ${rel} does not hash to the key's after`);
      continue;
    }
    const { text } = readCopyFile(copyDir, rel);
    const probe = prePlanted ? c.after : c.before;
    const f = locate(text, probe);
    if (f.indexes.length !== 1) errors.push(`${at}: ${prePlanted ? 'after' : 'before'} occurs ${f.indexes.length} times in ${rel} (must be exactly once)`);
  }
  return { ok: errors.length === 0, errors };
}
