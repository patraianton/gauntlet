// Sampled review of large data files (SPEC 14.10, D40).
//
// A data file (.csv .tsv .jsonl .ndjson, or a .json file whose top level is an array) above a size
// or row threshold cannot be read whole by a reviewer. For such a file the program draws, every
// round, a seeded random sample of its rows: the header plus up to `rows` rows drawn uniformly
// (capped in characters, never below SAMPLE_MIN_ROWS), plus every row a planted error sits in.
// The selection is made after the snapshot, kept in the sealed stage like the canary key, and
// rendered for the reviewers as a SAMPLE file in their job folder. The executor never sees which
// rows will be drawn, and the draw changes every round.
//
// This module is pure file logic: scanning a file into records, drawing, rendering, and the
// checks the planter's edits and the read receipts need. It keeps no state except a scan cache.

import fs from 'node:fs';
import path from 'node:path';
import { hashJson } from '../core/hash.mjs';
import { listFiles, readText } from '../core/fsx.mjs';
import { normalizeLine } from '../core/text.mjs';

export const SAMPLE_MIN_ROWS = 20;
/** A group of data files of one kind in one folder counts as one data set above SAMPLE_GROUP_FACTOR x the file threshold. */
export const SAMPLE_GROUP_FACTOR = 4;
export const SAMPLE_DEFAULTS = Object.freeze({ thresholdBytes: 1048576, thresholdRows: 2000, rows: 200, maxBytes: 100000, totalBytes: 250000 });
/** Receipt lines are 8..300 characters (receipts.mjs LINE_MIN / LINE_MAX). */
const RECEIPT_MIN = 8;
const RECEIPT_MAX = 300;

/** The effective sampling settings of a run (run.limits.sample*; defaults when absent). */
export function samplingSettings(run) {
  const l = run?.limits ?? {};
  const pick = (v, d) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : d);
  return {
    thresholdBytes: pick(l.sampleThresholdBytes, SAMPLE_DEFAULTS.thresholdBytes),
    thresholdRows: pick(l.sampleThresholdRows, SAMPLE_DEFAULTS.thresholdRows),
    rows: pick(l.sampleRows, SAMPLE_DEFAULTS.rows),
    maxBytes: pick(l.sampleMaxBytes, SAMPLE_DEFAULTS.maxBytes),
    totalBytes: pick(l.sampleTotalBytes, SAMPLE_DEFAULTS.totalBytes),
    // Files of one kind in one folder that are each below the per-file threshold but together over
    // this size are treated as one data set (no setting of its own: it follows the file threshold).
    groupBytes: pick(l.sampleThresholdBytes, SAMPLE_DEFAULTS.thresholdBytes) * SAMPLE_GROUP_FACTOR,
  };
}

// ------------------------------------------------------------------ record scanning

const EXT_KIND = Object.freeze({ csv: 'csv', tsv: 'tsv', jsonl: 'jsonl', ndjson: 'jsonl', json: 'json' });

/** 'csv' | 'tsv' | 'jsonl' | 'json' (only a candidate: json counts when its top level is an array) | null. */
export function dataKindOf(rel) {
  const name = String(rel).replace(/\\/g, '/').split('/').pop();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_KIND[name.slice(dot + 1).toLowerCase()] ?? null;
}

function lineCounter(text) {
  let pos = 0;
  let line = 1;
  return (p) => {
    for (let i = text.indexOf('\n', pos); i !== -1 && i < p; i = text.indexOf('\n', pos)) {
      line++;
      pos = i + 1;
    }
    return line;
  };
}

function detectDelimiter(text, kind) {
  if (kind === 'tsv') return '\t';
  const end = text.indexOf('\n');
  const head = end === -1 ? text : text.slice(0, end);
  let best = ',';
  let bestN = -1;
  for (const d of [',', ';', '\t', '|']) {
    let inQ = false;
    let n = 0;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (c === '"') inQ = !inQ;
      else if (c === d && !inQ) n++;
    }
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** Records of delimited text as [{ start, end }] (end exclusive, no trailing CR; blank lines skipped). */
function scanDelimited(text, delim) {
  const dc = delim.charCodeAt(0);
  const n = text.length;
  const recs = [];
  let i = 0;
  while (i < n) {
    const start = i;
    let inQ = false;
    let fieldStart = true;
    let j = i;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (inQ) {
        if (c === 34) {
          if (text.charCodeAt(j + 1) === 34) j++;
          else inQ = false;
        }
        continue;
      }
      if (c === 10) break;
      if (c === 34 && fieldStart) {
        inQ = true;
        fieldStart = false;
        continue;
      }
      fieldStart = c === dc;
    }
    let end = j;
    if (end > start && text.charCodeAt(end - 1) === 13) end--;
    if (end > start) recs.push({ start, end });
    i = j + 1;
  }
  return recs;
}

function scanLines(text) {
  const n = text.length;
  const recs = [];
  let i = 0;
  while (i < n) {
    let j = text.indexOf('\n', i);
    if (j === -1) j = n;
    let end = j;
    if (end > i && text.charCodeAt(end - 1) === 13) end--;
    if (end > i && text.slice(i, end).trim() !== '') recs.push({ start: i, end });
    i = j + 1;
  }
  return recs;
}

/** Elements of a top-level JSON array as [{ start, end }]; null when the text is not one. */
function scanJsonArray(text) {
  const n = text.length;
  let i = 0;
  const ws = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  while (i < n && ws(text.charCodeAt(i))) i++;
  if (text[i] !== '[') return null;
  i++;
  const recs = [];
  for (;;) {
    while (i < n && ws(text.charCodeAt(i))) i++;
    if (i >= n) return null;
    if (text[i] === ']') break;
    const start = i;
    let depth = 0;
    let inStr = false;
    let closed = false;
    for (; i < n; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    if (i >= n && !closed) return null;
    let end = i;
    while (end > start && ws(text.charCodeAt(end - 1))) end--;
    if (end > start) recs.push({ start, end });
    if (text[i] === ',') i++;
    else if (text[i] === ']') break;
  }
  return recs;
}

/**
 * scanRecords(kind, text) -> { kind, delimiter, header: { start, end, line }|null,
 *   rows: [{ start, end, line }] } | null
 * csv/tsv: the first record is the header; jsonl: every non-blank line; json: the array elements.
 * Offsets are into the BOM-stripped text (the same indexes canary edits use).
 */
export function scanRecords(kind, text) {
  let recs;
  let delimiter = null;
  let header = null;
  if (kind === 'csv' || kind === 'tsv') {
    delimiter = detectDelimiter(text, kind);
    recs = scanDelimited(text, delimiter);
    if (recs.length) header = recs.shift();
  } else if (kind === 'jsonl') {
    recs = scanLines(text);
  } else if (kind === 'json') {
    recs = scanJsonArray(text);
    if (!recs) return null;
  } else return null;
  const lineAt = lineCounter(text);
  if (header) header = { ...header, line: lineAt(header.start) };
  const rows = recs.map((r) => ({ start: r.start, end: r.end, line: lineAt(r.start) }));
  return { kind, delimiter, header, rows };
}

// ------------------------------------------------------------------ file access with a scan cache

const scanCache = new Map();
const viewCache = new Map();
// The text of the files read last (a few at most, and never more than TEXT_CACHE_CHARS together,
// except the newest one): a scan is cached without its text, so a lookup of one row of a 100 MB
// file does not re-read the file, and a pass over many large files holds one of them at a time.
const textCache = new Map();
const TEXT_CACHE_MAX_FILES = 3;
const TEXT_CACHE_CHARS = 160 * 1024 * 1024;

/** Forget cached scans, texts and rendered samples (call after a file of the copy was edited). */
export function clearSampleCaches() {
  scanCache.clear();
  viewCache.clear();
  textCache.clear();
}

function cachedText(abs, key) {
  let text = textCache.get(key);
  if (text !== undefined) {
    textCache.delete(key); // most recently used goes last
    textCache.set(key, text);
    return text;
  }
  text = readText(abs);
  textCache.set(key, text);
  let total = 0;
  for (const t of textCache.values()) total += t.length;
  for (const k of [...textCache.keys()]) {
    if (k === key || (textCache.size <= TEXT_CACHE_MAX_FILES && total <= TEXT_CACHE_CHARS)) continue;
    total -= textCache.get(k).length;
    textCache.delete(k);
  }
  return text;
}

function absOf(dir, rel) {
  return path.join(dir, ...String(rel).split('/'));
}

/**
 * scanFile(dir, rel) -> { rel, kind, bytes, scan, text } | null (not a data file, or a json that is not an array).
 * `text` is read on first use (a scan-cache hit does not need it).
 */
export function scanFile(dir, rel) {
  const kind = dataKindOf(rel);
  if (!kind) return null;
  const abs = absOf(dir, rel);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const key = `${abs}|${st.mtimeMs}|${st.size}`;
  let scan = scanCache.get(key);
  if (scan === undefined) {
    scan = scanRecords(kind, cachedText(abs, key));
    scanCache.set(key, scan);
  }
  if (!scan) return null;
  return {
    rel,
    kind,
    bytes: st.size,
    scan,
    get text() {
      return cachedText(abs, key);
    },
  };
}

// ------------------------------------------------------------------ planning

function isLarge(bytes, rows, s) {
  return bytes > s.thresholdBytes || rows > s.thresholdRows;
}

/**
 * Big text files that are data but cannot be drawn rows from: a JSON file whose top level is an
 * object (or that does not parse), XML, SQL dumps, plain text and logs, YAML. Only their size is
 * known; a reviewer gets no sample of them, so the program says so instead of staying silent.
 */
const UNSAMPLED_EXT = new Set(['json', 'xml', 'sql', 'txt', 'log', 'yaml', 'yml']);

function extOf(rel) {
  const name = String(rel).replace(/\\/g, '/').split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function dirOf(key) {
  const k = String(key).replace(/\\/g, '/');
  const i = k.lastIndexOf('/');
  return i < 0 ? '' : k.slice(0, i);
}

/**
 * classifyEntries([{ key, dir, rel }], settings) -> { large: [{ key, rel, dir, f, grouped }], unsampled: [{ file, kind, bytes, grouped }] }
 * `key` is the name the file goes by in the selection and in reports (the path under the folder
 * for a copy, the manifest path for the live material); `dir` + `rel` locate it on disk.
 *  - large: a data file that can be sampled (csv, tsv, jsonl, a json array) over a threshold, or
 *    one of a group (see below);
 *  - unsampled: a data file that cannot be sampled (a json object, xml, sql, txt, log, yaml) over the
 *    byte threshold, or one of a group;
 *  - group: the files of one kind in one folder that are each under the threshold, when there are
 *    at least two and together they exceed settings.groupBytes. Splitting one data set into many
 *    files just under the limit does not hide it: its files are sampled (or listed) like large ones.
 *    `grouped` is { files, bytes } for a member of a group, null otherwise.
 */
export function classifyEntries(entries, settings) {
  const large = [];
  const unsampled = [];
  const small = new Map(); // group key -> [{ e, f, bytes, ext }]
  for (const e of entries) {
    const kind = dataKindOf(e.key);
    const ext = extOf(e.key);
    if (!kind && !UNSAMPLED_EXT.has(ext)) continue;
    const f = kind ? scanFile(e.dir, e.rel) : null;
    let bytes;
    if (f) bytes = f.bytes;
    else {
      try {
        const st = fs.statSync(absOf(e.dir, e.rel));
        if (!st.isFile()) continue;
        bytes = st.size;
      } catch {
        continue;
      }
    }
    const over = f ? isLarge(bytes, f.scan.rows.length, settings) : bytes > settings.thresholdBytes;
    if (over) {
      if (f) large.push({ ...e, f, grouped: null });
      else unsampled.push({ file: e.key, kind: ext, bytes, grouped: null });
      continue;
    }
    const gk = `${dirOf(e.key)}|${ext === 'ndjson' ? 'jsonl' : ext}`;
    if (!small.has(gk)) small.set(gk, []);
    small.get(gk).push({ e, f, bytes, ext });
  }
  const limit = Number.isFinite(settings.groupBytes) ? settings.groupBytes : Infinity;
  for (const members of small.values()) {
    const bytes = members.reduce((a, m) => a + m.bytes, 0);
    if (members.length < 2 || bytes <= limit) continue;
    const grouped = { files: members.length, bytes };
    for (const m of members) {
      if (m.f) large.push({ ...m.e, f: m.f, grouped });
      else unsampled.push({ file: m.e.key, kind: m.ext, bytes: m.bytes, grouped });
    }
  }
  large.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  unsampled.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { large, unsampled };
}

function entriesOfDir(dir, rels) {
  return (rels ?? listFiles(dir)).map((rel) => ({ key: rel, dir, rel }));
}

/** Data files of a directory that are over a threshold or part of a group: [{ file, kind, bytes, rows, grouped? }] (no drawing, no rng). */
export function largeDataFiles(dir, settings, rels = null) {
  return classifyEntries(entriesOfDir(dir, rels), settings).large.map((x) => ({ file: x.key, kind: x.f.kind, bytes: x.f.bytes, rows: x.f.scan.rows.length, ...(x.grouped ? { grouped: x.grouped } : {}) }));
}

/** Big data files that cannot be sampled, and members of groups of such files: [{ file, kind (extension), bytes, grouped? }]. */
export function unsampledDataFiles(dir, settings, rels = null) {
  return classifyEntries(entriesOfDir(dir, rels), settings).unsampled.map((x) => ({ file: x.file, kind: x.kind, bytes: x.bytes, ...(x.grouped ? { grouped: x.grouped } : {}) }));
}

/**
 * planSample(dir, settings, getRng) -> selection | null
 * One draw per large data file; null when no file is large and none is left unsampled (getRng is
 * then never called, so a run without large files consumes no randomness). A file whose every row
 * fits the sample is read whole and is not listed.
 *   selection = { schemaVersion: 1, settings, files: [ { file, kind, bytes, rows, header, chosen: [row numbers],
 *                 capped, capBytes, forCanary: [row numbers added for a planted error], grouped? } ],
 *                 unsampled?: [ { file, kind, bytes, grouped? } ] }
 * `unsampled` lists the big files that cannot be sampled (see classifyEntries); it is absent when
 * there are none, so the selection of an older round keeps its shape.
 * The characters of drawn rows of all files together stay within settings.totalBytes (split evenly,
 * at most settings.maxBytes per file), except that every file keeps its first SAMPLE_MIN_ROWS rows
 * and the rows added for planted errors (a few) come on top.
 * Row numbers count data rows from 1 (the header is not counted).
 */
export function planSample(dir, settings, getRng) {
  const files = [];
  let rng = null;
  // The total budget is split evenly over the large files; each file keeps its own cap too.
  const cls = classifyEntries(entriesOfDir(dir, null), settings);
  const large = cls.large.map((x) => ({ rel: x.key, f: x.f, grouped: x.grouped }));
  const total = Number.isFinite(settings.totalBytes) ? settings.totalBytes : Infinity;
  const share = large.length ? Math.floor(total / large.length) : 0;
  const capBytes = Math.min(settings.maxBytes, share);
  for (const { rel, f, grouped } of large) {
    const rows = f.scan.rows;
    rng = rng || getRng();
    // a random prefix of a random permutation is a uniform sample
    const order = new Int32Array(rows.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const chosen = [];
    const minRows = Math.min(SAMPLE_MIN_ROWS, settings.rows);
    let bytes = 0;
    let capped = false;
    for (let k = 0; k < rows.length; k++) {
      const j = rng.int(k, rows.length);
      const t = order[k];
      order[k] = order[j];
      order[j] = t;
      const r = rows[order[k]];
      const len = r.end - r.start;
      if (chosen.length >= minRows) {
        if (chosen.length >= settings.rows) break;
        if (bytes + len > capBytes) {
          capped = true;
          break;
        }
      }
      chosen.push(order[k] + 1);
      bytes += len;
    }
    if (chosen.length >= rows.length) continue; // every row is in the sample: nothing to draw
    chosen.sort((a, b) => a - b);
    files.push({ file: rel, kind: f.kind, bytes: f.bytes, rows: rows.length, header: !!f.scan.header, chosen, capped, capBytes, forCanary: [], ...(grouped ? { grouped } : {}) });
  }
  if (!files.length && !cls.unsampled.length) return null;
  return { schemaVersion: 1, settings: { ...settings }, files, ...(cls.unsampled.length ? { unsampled: cls.unsampled } : {}) };
}

/** The commitment of a selection (logged in the ledger; the rows themselves stay sealed until reveal). */
export function sampleHash(selection) {
  return hashJson(selection);
}

export function entryOf(selection, rel) {
  return (selection?.files ?? []).find((f) => f.file === rel) ?? null;
}

/** The index (0-based) of the row containing a character offset, or -1. */
function rowIndexAt(scan, index) {
  const rows = scan.rows;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (index < r.start) hi = mid - 1;
    else if (index >= r.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * addCanaryRows(dir, selection, canaries, { use: 'before'|'after' }) -> { selection, added: [{ file, row }] }
 * Every row a planted error sits in belongs to the sample. `before` is looked up in the pre-planting
 * copy, `after` in an already planted one (a bench key). A canary outside a sampled file is ignored.
 */
export function addCanaryRows(dir, selection, canaries, { use = 'before' } = {}) {
  if (!selection) return { selection, added: [] };
  const next = structuredClone(selection);
  const added = [];
  for (const c of canaries ?? []) {
    const entry = entryOf(next, String(c.file ?? '').replace(/\\/g, '/'));
    if (!entry) continue;
    const f = scanFile(dir, entry.file);
    if (!f) continue;
    const needle = String(c[use] ?? '');
    if (needle.length < 1) continue;
    let idx = f.text.indexOf(needle);
    if (idx === -1 && /[\r\n]/.test(needle)) idx = f.text.indexOf(f.text.includes('\r\n') ? needle.replace(/\r?\n/g, '\r\n') : needle.replace(/\r\n/g, '\n'));
    if (idx === -1) continue;
    const ri = rowIndexAt(f.scan, idx);
    if (ri === -1) continue;
    const row = ri + 1;
    if (!entry.chosen.includes(row)) {
      entry.chosen.push(row);
      entry.chosen.sort((a, b) => a - b);
      entry.forCanary.push(row);
      added.push({ file: entry.file, row });
    }
  }
  return { selection: next, added };
}

// ------------------------------------------------------------------ the planter's edits

/** Number of fields of one delimited record (quote aware). */
function scanDelimitedFields(text, delim) {
  const dc = delim.charCodeAt(0);
  let n = 1;
  let inQ = false;
  let fieldStart = true;
  for (let j = 0; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (inQ) {
      if (c === 34) {
        if (text.charCodeAt(j + 1) === 34) j++;
        else inQ = false;
      }
      continue;
    }
    if (c === 34 && fieldStart) {
      inQ = true;
      fieldStart = false;
      continue;
    }
    if (c === dc) n++;
    fieldStart = c === dc;
  }
  return inQ ? -1 : n;
}

function countOf(s, ch) {
  let n = 0;
  for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

/** True when the edited row still has the shape of its kind (same fields / still parses / same line breaks). */
function rowShapeOk(kind, delim, oldRow, newRow) {
  if (countOf(oldRow, '\n') !== countOf(newRow, '\n')) return false;
  if (kind === 'csv' || kind === 'tsv') {
    const a = scanDelimitedFields(oldRow, delim);
    const b = scanDelimitedFields(newRow, delim);
    if (b === -1 || a !== b) return false;
    return scanDelimited(newRow, delim).length === 1;
  }
  if (kind === 'jsonl' || kind === 'json') {
    let oldOk = true;
    try {
      JSON.parse(oldRow);
    } catch {
      oldOk = false;
    }
    if (!oldOk) return true;
    try {
      JSON.parse(newRow);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * makeSampleGuard(dir, selection) -> { has(rel), check(rel, index, length, replacement) -> { ok, error? } }
 * check(): an edit of `length` characters at `index` of the file's text must lie inside one sampled
 * row and leave that row with the same shape (same number of fields and line breaks, still valid
 * JSON), so the row numbers of the selection stay true after the edit. A file that is not in the
 * selection is unrestricted.
 */
export function makeSampleGuard(dir, selection) {
  const cache = new Map();
  const unsampled = new Set((selection?.unsampled ?? []).map((u) => u.file));
  const get = (rel) => {
    if (!cache.has(rel)) {
      const entry = entryOf(selection, rel);
      cache.set(rel, entry ? { entry, chosen: new Set(entry.chosen), f: scanFile(dir, rel) } : null);
    }
    return cache.get(rel);
  };
  return {
    has: (rel) => !!get(String(rel).replace(/\\/g, '/')) || unsampled.has(String(rel).replace(/\\/g, '/')),
    check(relIn, index, length, replacement) {
      const rel = String(relIn).replace(/\\/g, '/');
      if (unsampled.has(rel)) return { ok: false, error: `outside-sample: ${rel} is too big to be read whole and cannot be sampled, so the reviewers will only spot-check it; put the edit in another file` };
      const g = get(rel);
      if (!g) return { ok: true };
      if (!g.f) return { ok: false, error: `outside-sample: ${rel} cannot be read as a data file` };
      const ri = rowIndexAt(g.f.scan, index);
      const row = ri === -1 ? null : g.f.scan.rows[ri];
      if (!row || index + length > row.end) return { ok: false, error: `outside-sample: the edit in ${rel} is not inside one data row` };
      if (!g.chosen.has(ri + 1)) return { ok: false, error: `outside-sample: row ${ri + 1} of ${rel} is not among the rows read for this check; choose a row listed in the sample file` };
      const oldRow = g.f.text.slice(row.start, row.end);
      const newRow = oldRow.slice(0, index - row.start) + String(replacement ?? '') + oldRow.slice(index - row.start + length);
      if (!rowShapeOk(g.f.kind, g.f.scan.delimiter, oldRow, newRow)) return { ok: false, error: `row-shape: the edit would change the number of fields or line breaks of row ${ri + 1} of ${rel}, or break its format` };
      return { ok: true, row: ri + 1 };
    },
  };
}

/** Throws when a planted file no longer has the rows the selection counted. */
export function assertStructure(dir, selection) {
  for (const entry of selection?.files ?? []) {
    const f = scanFile(dir, entry.file);
    if (!f || f.scan.rows.length !== entry.rows) {
      throw new Error(`the rows of ${entry.file} changed while the review copy was prepared (${f ? f.scan.rows.length : 'unreadable'} rows, ${entry.rows} expected)`);
    }
  }
}

// ------------------------------------------------------------------ what reviewers get

/** The text of one sample file (markdown): the header and the chosen rows with their row and line numbers. */
export function renderSampleFile(dir, entry, name) {
  const f = scanFile(dir, entry.file);
  if (!f) throw new Error(`cannot read ${entry.file} to render its sample`);
  const out = [];
  out.push(`# Rows to read in ${entry.file}`);
  out.push('');
  out.push(`The file has ${entry.rows} data rows${entry.header ? ' and a header' : ''}. The program drew ${entry.chosen.length} of them at random; they are listed below, in file order, exactly as stored (${name}).`);
  out.push('Row numbers count data rows from 1 (the header is not counted); "line" is the line number in the file.');
  out.push('');
  if (f.scan.header) {
    out.push(`## Header (line ${f.scan.header.line})`);
    out.push('');
    out.push(f.text.slice(f.scan.header.start, f.scan.header.end));
    out.push('');
  }
  for (const rowNo of entry.chosen) {
    const r = f.scan.rows[rowNo - 1];
    if (!r) continue;
    out.push(`## Row ${rowNo} (line ${r.line})`);
    out.push('');
    out.push(f.text.slice(r.start, r.end));
    out.push('');
  }
  return out.join('\n');
}

/** Receipt lines of one sampled file: [{ line, text }] (header and rows that sit on one line, 8..300 characters). */
export function sampleReceiptLines(dir, entry) {
  const f = scanFile(dir, entry.file);
  if (!f) return [];
  const out = [];
  const take = (r) => {
    const t = f.text.slice(r.start, r.end);
    if (t.includes('\n')) return;
    if (normalizeLine(t).length >= RECEIPT_MIN && t.length <= RECEIPT_MAX) out.push({ line: r.line, text: t });
  };
  if (f.scan.header) take(f.scan.header);
  for (const rowNo of entry.chosen) if (f.scan.rows[rowNo - 1]) take(f.scan.rows[rowNo - 1]);
  return out;
}

/**
 * sampleView(dir, selection) -> {
 *   entries: [{ file, name, entry, rows, sampled }]   name = SAMPLE-<k>.md in the job folder,
 *   byRel: Map(rel -> entry),
 *   unsampledByRel: Map(rel -> { file, kind, bytes, grouped? })   big files that cannot be sampled,
 *   files: [{ name, content }]                        what is written next to PROMPT.md,
 *   receiptLines: Map(rel -> [{ line, text }]) }
 * Rendered from the copy as it is now (the planted one for reviewers), cached per directory + selection.
 */
export function sampleView(dir, selection) {
  if (!selection || (!(selection.files ?? []).length && !(selection.unsampled ?? []).length)) return null;
  const key = `${dir}|${sampleHash(selection)}`;
  const hit = viewCache.get(key);
  if (hit) return hit;
  const entries = [];
  const files = [];
  const receiptLines = new Map();
  selection.files.forEach((entry, i) => {
    const name = `SAMPLE-${i + 1}.md`;
    entries.push({ file: entry.file, name, entry, rows: entry.rows, sampled: entry.chosen.length });
    files.push({ name, content: renderSampleFile(dir, entry, name) });
    receiptLines.set(entry.file, sampleReceiptLines(dir, entry));
  });
  // a file that cannot be sampled gives no receipt lines: nobody can be asked to find a line in it
  for (const u of selection.unsampled ?? []) receiptLines.set(u.file, []);
  const view = { entries, byRel: new Map(entries.map((e) => [e.file, e])), unsampledByRel: new Map((selection.unsampled ?? []).map((u) => [u.file, u])), files, receiptLines };
  viewCache.set(key, view);
  return view;
}

/** Token a prompt value uses for a file in the job folder; issueJob replaces it with the real path. */
export const JOB_FILE_RE = /<<JOB_FILE:([A-Za-z0-9._-]+)>>/g;
export const jobFile = (name) => `<<JOB_FILE:${name}>>`;

function kb(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function groupNote(g) {
  return g ? `; it is one of ${g.files} files of the same kind in its folder that together are ${kb(g.bytes)}, so they are treated as one data set` : '';
}

/** A note after a file line of the material list: how a large data file is reviewed. */
export function annotateForReviewer(view) {
  return (rel) => {
    const e = view?.byRel.get(rel);
    if (!e) {
      const u = view?.unsampledByRel?.get(rel);
      if (!u) return '';
      return ` — LARGE DATA FILE THAT CANNOT BE SAMPLED (${kb(u.bytes)}, .${u.kind}): this file is too big to read whole and has no rows to draw; check its structure and spot-check it, and write what you did not read under notChecked${groupNote(u.grouped)}`;
    }
    return ` — LARGE DATA FILE (${kb(e.entry.bytes)}, ${e.rows} rows): not read whole; its sample is ${jobFile(e.name)} (${e.sampled} rows drawn at random by the program)${groupNote(e.entry.grouped)}`;
  };
}

export function annotateForPlanter(view) {
  return (rel) => {
    const e = view?.byRel.get(rel);
    if (!e) {
      const u = view?.unsampledByRel?.get(rel);
      return u ? ` — LARGE DATA FILE THAT CANNOT BE SAMPLED (${kb(u.bytes)}): too big to be read whole; do not put an edit here, it is refused` : '';
    }
    return ` — LARGE DATA FILE (${kb(e.entry.bytes)}, ${e.rows} rows): put an edit here only inside a row listed in ${jobFile(e.name)}; an edit in any other row is refused. "before" must still occur exactly once in the whole file, so include the row's identifier`;
  };
}

/** A note for the lens writer (setup): which files are large data files and how they will be reviewed. */
export function annotateForLensWriter(large, settings, unsampled = []) {
  const byRel = new Map(large.map((x) => [x.file, x]));
  const bigRel = new Map(unsampled.map((x) => [x.file, x]));
  return (rel) => {
    const x = byRel.get(rel);
    if (!x) {
      const u = bigRel.get(rel);
      if (!u) return '';
      return ` — LARGE DATA FILE THAT CANNOT BE SAMPLED (${kb(u.bytes)}, .${u.kind}): reviewers cannot read it whole and get no rows drawn from it; do not make "every line" of it their duty, ask them to check its structure and spot-check it${groupNote(u.grouped)}`;
    }
    return ` — LARGE DATA FILE (${kb(x.bytes)}, ${x.rows} rows): reviewers read a random sample of at most ${settings.rows} rows, drawn by the program each time, not the whole file${groupNote(x.grouped)}`;
  };
}

/** What the report says: per file, how many rows were in the sample and how many the file has. */
export function coverageOf(selection) {
  return (selection?.files ?? []).map((e) => ({ file: e.file, rows: e.rows, sampled: e.chosen.length }));
}

/** Big files of the selection that were not sampled at all: [{ file, kind, bytes, grouped? }]. */
export function unsampledOf(selection) {
  return (selection?.unsampled ?? []).map((u) => ({ ...u }));
}

/**
 * dataFilesOfRun(run, manifest, settings?) -> { large: [{ file, kind, bytes, rows, grouped? }], unsampled: [{ file, kind, bytes, grouped? }] }
 * The large data files of the live material (before any round exists): the lens writer is told about
 * them and the owner's summary lists them. `file` is the manifest path (<root name>/...). Groups
 * (files of one kind in one folder that are each small and together big) are found per manifest folder.
 */
export function dataFilesOfRun(run, manifest, settings = samplingSettings(run)) {
  const entries = [];
  for (const f of manifest?.files ?? []) {
    const [as, ...rest] = String(f.rel).split('/');
    const root = (run.material?.roots ?? []).find((r) => r.as === as);
    if (!root || !rest.length) continue;
    entries.push({ key: f.rel, dir: root.path, rel: rest.join('/') });
  }
  const cls = classifyEntries(entries, settings);
  return {
    large: cls.large.map((x) => ({ file: x.key, kind: x.f.kind, bytes: x.f.bytes, rows: x.f.scan.rows.length, ...(x.grouped ? { grouped: x.grouped } : {}) })),
    unsampled: cls.unsampled.map((x) => ({ file: x.file, kind: x.kind, bytes: x.bytes, ...(x.grouped ? { grouped: x.grouped } : {}) })),
  };
}

/** The large (sampled) data files of the live material, see dataFilesOfRun. */
export function largeDataFilesOfRun(run, manifest, settings = samplingSettings(run)) {
  return dataFilesOfRun(run, manifest, settings).large;
}
