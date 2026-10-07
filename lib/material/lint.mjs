// Lints and text normalisation (SPEC 12.3, 15.5).
//
// Three pattern catalogs live in catalog/*.json:
//   trace  - review traces that must not appear in a review copy or in a path an agent is given
//   prompt - words and thresholds that must not appear in any value substituted into a frozen template
//   meta   - a reviewer answer that talks about planted / test errors
// Every regex is compiled with its own flags plus 'g' and 'u'.
//
// Also exports the quote normaliser (12.3) used for grounding, and the receipt line normaliser (9.8).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../core/errors.mjs';
import { fileKind } from '../core/hash.mjs';
import { listFiles, readText } from '../core/fsx.mjs';
import { normalizeLine } from '../core/text.mjs';
import { scanRecords, dataKindOf, SAMPLE_DEFAULTS } from './sample.mjs';

const CATALOG_DIR = fileURLToPath(new URL('../../catalog/', import.meta.url));

export const PATTERN_FILES = Object.freeze({
  trace: 'trace-patterns.json',
  prompt: 'forbidden-prompt-patterns.json',
  meta: 'meta-mention-patterns.json',
});

const SCANNED_KINDS = new Set(['text', 'json', 'html']);

/** Extensions of data files: tables and record lists whose values are the work itself, not prose. */
const DATA_EXT = new Set(['csv', 'tsv', 'jsonl', 'ndjson', 'json']);

/** True for a data file (.csv .tsv .jsonl .ndjson .json): the trace scan uses only its `data` patterns there. */
export function isDataFile(rel) {
  const name = String(rel).replace(/\\/g, '/').split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 && DATA_EXT.has(name.slice(dot + 1).toLowerCase());
}

function mergeFlags(flags) {
  const set = new Set(String(flags ?? '').split('').filter(Boolean));
  set.add('g');
  set.add('u');
  return [...set].join('');
}

/** Compile one pattern entry ({ id, regex, flags, ... }) into a copy with a RegExp under `re`. */
export function compilePattern(p) {
  if (!p || typeof p.regex !== 'string' || typeof p.id !== 'string') {
    throw new UsageError(`bad pattern entry: ${JSON.stringify(p)}`);
  }
  let re;
  try {
    re = new RegExp(p.regex, mergeFlags(p.flags));
  } catch (e) {
    throw new UsageError(`pattern ${p.id} does not compile: ${e.message}`);
  }
  return { ...p, scope: p.scope ?? 'both', re };
}

/**
 * loadPatterns('trace'|'prompt'|'meta', { catalogDir?, controlOnly? }) -> [{ id, regex, flags, lang, why, scope, re }]
 * controlOnly: leave out entries of class "rating-word" or "steering-word" (ordinary words such as "оценка
 * стоимости", "average price"). They are checked only in text the executor writes; the owner's task
 * and everything the lens writer derives from it are checked for loop-control constructs only.
 */
export function loadPatterns(kind, opts = {}) {
  const file = PATTERN_FILES[kind];
  if (!file) throw new UsageError(`unknown pattern kind: ${kind}`);
  const p = path.join(opts.catalogDir ?? CATALOG_DIR, file);
  const data = JSON.parse(readText(p));
  if (!data || !Array.isArray(data.patterns)) throw new UsageError(`${p}: no "patterns" array`);
  const ids = new Set();
  const out = [];
  for (const entry of data.patterns) {
    if (ids.has(entry.id)) throw new UsageError(`${p}: duplicate pattern id ${entry.id}`);
    ids.add(entry.id);
    if (opts.controlOnly && (entry.class === 'rating-word' || entry.class === 'steering-word')) continue;
    out.push(compilePattern(entry));
  }
  return out;
}

function ensureCompiled(patterns) {
  return (patterns ?? []).map((p) => (p.re instanceof RegExp ? p : compilePattern(p)));
}

/** Minimum length of a traceAllow phrase, and letters it must carry outside its one trace word. */
export const ALLOW_MIN_CHARS = 8;
export const ALLOW_MIN_OTHER_LETTERS = 4;
const ALLOW_FORBIDDEN = /[\\[\]*+?|^${}]/u;

let tracePatternsCache = null;
function tracePatterns() {
  if (!tracePatternsCache) tracePatternsCache = loadPatterns('trace');
  return tracePatternsCache;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Problems of one strip.json traceAllow entry ({ phrase, why }) -> [string] (r3-f1).
 * An allow is a LITERAL product phrase (matched case-insensitively), never a regex: at least
 * ALLOW_MIN_CHARS characters, no regex wildcards or character classes, exactly one trace word inside
 * it (an allow covering no trace word is not needed; one covering two or more lets history through),
 * and at least ALLOW_MIN_OTHER_LETTERS letters outside that word (so "panel" alone is refused while
 * "instrument panel" passes). A broad pattern such as ".+" can therefore never switch the scan off.
 */
export function allowProblems(entry, patterns = tracePatterns()) {
  const where = 'traceAllow entry';
  if (!entry || typeof entry !== 'object') return [`${where} ${JSON.stringify(entry)} must be an object { phrase, why }`];
  if (entry.pattern !== undefined) return [`${where} ${JSON.stringify(entry.pattern)}: traceAllow takes a literal "phrase", not a regex "pattern"`];
  const phrase = entry.phrase;
  if (typeof phrase !== 'string' || phrase.trim() === '') return [`${where} has no phrase`];
  const out = [];
  if (typeof entry.why !== 'string' || entry.why.trim() === '') out.push(`${where} "${phrase}" has no why`);
  if (phrase.trim().length < ALLOW_MIN_CHARS) out.push(`${where} "${phrase}" is shorter than ${ALLOW_MIN_CHARS} characters; allow a whole product phrase, not a word`);
  if (ALLOW_FORBIDDEN.test(phrase)) out.push(`${where} "${phrase}" contains regex characters; an allow is a literal product phrase`);
  const spans = [];
  for (const h of scanString(phrase, patterns, [], ['both', 'content', 'path'])) {
    const end = h.index + h.text.length;
    const o = spans.find((x) => h.index < x.end && end > x.start);
    if (o) {
      o.start = Math.min(o.start, h.index);
      o.end = Math.max(o.end, end);
    } else spans.push({ start: h.index, end });
  }
  if (spans.length === 0) out.push(`${where} "${phrase}" covers no review-trace word, so it is not needed`);
  if (spans.length > 1) out.push(`${where} "${phrase}" covers ${spans.length} review-trace words; an allow may cover exactly one`);
  let rest = phrase;
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) rest = rest.slice(0, sp.start) + rest.slice(sp.end);
  if ((rest.match(/\p{L}/gu) || []).length < ALLOW_MIN_OTHER_LETTERS) out.push(`${where} "${phrase}" has fewer than ${ALLOW_MIN_OTHER_LETTERS} letters besides the trace word; allow the whole product phrase`);
  return out;
}

/** strip.json traceAllow entries ({ phrase, why }) -> compiled case-insensitive literal RegExps. */
export function compileAllow(allow) {
  return (allow ?? []).map((a) => {
    const problems = allowProblems(a);
    if (problems.length) throw new UsageError(problems.join('; '));
    return new RegExp(escapeRegex(a.phrase.trim()), 'giu');
  });
}

/** How often each allow phrase occurs in the text files of dir: [{ phrase, why, matches, files }]. */
export function allowMatchCounts(dir, allow) {
  const res = compileAllow(allow);
  const out = (allow ?? []).map((a) => ({ phrase: a.phrase, why: a.why, matches: 0, files: 0 }));
  for (const rel of listFiles(dir)) {
    if (!SCANNED_KINDS.has(fileKind(rel))) continue;
    const text = readText(path.join(dir, ...rel.split('/')));
    res.forEach((re, i) => {
      const n = allMatches(re, text).length;
      if (n) {
        out[i].matches += n;
        out[i].files += 1;
      }
    });
  }
  return out;
}

/** All matches of a global RegExp in s: [{ index, end, text }]. Zero-length matches are skipped. */
function allMatches(re, s) {
  const out = [];
  re.lastIndex = 0;
  for (const m of s.matchAll(re)) {
    if (m[0].length === 0) continue;
    out.push({ index: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/** A hit [start, end) inside `s` is allowed when some allow match covers it completely. */
function isAllowed(s, start, end, allowRes) {
  for (const re of allowRes) {
    for (const m of allMatches(re, s)) {
      if (m.index <= start && m.end >= end) return true;
    }
  }
  return false;
}

/**
 * Hits of `patterns` in one string, minus allowed spans: [{ patternId, text, index }].
 * patterns: compiled (loadPatterns) or raw catalog entries; allow: RegExps or traceAllow entries.
 * scopes: which pattern scopes apply ('both', 'content', 'path'); default ['both'].
 */
export function scanString(s, patterns, allow = [], scopes = ['both']) {
  const pats = ensureCompiled(patterns);
  const allowRes = (allow ?? []).every((a) => a instanceof RegExp) ? allow ?? [] : compileAllow(allow);
  const hits = [];
  for (const p of pats) {
    if (!scopes.includes(p.scope ?? 'both')) continue;
    for (const m of allMatches(p.re, s)) {
      if (allowRes.length && isAllowed(s, m.index, m.end, allowRes)) continue;
      hits.push({ patternId: p.id, text: m.text, index: m.index });
    }
  }
  return hits;
}

/** Every string value (and key) of a parsed JSON value, with a JSON Pointer. */
export function jsonStrings(value, pointer = '') {
  const out = [];
  const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
  const walk = (v, ptr) => {
    if (typeof v === 'string') out.push({ pointer: ptr, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push({ pointer: `${ptr}/${esc(k)}`, text: k, key: true });
        walk(x, `${ptr}/${esc(k)}`);
      }
    }
  };
  walk(value, pointer);
  return out;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0), laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…' };

/** Decode numeric and the common named HTML entities. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v === undefined ? all : v;
  });
}

/** HTML text with script/style bodies and tags removed; `sep` replaces each tag. */
export function htmlText(html, sep = '') {
  const noScripts = String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, sep);
  return decodeEntities(noScripts.replace(/<!--[\s\S]*?-->/g, sep).replace(/<[^>]*>/g, sep));
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/**
 * decodeForScan(buf) -> string | null (r3-f15)
 * Text by CONTENT, whatever the extension: UTF-16 with a byte-order mark, UTF-16 without one (many
 * zero bytes on one side), or valid UTF-8 without zero bytes. null = genuinely binary (images,
 * archives, office files): the setup summary lists those to the owner.
 */
export function decodeForScan(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    if (sw.length % 2 === 0) sw.swap16();
    return sw.toString('utf16le');
  }
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) (i % 2 === 0 ? zeroEven++ : zeroOdd++);
  const half = head.length / 2;
  if (head.length >= 16 && zeroOdd > half * 0.3 && zeroEven < half * 0.05) return buf.toString('utf16le');
  if (head.length >= 16 && zeroEven > half * 0.3 && zeroOdd < half * 0.05 && buf.length % 2 === 0) {
    const sw = Buffer.from(buf);
    sw.swap16();
    return sw.toString('utf16le');
  }
  if (zeroEven + zeroOdd > 0) return null;
  try {
    const t = UTF8_STRICT.decode(buf);
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  } catch {
    return null;
  }
}

/** Text of a copy file for the trace scan, or null when it is genuinely binary (or an image/video). */
export function scanTextOf(abs, kind) {
  if (kind === 'image' || kind === 'video') return null;
  const buf = fs.readFileSync(abs);
  const t = decodeForScan(buf);
  if (t !== null) return t;
  // a file with a text extension that is not valid UTF-8 (e.g. Latin-1): read it leniently
  return SCANNED_KINDS.has(kind) ? readText(abs) : null;
}

/** A value counts as prose (every trace pattern applies to it) from this many words or characters. */
export const PROSE_MIN_WORDS = 4;
export const PROSE_MIN_CHARS = 30;
/** At most this many hits per large data file come from its prose-like values (the rest add nothing to a block). */
const MAX_PROSE_HITS_PER_FILE = 100;

/** True for a value that reads like a sentence: PROSE_MIN_WORDS words or PROSE_MIN_CHARS characters. */
export function looksLikeProse(s) {
  const t = String(s ?? '').trim();
  if (t.length >= PROSE_MIN_CHARS) return true;
  return t.split(/\s+/).filter(Boolean).length >= PROSE_MIN_WORDS;
}

/** Cells of one delimited record (quote-aware; "" inside quotes is one quote). */
function splitCells(rec, delimiter) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < rec.length; i++) {
    const c = rec[i];
    if (inQ) {
      if (c === '"') {
        if (rec[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The values of a data file as [{ text, line, where, forced }]: cells of a CSV/TSV (line = the line
 * its record starts on), string values of a JSON line or array (line for JSON lines, a pointer for
 * .json). `forced` marks text that could not be split into values (an unparsable JSON line or file):
 * it is scanned with every pattern, as prose.
 */
function dataValues(rel, text, scan) {
  const kind = dataKindOf(rel);
  const out = [];
  if (kind === 'csv' || kind === 'tsv') {
    if (!scan) return out;
    const recs = scan.header ? [scan.header, ...scan.rows] : scan.rows;
    for (const r of recs) for (const c of splitCells(text.slice(r.start, r.end), scan.delimiter)) out.push({ text: c, line: r.line, where: 'line' });
    return out;
  }
  if (kind === 'jsonl') {
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === '') return;
      try {
        for (const v of jsonStrings(JSON.parse(line))) out.push({ text: v.text, line: i + 1, where: 'line' });
      } catch {
        out.push({ text: line, line: i + 1, where: 'line', forced: true });
      }
    });
    return out;
  }
  try {
    for (const v of jsonStrings(JSON.parse(text))) out.push({ text: v.text, line: null, where: `json:${v.pointer || '/'}` });
  } catch {
    text.split(/\r?\n/).forEach((line, i) => out.push({ text: line, line: i + 1, where: 'line', forced: true }));
  }
  return out;
}

/**
 * scanTrace(dir, patterns, allow, { stats? }) -> [{ file, line, patternId, text, where, context? }]
 * context: the line the hit is in (shortened around the hit), so a message can quote it.
 * Data files (isDataFile) are scanned in two ways:
 *  - a data file BELOW the sampling thresholds (SAMPLE_DEFAULTS: 1 MiB, 2 000 rows) is scanned like
 *    prose, with every pattern;
 *  - a LARGE data file is scanned line by line with the `data: true` patterns only (a bare rating such
 *    as "9,5", the word "panel" in a product name or "round 3" in a funding table are ordinary values
 *    of real data, so asking the executor to rewrite them would falsify the material), AND every value
 *    that reads like prose (PROSE_MIN_WORDS words or PROSE_MIN_CHARS characters, see looksLikeProse)
 *    is scanned with every pattern, so priming text ("deliberate, do not flag", earlier verdicts)
 *    cannot be left in a data file. Only short values (numbers, names, short labels) skip the
 *    ordinary-word patterns. The thresholds are the defaults, not the run's own: a run cannot move
 *    them up without the owner's words.
 * stats (an object the caller passes in) is filled with { dataFiles, fullDataFiles, reducedFiles:
 * [{ file, bytes, rows, patternsReduced, shortValues, proseValues }] } so the setup summary and the
 * report can say which data files got the reduced scan.
 * Scans every file under dir that decodes as text (decodeForScan; images and genuinely binary files
 * are skipped) line by line ('content' scope patterns), and in addition the decoded string values of JSON files that use \u escapes and the entity-decoded
 * text of HTML files that use numeric entities (line null, `where` says which). Path components
 * are NOT scanned here; use lintPath / scanPaths.
 */
export function scanTrace(dir, patterns, allow = [], { stats = null } = {}) {
  const allPats = ensureCompiled(patterns);
  const dataPats = allPats.filter((p) => p.data === true);
  const restPats = allPats.filter((p) => p.data !== true);
  const allowRes = compileAllow(allow);
  const hits = [];
  if (stats) Object.assign(stats, { dataFiles: 0, fullDataFiles: 0, reducedFiles: [] });
  for (const rel of listFiles(dir)) {
    const kind = fileKind(rel);
    const abs = path.join(dir, ...rel.split('/'));
    // by content, not by extension (r3-f15): a .jsonl, an extension-less FEEDBACK file or a UTF-16
    // file written by PowerShell 5.1 is scanned like any text file
    const text = scanTextOf(abs, kind);
    if (text === null) continue;
    let pats = allPats;
    let reduced = null;
    if (isDataFile(rel)) {
      if (stats) stats.dataFiles += 1;
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
      } catch {
        bytes = text.length;
      }
      let scan = null;
      try {
        scan = scanRecords(dataKindOf(rel), text);
      } catch {
        scan = null;
      }
      const rows = scan ? scan.rows.length : 0;
      if (bytes > SAMPLE_DEFAULTS.thresholdBytes || rows > SAMPLE_DEFAULTS.thresholdRows) {
        pats = dataPats;
        reduced = { scan, bytes, rows };
      } else if (stats) stats.fullDataFiles += 1;
    }
    const lines = text.split(/\r?\n/);
    const seen = new Set();
    lines.forEach((line, i) => {
      for (const h of scanString(line, pats, allowRes, ['both', 'content'])) {
        hits.push({ file: rel, line: i + 1, patternId: h.patternId, text: h.text, where: 'line', context: hitContext(line, h.index, h.text.length) });
        seen.add(`${h.patternId}\0${h.text}`);
      }
    });
    if (reduced) {
      // a large data file: prose-like values get every pattern, short values keep the data patterns only
      const info = { file: rel, bytes: reduced.bytes, rows: reduced.rows, patternsReduced: restPats.filter((p) => ['both', 'content'].includes(p.scope ?? 'both')).length, shortValues: 0, proseValues: 0 };
      let proseHits = 0;
      for (const v of dataValues(rel, text, reduced.scan)) {
        if (!v.forced && !looksLikeProse(v.text)) {
          info.shortValues += 1;
          continue;
        }
        info.proseValues += 1;
        if (proseHits >= MAX_PROSE_HITS_PER_FILE) continue;
        for (const h of scanString(v.text, v.forced ? allPats : restPats, allowRes, ['both', 'content'])) {
          const k = `${h.patternId}\0${h.text}`;
          if (seen.has(k)) continue;
          seen.add(k);
          proseHits += 1;
          hits.push({ file: rel, line: v.line, patternId: h.patternId, text: h.text, where: v.where, context: hitContext(v.text, h.index, h.text.length) });
        }
      }
      if (stats) stats.reducedFiles.push(info);
    }
    const extra = [];
    if (kind === 'json' && /\\u[0-9a-fA-F]{4}/.test(text)) {
      try {
        for (const s of jsonStrings(JSON.parse(text))) extra.push({ text: s.text, where: `json:${s.pointer || '/'}` });
      } catch {
        /* unparsable JSON: the raw lines were scanned */
      }
    }
    if (kind === 'html' && /&#/.test(text)) extra.push({ text: htmlText(text, ' '), where: 'html-text' });
    for (const x of extra) {
      for (const h of scanString(x.text, pats, allowRes, ['both', 'content'])) {
        const k = `${h.patternId}\0${h.text}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push({ file: rel, line: null, patternId: h.patternId, text: h.text, where: x.where, context: hitContext(x.text, h.index, h.text.length) });
      }
    }
  }
  return hits;
}

/** The line around a hit, at most about 160 characters; whitespace is kept so a literal phrase cut from it still matches the file. */
function hitContext(line, index, len) {
  const L = String(line);
  const from = Math.max(0, index - 70);
  const to = Math.min(L.length, index + len + 70);
  return (from > 0 ? '...' : '') + L.slice(from, to).trim() + (to < L.length ? '...' : '');
}

/** Path components of an absolute or relative path (both separators). */
export function pathComponents(p) {
  return String(p)
    .split(/[\\/]+/)
    .filter((c) => c !== '' && c !== '.' && !/^[A-Za-z]:$/.test(c));
}

/** lintPath(absPath, patterns, allow?) -> [{ component, patternId, text }] — every component, both scopes. */
export function lintPath(absPath, patterns, allow = []) {
  const pats = ensureCompiled(patterns);
  const allowRes = compileAllow(allow);
  const hits = [];
  for (const component of pathComponents(absPath)) {
    for (const h of scanString(component, pats, allowRes, ['both', 'path'])) {
      hits.push({ component, patternId: h.patternId, text: h.text });
    }
  }
  return hits;
}

/**
 * Path scan of a copy: the copy folder's own absolute path plus every relative file path inside it.
 * -> [{ file: rel|null, line: null, patternId, text, where: 'path', component }]
 */
export function scanPaths(dir, patterns, allow = []) {
  const out = [];
  for (const h of lintPath(dir, patterns, allow)) {
    out.push({ file: null, line: null, patternId: h.patternId, text: h.text, where: 'path', component: h.component });
  }
  const reported = new Set();
  for (const rel of listFiles(dir)) {
    for (const h of lintPath(rel, patterns, allow)) {
      // a folder component shared by many files is reported once
      const parts = rel.split('/');
      const idx = parts.indexOf(h.component);
      const prefix = parts.slice(0, idx + 1).join('/');
      const key = `${prefix}\0${h.patternId}`;
      if (reported.has(key)) continue;
      reported.add(key);
      out.push({ file: prefix, line: null, patternId: h.patternId, text: h.text, where: 'path', component: h.component });
    }
  }
  return out;
}

/** Flatten { name: string | string[] | nested } into [{ name, text }]. */
function flattenValues(values) {
  const out = [];
  const walk = (name, v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') out.push({ name, text: v });
    else if (typeof v === 'number' || typeof v === 'boolean') out.push({ name, text: String(v) });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${name}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${name}.${k}`, x);
  };
  for (const [k, v] of Object.entries(values ?? {})) walk(k, v);
  return out;
}

/**
 * lintValues({ name: string|string[]|object }, patterns) -> [{ name, patternId, text }]
 * Nested arrays/objects are walked; `name` then carries the path (e.g. "lenses[0].duty").
 */
export function lintValues(values, patterns) {
  const pats = ensureCompiled(patterns);
  const hits = [];
  for (const { name, text } of flattenValues(values)) {
    for (const h of scanString(text, pats, [], ['both', 'content'])) {
      hits.push({ name, patternId: h.patternId, text: h.text });
    }
  }
  return hits;
}

/** lintText(text, patterns) -> [{ line, patternId, text }] (used by `gauntlet lint`). */
export function lintText(text, patterns, scopes = ['both', 'content']) {
  const pats = ensureCompiled(patterns);
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const h of scanString(line, pats, [], scopes)) hits.push({ line: i + 1, patternId: h.patternId, text: h.text });
    });
  return hits;
}

/** Longest author-notes file (characters, after strip) that may reach reviewers (r3-f2). */
export const MAX_NOTES_CHARS = 12000;

/**
 * notesProblems(text, { patterns? }) -> [{ line, patternId, text }] (r3-f2)
 * Author notes are executor-written text that every reviewer is told to open, so their contents
 * get the prompt lint of executor text: loop control, steering ("do not flag", «это не ошибка»),
 * intent ("on purpose", «специально») and fix or check claims ("corrected", «сверены»). Rating
 * words and numeric comparisons (notNotes) are ordinary facts in notes and are left out; scores and
 * round history are caught by the trace scan. A file longer than MAX_NOTES_CHARS is refused too.
 */
export function notesProblems(text, { patterns = null } = {}) {
  const pats = patterns ?? loadPatterns('prompt').filter((p) => p.class !== 'rating-word' && !p.notNotes);
  const out = lintText(text, pats);
  const n = [...String(text)].length;
  if (n > MAX_NOTES_CHARS) out.push({ line: null, patternId: 'NOTES-TOO-LONG', text: `${n} characters (at most ${MAX_NOTES_CHARS})` });
  return out;
}

// ---------------------------------------------------------------- normalisers

const cc = (...codes) => String.fromCharCode(...codes);
const ZERO_WIDTH = new RegExp(`[${cc(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad)}]`, 'g');
const ODD_SPACES = new RegExp(`[${cc(0xa0, 0x1680)}${cc(0x2000)}-${cc(0x200a)}${cc(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)}\t\r\n\v\f]`, 'g');
const QUOTES = new RegExp(`[${cc(0x201c, 0x201d, 0x201e, 0x201f, 0xab, 0xbb, 0x2018, 0x2019, 0x201a, 0x201b, 0x2039, 0x203a)}"']`, 'g');
const DASHES = new RegExp(`[${cc(0x2010)}-${cc(0x2015)}${cc(0x2212)}]`, 'g');

/** 12.3: NFKC; odd spaces -> space; zero-width removed; quotes -> "; dashes -> -; whitespace collapsed; trimmed. Case kept. */
export function normalizeQuote(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(ODD_SPACES, ' ')
    .replace(QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export { normalizeLine };

export const MIN_QUOTE_CHARS = 4;

/** Normalised searchable texts of one copy file (12.3); [] for a file that is not text/json/html. */
export function searchableTexts(abs, rel) {
  const kind = fileKind(rel);
  if (!SCANNED_KINDS.has(kind)) return [];
  let raw;
  try {
    raw = readText(abs);
  } catch {
    return [];
  }
  const texts = [raw];
  if (kind === 'json') {
    try {
      for (const s of jsonStrings(JSON.parse(raw))) if (!s.key) texts.push(s.text);
    } catch {
      /* raw text only */
    }
  }
  if (kind === 'html') {
    texts.push(htmlText(raw, ''));
    texts.push(htmlText(raw, ' '));
  }
  return texts.map(normalizeQuote);
}

/** A cited file as a copy-relative POSIX path, or null when it is not inside the copy. */
function citedRel(copyDir, rel) {
  if (rel === null || rel === undefined || rel === '') return null;
  let r = String(rel).trim();
  if (path.isAbsolute(r) || /^[A-Za-z]:[\\/]/.test(r)) {
    const relative = path.relative(path.resolve(copyDir), path.resolve(r));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    r = relative;
  }
  r = r.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (r.split('/').some((c) => c === '..')) return null;
  return r;
}

/**
 * findQuote(copyDir, rel|null, quote) -> { found, file }
 * 12.3: both sides normalised; cited file first, then every text/json/html file of the copy;
 * JSON: raw text and every decoded string value; HTML: raw text and text with tags removed.
 * A quote shorter than 4 characters after normalisation is never found.
 */
export function findQuote(copyDir, rel, quote) {
  const q = normalizeQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return { found: false, file: null };
  const files = listFiles(copyDir);
  const cited = citedRel(copyDir, rel);
  const order = [];
  if (cited) {
    const exact = files.find((f) => f === cited) ?? (process.platform === 'win32' ? files.find((f) => f.toLowerCase() === cited.toLowerCase()) : undefined);
    if (exact) order.push(exact);
  }
  for (const f of files) if (!order.includes(f)) order.push(f);
  for (const f of order) {
    const texts = searchableTexts(path.join(copyDir, ...f.split('/')), f);
    if (texts.some((t) => t.includes(q))) return { found: true, file: f };
  }
  return { found: false, file: null };
}

/** True for the kinds that lints, strip rules and quote search read (text, json, html). */
export function isScannable(rel) {
  return SCANNED_KINDS.has(fileKind(rel));
}
