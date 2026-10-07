// Meta mentions of a reviewer answer, with the honest exceptions (SPEC 12.1 step 5, 12.2).
//
// catalog/meta-mention-patterns.json lists words that show a reviewer talking about planted or test
// errors ("canary", "attention check", "planted error", ...). A hit makes the attempt invalid. But a
// reviewer who reads the work also reads text that happens to contain such a word: in one early run the
// staging site's source code had an anti-bot form field called "honeypot", reviewers quoted it, 13 answers
// were thrown out as "talks about the check itself", and no round was ever fully valid.
//
// A hit is therefore excused ONLY when the engine itself can show where the text comes from:
//   1. quoted-material / quoted-source - the hit with at least META_MIN_CONTEXT characters of
//      context around it (taken from inside the quotation marks or the line it stands in) occurs
//      VERBATIM (after the quote normaliser of SPEC 12.3) in a file of the review copy, or in the
//      output of a primary source that the engine ran at the start of the round. Being inside a
//      "quote" field or inside quotation marks is not enough: the text must really be there.
//   2. search-term - the hit is in the `command` of a sourceChecks entry that filters a source
//      output (grep, rg, findstr, ...), and the matched word really occurs in that source's output
//      (a reviewer searching a source for a word the source contains).
//   3. term-in-material - only for patterns marked "quotableTerm" in the catalog (the word
//      "honeypot"): the whole word occurs in the review copy or in a source output, so the material
//      itself uses it and the reviewer's use of it says nothing about planted errors. Every other
//      pattern ("canary", "planted error", "attention check", ...) never gets this exception.
// Every excused hit is returned in `ignored` (with how and from where), is stored in the ingest record
// and is counted in the report; a hit that cannot be excused stays a hit.

import path from 'node:path';
import { scanString, normalizeQuote, searchableTexts } from './lint.mjs';
import { listFiles } from '../core/fsx.mjs';

/** Characters of context taken on each side of a hit, tried from the widest to the narrowest. */
export const META_CONTEXT_RADII = Object.freeze([24, 16, 12]);
/** Context characters (besides the matched text) a verbatim window must have. */
export const META_MIN_CONTEXT = 8;
/** Longest quotation (characters) that counts as one quoted span. */
const MAX_SPAN = 600;
/** Most entries kept in `ignored`. */
const MAX_IGNORED = 40;

const FILTER_RE = /(?:^|[\s|;&(])(?:grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls|sed|awk|jq)(?=[\s"'-]|$)/i;

/** Every string value of an answer with a readable name: [{ name, text }]. Keys are not scanned. */
function answerStrings(value, name = 'answer') {
  const out = [];
  const walk = (v, n) => {
    if (typeof v === 'string') out.push({ name: n, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${n}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${n}.${k}`);
  };
  walk(value, name);
  return out;
}

const SYMMETRIC = ['"', '`'];
const ASYMMETRIC = [['«', '»'], ['“', '”']];

/** The quoted span (inner [from, to)) that contains [s, e), the narrowest one; or null. */
function quotedSpan(T, s, e) {
  let best = null;
  const consider = (from, to) => {
    if (to - from > MAX_SPAN) return;
    if (!best || from > best.from) best = { from, to };
  };
  for (const ch of SYMMETRIC) {
    const l = T.lastIndexOf(ch, s - 1);
    if (l < 0) continue;
    const r = T.indexOf(ch, e);
    if (r < 0) continue;
    let before = 0;
    for (let i = 0; i < l; i++) if (T[i] === ch) before += 1;
    if (before % 2 !== 0) continue;
    consider(l + 1, r);
  }
  for (const [open, close] of ASYMMETRIC) {
    const l = T.lastIndexOf(open, s - 1);
    if (l < 0) continue;
    const r = T.indexOf(close, e);
    if (r < 0) continue;
    if (T.slice(l + 1, s).includes(close)) continue;
    consider(l + 1, r);
  }
  return best;
}

/** The text unit a hit stands in: its quoted span, else its line without a leading "74:" line number. */
function unitOf(T, s, e) {
  const q = quotedSpan(T, s, e);
  if (q) return q;
  const ls = T.lastIndexOf('\n', s - 1) + 1;
  const nl = T.indexOf('\n', e);
  const le = nl < 0 ? T.length : nl;
  let from = ls;
  const m = /^\s*\d+\s*[:|-]\s*/.exec(T.slice(ls, le));
  if (m && ls + m[0].length <= s) from = ls + m[0].length;
  return { from, to: le };
}

/** Candidate verbatim windows of one hit, widest first (normalised, de-duplicated). */
function windowsOf(T, s, e) {
  const u = unitOf(T, s, e);
  const hitLen = normalizeQuote(T.slice(s, e)).length;
  const out = [];
  for (const R of META_CONTEXT_RADII) {
    const w = normalizeQuote(T.slice(Math.max(u.from, s - R), Math.min(u.to, e + R)));
    if (w.length - hitLen < META_MIN_CONTEXT) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function wordRegex(term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * Look up windows (verbatim, case kept) and terms (whole word, case-insensitive) in the sources and
 * then in the files of the copy, in ONE pass over the material. -> { windows: Map, terms: Map,
 * sourceHas(id, term) } ; an origin is { kind: 'source', id } or { kind: 'material', file }.
 */
function searchCorpus({ copyDir, sources }, windows, terms) {
  const foundW = new Map();
  const foundT = new Map();
  const termRes = new Map([...terms].map((t) => [t, wordRegex(t)]));
  const srcNorm = (sources || []).map((s) => ({ id: s.id, norm: normalizeQuote(s.text) }));
  const pending = () => [...windows].some((w) => !foundW.has(w)) || [...terms].some((t) => !foundT.has(t));
  const test = (norm, origin) => {
    for (const w of windows) if (!foundW.has(w) && norm.includes(w)) foundW.set(w, origin);
    for (const [t, re] of termRes) if (!foundT.has(t) && re.test(norm)) foundT.set(t, origin);
  };
  for (const s of srcNorm) test(s.norm, { kind: 'source', id: s.id });
  if (copyDir && pending()) {
    for (const rel of listFiles(copyDir)) {
      for (const t of searchableTexts(path.join(copyDir, ...rel.split('/')), rel)) test(t, { kind: 'material', file: rel });
      if (!pending()) break;
    }
  }
  return {
    windows: foundW,
    terms: foundT,
    sourceHas(id, term) {
      const s = srcNorm.find((x) => x.id === id);
      return !!s && wordRegex(term).test(s.norm);
    },
  };
}

/**
 * metaScan(answer, { patterns, copyDir?, sources? }) -> { hits, ignored, ignoredTotal }
 * hits: [{ name, patternId, text }] - mentions that stay (they invalidate the attempt)
 * ignored: [{ name, patternId, text, how, from }] - mentions the engine could show to come from the
 * material or from a primary source (see the header); `from` is "material:<file>" or "source:<id>".
 * ignoredTotal: how many hits were excused in all (the list `ignored` keeps at most MAX_IGNORED distinct entries).
 * sources: [{ id, text }] raw outputs of the primary sources of this round (see readSourceTexts).
 * A failure while reading the material never excuses anything: the hit stays.
 */
export function metaScan(answer, { patterns, copyDir = null, sources = [] } = {}) {
  const raw = [];
  for (const { name, text } of answerStrings(answer)) {
    for (const h of scanString(text, patterns, [], ['both', 'content'])) {
      raw.push({ name, T: text, index: h.index, text: h.text, patternId: h.patternId });
    }
  }
  if (raw.length === 0) return { hits: [], ignored: [], ignoredTotal: 0 };
  const byId = new Map(patterns.map((p) => [p.id, p]));
  const withWindows = raw.map((h) => ({ ...h, windows: windowsOf(h.T, h.index, h.index + h.text.length) }));
  const windows = new Set(withWindows.flatMap((h) => h.windows));
  const terms = new Set(withWindows.filter((h) => byId.get(h.patternId)?.quotableTerm === true).map((h) => h.text.toLowerCase()));
  let corpus = null;
  try {
    corpus = searchCorpus({ copyDir, sources }, windows, terms);
  } catch {
    corpus = null;
  }
  const hits = [];
  const ignored = [];
  const keyOf = (o) => `${o.patternId}\0${o.text.toLowerCase()}\0${o.how}\0${o.from}`;
  const seen = new Map();
  // Every excused hit is counted in `ignoredTotal`, whatever the cap of the LIST: a hit beyond the
  // cap is still excused, so it must still show up in the number the ledger and the report carry.
  let ignoredTotal = 0;
  const excuse = (h, how, from) => {
    ignoredTotal += 1;
    const rec = { name: h.name, patternId: h.patternId, text: h.text, how, from };
    const k = keyOf(rec);
    const have = seen.get(k);
    if (have) have.count += 1;
    else if (ignored.length < MAX_IGNORED) {
      rec.count = 1;
      seen.set(k, rec);
      ignored.push(rec);
    }
  };
  const label = (o) => (o.kind === 'source' ? `source:${o.id}` : `material:${o.file}`);
  for (const h of withWindows) {
    let done = false;
    if (corpus) {
      // 1. the hit with its context is a verbatim quote
      for (const w of h.windows) {
        const o = corpus.windows.get(w);
        if (o) {
          excuse(h, o.kind === 'source' ? 'quoted-source' : 'quoted-material', label(o));
          done = true;
          break;
        }
      }
      // 2. a search term in a command that filters a source output which really contains it
      if (!done) {
        const m = /^answer\.sourceChecks\[(\d+)\]\.command$/.exec(h.name);
        if (m && FILTER_RE.test(h.T)) {
          const sid = answer?.sourceChecks?.[Number(m[1])]?.sourceId;
          if (typeof sid === 'string' && corpus.sourceHas(sid, h.text)) {
            excuse(h, 'search-term', `source:${sid}`);
            done = true;
          }
        }
      }
      // 3. a word the material itself uses (only for patterns that allow it)
      if (!done && byId.get(h.patternId)?.quotableTerm === true) {
        const o = corpus.terms.get(h.text.toLowerCase());
        if (o) {
          excuse(h, 'term-in-material', label(o));
          done = true;
        }
      }
    }
    if (!done) hits.push({ name: h.name, patternId: h.patternId, text: h.text });
  }
  return { hits, ignored, ignoredTotal };
}
