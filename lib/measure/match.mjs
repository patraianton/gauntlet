// Matching reviewer findings to planted errors (SPEC 14.6).
//
// Stage 1 is code. A (finding, canary) pair is a candidate when the finding cites the
// canary's file and
//   - its normalised quote and the canary's `after` overlap by >= 60 % of the shorter
//     string, or share a substring of >= 8 characters that contains changed characters; or
//   - the locators are equal; or
//   - for omission canaries: the quote lies within 200 characters of the removal point,
//     or the finding is an omission whose text overlaps the removed text by >= 8 characters.
// A candidate whose finding text (problem + quotes) contains a distinctive changed token
// is decided by code. Other candidates, and (canary x target-lens job) cells with no
// candidate but findings in the canary's file, go to the matcher agent (score >= 3 = same).
//
// Two documented extensions (deviations recorded in the package hand-over):
//   - a finding in ANOTHER file whose quote shares >= 8 changed characters with `after`
//     goes to the matcher (generated pages often mirror a source file); never decided by code;
//   - a VISUAL canary (or one on a binary file) sends every finding in its file, and every
//     `visual` finding, to the matcher; there is no text to compare.
//
// Outcome per (canary x reviewer job): caught (matched, severity >= floor),
// seen_underclassified (matched below the floor), missed.

import { normalizeQuote } from '../material/lint.mjs';
import { fileKind } from '../core/hash.mjs';
import { loadTaxonomy } from './taxonomy.mjs';
import { readCopyFile, severityRank, BINARY_AFTER_PREFIX } from './canary.mjs';

export const OVERLAP_SHARE = 0.6;
export const CHANGED_SUBSTRING = 8;
export const OMISSION_RADIUS = 200;
export const MATCHER_SAME = 3;
const MIN_QUOTE = 4;

// ------------------------------------------------------------------ outcome

/** outcome(severityGiven, floor, matched) -> 'caught' | 'seen_underclassified' | 'missed' */
export function outcome(severityGiven, floor, matched) {
  if (!matched) return 'missed';
  return severityRank(severityGiven) >= severityRank(floor ?? 'major') ? 'caught' : 'seen_underclassified';
}

// ------------------------------------------------------------------ text helpers

function norm(s) {
  return normalizeQuote(s ?? '').toLowerCase();
}

function normLocator(s) {
  return norm(s).replace(/\s+/g, ' ');
}

function relOf(f) {
  return String(f ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Common prefix / suffix lengths of two strings (suffix never overlaps the prefix). */
export function commonEnds(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { prefix: p, suffix: s };
}

/**
 * Longest common substring of q and a, plus the longest one that touches the changed
 * span [cs, ce) of a (for a pure deletion, ce === cs: the substring must cross the join).
 */
export function commonSubstrings(q, a, cs, ce) {
  let maxLen = 0;
  let maxChanged = 0;
  if (!q.length || !a.length) return { maxLen, maxChanged };
  let prev = new Uint16Array(a.length + 1);
  let cur = new Uint16Array(a.length + 1);
  for (let i = 1; i <= q.length; i++) {
    const qc = q.charCodeAt(i - 1);
    for (let j = 1; j <= a.length; j++) {
      if (qc === a.charCodeAt(j - 1)) {
        const L = prev[j - 1] + 1;
        cur[j] = L;
        if (L > maxLen) maxLen = L;
        const start = j - L;
        const touches = ce > cs ? start < ce && j > cs : start < cs && j > cs;
        if (touches && L > maxChanged) maxChanged = L;
      } else cur[j] = 0;
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return { maxLen, maxChanged };
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokens(s) {
  return new Set((norm(s).match(TOKEN_RE) ?? []).filter((t) => /^\p{N}+$/u.test(t) || t.length >= 3));
}

/** Tokens present in `after` but not `before`, and vice versa. */
export function distinctiveTokens(before, after) {
  const tb = tokens(before);
  const ta = tokens(after);
  const out = new Set();
  for (const t of ta) if (!tb.has(t)) out.add(t);
  for (const t of tb) if (!ta.has(t)) out.add(t);
  return out;
}

/**
 * The reviewer's own words about the problem. The quote is left out on purpose: a reviewer who
 * quotes the planted line while complaining about something else copies the changed token into the
 * quote, and that alone must not count as catching the planted error (such pairs go to the matcher,
 * which can also keep the finding as a real problem with alsoReal).
 */
function findingText(f) {
  return [f.problem, f.missingWhat, f.seen].filter((x) => typeof x === 'string').join(' ');
}

function isVisualCanary(c, taxonomy) {
  const t = taxonomy.byId(c.type);
  return Boolean(t?.needsRebuild) || String(c.after ?? '').startsWith(BINARY_AFTER_PREFIX) || !['text', 'json', 'html'].includes(fileKind(c.file ?? ''));
}

/** The severity a planted error is meant to be reported at: the smallest class that counts as caught. */
export function floorOf(c, taxonomy) {
  return c.severityFloor ?? taxonomy.byId(c.type)?.defaultFloor ?? 'major';
}

// ------------------------------------------------------------------ canary analysis

function analyseCanary(c, copyDir, taxonomy) {
  const nb = norm(c.before);
  const na = norm(c.after);
  const { prefix, suffix } = commonEnds(nb, na);
  const changedStart = prefix;
  const changedEnd = Math.max(prefix, na.length - suffix);
  const removed = nb.slice(prefix, Math.max(prefix, nb.length - suffix));
  const type = taxonomy.byId(c.type);
  const visual = isVisualCanary(c, taxonomy);
  let fileNorm = null;
  let removalPoints = [];
  if (type?.omission && copyDir && !visual && na.length > 0) {
    try {
      const { text } = readCopyFile(copyDir, relOf(c.file));
      fileNorm = norm(text);
      let i = fileNorm.indexOf(na);
      while (i !== -1) {
        removalPoints.push(i + prefix);
        i = fileNorm.indexOf(na, i + 1);
      }
    } catch {
      fileNorm = null;
      removalPoints = [];
    }
  }
  return {
    c,
    file: relOf(c.file),
    na,
    changedStart,
    changedEnd,
    removed,
    omission: Boolean(type?.omission),
    visual,
    floor: floorOf(c, taxonomy),
    distinct: visual ? new Set() : distinctiveTokens(c.before, c.after),
    fileNorm,
    removalPoints,
  };
}

function quoteHits(info, quote) {
  const nq = norm(quote);
  if (nq.length < MIN_QUOTE || !info.na.length) return { overlap: false, changed: false };
  const { maxLen, maxChanged } = commonSubstrings(nq, info.na, info.changedStart, info.changedEnd);
  const shorter = Math.min(nq.length, info.na.length);
  return { overlap: maxLen >= OVERLAP_SHARE * shorter, changed: maxChanged >= CHANGED_SUBSTRING };
}

function nearRemoval(info, quote) {
  if (!info.fileNorm || !info.removalPoints.length) return false;
  const nq = norm(quote);
  if (nq.length < MIN_QUOTE) return false;
  let i = info.fileNorm.indexOf(nq);
  while (i !== -1) {
    const end = i + nq.length;
    for (const rp of info.removalPoints) {
      const d = rp < i ? i - rp : rp > end ? rp - end : 0;
      if (d <= OMISSION_RADIUS) return true;
    }
    i = info.fileNorm.indexOf(nq, i + 1);
  }
  return false;
}

/** Why a finding is a candidate for a canary: 'same-file' | 'cross-file' | null. */
function candidateKind(info, f) {
  const frel = relOf(f?.location?.file);
  const quotes = [f.quote, f.quote2].filter((q) => typeof q === 'string' && q.trim());
  if (info.visual) {
    if (frel === info.file || f.kind === 'visual') return 'same-file';
    return null;
  }
  if (frel === info.file) {
    for (const q of quotes) {
      const h = quoteHits(info, q);
      if (h.overlap || h.changed) return 'same-file';
    }
    const fl = normLocator(f?.location?.locator);
    if (fl && fl === normLocator(info.c.locator)) return 'same-file';
    if (info.omission) {
      for (const q of quotes) if (nearRemoval(info, q)) return 'same-file';
      if ((f.kind === 'omission' || typeof f.missingWhat === 'string') && info.removed.length >= CHANGED_SUBSTRING) {
        const t = norm([f.missingWhat, f.problem].filter(Boolean).join(' '));
        const { maxLen } = commonSubstrings(t, info.removed, 0, 0);
        if (maxLen >= CHANGED_SUBSTRING) return 'same-file';
      }
    }
    return null;
  }
  for (const q of quotes) if (quoteHits(info, q).changed) return 'cross-file';
  return null;
}

function hasDistinctive(info, f) {
  if (!info.distinct.size) return false;
  const ft = tokens(findingText(f));
  for (const t of info.distinct) if (ft.has(t)) return true;
  return false;
}

function jobsOf(findingsByJob) {
  if (Array.isArray(findingsByJob)) return findingsByJob.map((j) => ({ ...j, findings: j.findings ?? [] }));
  return Object.entries(findingsByJob ?? {}).map(([job, v]) => ({ job, ...v, findings: v?.findings ?? [] }));
}

function row(info, j, fields) {
  return {
    canary: info.c.canary,
    purpose: info.c.purpose,
    targetLens: info.c.targetLens ?? null,
    lens: j.lens ?? null,
    job: j.job,
    attempt: j.attempt ?? 1,
    outcome: fields.outcome,
    finding: fields.finding ?? null,
    stage: fields.stage ?? null,
    matcherScore: fields.matcherScore ?? null,
    severityGiven: fields.severityGiven ?? null,
  };
}

function bestBySeverity(list) {
  return [...list].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || Number(a.n) - Number(b.n))[0];
}

function findingView(job, f) {
  return {
    finding: `${job}#${f.n}`,
    n: f.n,
    severity: f.severity ?? null,
    file: relOf(f?.location?.file),
    locator: f?.location?.locator ?? '',
    quote: f.quote ?? null,
    problem: f.problem ?? '',
  };
}

/**
 * stage1(canaries, findingsByJob, { copyDir, taxonomy? }) -> { decided, needMatcher, unmatched }
 *   canaries      key.canaries (revealed)
 *   findingsByJob { "<job>": { lens, attempt, findings } } or [{ job, lens, attempt, findings }]
 *                 (kept reviewer answers of the wave; findings as in answer-reviewer)
 *   copyDir       the planted review copy (needed for the omission distance rule)
 *   decided       detection rows (SPEC 9.11) settled by code
 *   needMatcher   one item per undecided (canary x job): { canary, job, lens, attempt, purpose,
 *                 targetLens, floor, findings: [findingView], fallback: detection|null }
 *   unmatched     canary ids no job matched or sent to the matcher (missed by everyone so far)
 */
export function stage1(canaries, findingsByJob, opts = {}) {
  const taxonomy = opts.taxonomy ?? loadTaxonomy();
  const jobs = jobsOf(findingsByJob);
  const decided = [];
  const needMatcher = [];
  const unmatched = [];
  for (const c of canaries ?? []) {
    const info = analyseCanary(c, opts.copyDir ?? null, taxonomy);
    let anyHit = false;
    for (const j of jobs) {
      const codeMatched = [];
      const toMatcher = [];
      for (const f of j.findings) {
        if (!f || f.n === undefined) continue;
        const kind = candidateKind(info, f);
        if (!kind) continue;
        if (kind === 'same-file' && !info.visual && hasDistinctive(info, f)) codeMatched.push(f);
        else toMatcher.push(f);
      }
      let fallback = null;
      if (codeMatched.length) {
        const best = bestBySeverity(codeMatched);
        const out = outcome(best.severity, info.floor, true);
        const d = row(info, j, { outcome: out, finding: best.n, stage: 'code', severityGiven: best.severity ?? null });
        const better = toMatcher.filter((f) => severityRank(f.severity) > severityRank(best.severity));
        if (out === 'caught' || better.length === 0) {
          decided.push(d);
          anyHit = true;
          continue;
        }
        fallback = d;
        toMatcher.length = 0;
        toMatcher.push(...better);
      }
      if (!toMatcher.length && j.lens && j.lens === info.c.targetLens) {
        for (const f of j.findings) if (f && relOf(f?.location?.file) === info.file) toMatcher.push(f);
      }
      if (toMatcher.length) {
        anyHit = true;
        needMatcher.push({
          canary: c.canary,
          job: j.job,
          lens: j.lens ?? null,
          attempt: j.attempt ?? 1,
          purpose: c.purpose,
          targetLens: c.targetLens ?? null,
          floor: info.floor,
          findings: toMatcher.map((f) => findingView(j.job, f)),
          fallback,
        });
        continue;
      }
      decided.push(row(info, j, { outcome: 'missed' }));
    }
    if (!anyHit) unmatched.push(c.canary);
  }
  return { decided, needMatcher, unmatched };
}

/**
 * buildMatcherPairs(needMatcher, canaries) -> [{ canary, description, file, locator, before, after,
 *   findings: [{ finding, file, locator, quote, problem }] }]
 * One entry per canary; the matcher sees canary descriptions and findings only (SPEC 5.2).
 */
export function buildMatcherPairs(needMatcher, canaries) {
  const byId = new Map((canaries ?? []).map((c) => [c.canary, c]));
  const out = new Map();
  for (const item of needMatcher ?? []) {
    const c = byId.get(item.canary) ?? {};
    if (!out.has(item.canary)) {
      out.set(item.canary, {
        canary: item.canary,
        description: c.description ?? '',
        file: relOf(c.file),
        locator: c.locator ?? '',
        before: c.before ?? '',
        after: c.after ?? '',
        findings: [],
      });
    }
    const entry = out.get(item.canary);
    for (const f of item.findings) {
      if (entry.findings.some((x) => x.finding === f.finding)) continue;
      entry.findings.push({ finding: f.finding, file: f.file, locator: f.locator, quote: f.quote, problem: f.problem });
    }
  }
  return [...out.values()];
}

/**
 * mergeMatcher(decided, matcherAnswer, needMatcher?) -> detections
 * needMatcher defaults to decided.pending (if the caller attached it). A null matcher
 * answer (agent died) settles every pending cell as its code fallback or `missed`
 * (fail-closed: an unconfirmed catch is a miss).
 */
export function mergeMatcher(decided, matcherAnswer, needMatcher) {
  const pending = needMatcher ?? decided?.pending ?? [];
  const pairs = Array.isArray(matcherAnswer?.pairs) ? matcherAnswer.pairs : [];
  const out = [...(decided ?? [])];
  for (const item of pending) {
    const scores = new Map();
    for (const p of pairs) {
      if (p?.canary !== item.canary || typeof p.finding !== 'string') continue;
      const s = Number(p.score);
      if (!scores.has(p.finding) || s > scores.get(p.finding)) scores.set(p.finding, s);
    }
    const matched = item.findings.filter((f) => (scores.get(f.finding) ?? 0) >= MATCHER_SAME);
    const base = { canary: item.canary, purpose: item.purpose, targetLens: item.targetLens, lens: item.lens, job: item.job, attempt: item.attempt };
    if (matched.length) {
      const best = [...matched].sort(
        (a, b) => severityRank(b.severity) - severityRank(a.severity) || (scores.get(b.finding) ?? 0) - (scores.get(a.finding) ?? 0),
      )[0];
      const m = {
        ...base,
        outcome: outcome(best.severity, item.floor, true),
        finding: best.n,
        stage: 'matcher',
        matcherScore: scores.get(best.finding),
        severityGiven: best.severity ?? null,
      };
      if (item.fallback && severityRank(item.fallback.severityGiven) > severityRank(m.severityGiven)) out.push(item.fallback);
      else out.push(m);
      continue;
    }
    if (item.fallback) out.push(item.fallback);
    else {
      const seen = item.findings.map((f) => scores.get(f.finding)).filter((s) => typeof s === 'number');
      out.push({ ...base, outcome: 'missed', finding: null, stage: null, matcherScore: seen.length ? Math.max(...seen) : null, severityGiven: null });
    }
  }
  out.sort((a, b) => cmpCanary(a.canary, b.canary) || String(a.job).localeCompare(String(b.job)) || a.attempt - b.attempt);
  return out;
}

function cmpCanary(a, b) {
  const na = Number(String(a).replace(/^\D+/, ''));
  const nb = Number(String(b).replace(/^\D+/, ''));
  return na - nb;
}

/**
 * findingsMatched(detections, matcherAnswer) -> { remove: ["<job>#<n>"], alsoReal: ["<job>#<n>"] }
 * Findings matched to a canary leave the real-issue pipeline unless the matcher marked
 * the pair `alsoReal` (SPEC 11.6 step 1, 14.6).
 */
export function findingsMatched(detections, matcherAnswer) {
  const alsoReal = new Set();
  for (const p of matcherAnswer?.pairs ?? []) if (p?.alsoReal === true && typeof p.finding === 'string') alsoReal.add(p.finding);
  const remove = new Set();
  for (const d of detections ?? []) {
    if (d.finding === null || d.finding === undefined || d.outcome === 'missed') continue;
    const id = `${d.job}#${d.finding}`;
    if (!alsoReal.has(id)) remove.add(id);
  }
  return { remove: [...remove], alsoReal: [...alsoReal] };
}

/** Pair counts of one round: { caught, underclassified, missed, total }. */
export function pairCounts(detections) {
  const r = { caught: 0, underclassified: 0, missed: 0, total: 0 };
  for (const d of detections ?? []) {
    r.total++;
    if (d.outcome === 'caught') r.caught++;
    else if (d.outcome === 'seen_underclassified') r.underclassified++;
    else r.missed++;
  }
  return r;
}

