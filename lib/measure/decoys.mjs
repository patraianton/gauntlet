// Decoys: false findings mixed into verifier batches (SPEC 14.11).
//
// Verifiers almost never refuse an item (05-06.10: 55 of 66 and 103 of 108 confirmed, none refused in
// the build), so "the verifier confirmed it" says little unless we also know the verifier can say no.
// A decoy is a report of a problem that is NOT there. It quotes real text of the review copy (or says
// that something is missing that is in fact present) and carries its own proof: an exact quote from
// the copy that shows the claim is wrong. A separate agent (the decoy writer) proposes them while the
// reviewers work; code checks every proposal, keeps the key sealed in the data home until the round
// closes, and mixes the chosen decoys into the verifier items so that they look like any other item.
//
// What the verdicts on decoys do:
//   - they go to the run files and the cross-run ledger (decoys.jsonl): rejected / presented, with
//     Clopper-Pearson bounds like the canaries;
//   - a verifier job that CONFIRMS a decoy is untrusted: its confirmations of real items are not
//     applied; a fresh verifier re-checks them (see round.mjs afterVerify);
//   - a decoy never becomes a cluster, so it can never reach to-do.md or the owner's open problems.

import path from 'node:path';
import fs from 'node:fs';
import { fileKind } from '../core/hash.mjs';
import { loadPatterns, scanString, findQuote, normalizeQuote } from '../material/lint.mjs';

/** Candidates asked for beyond the number wanted, so code checks can reject some. */
export const DECOY_SPARES = 2;
export const MIN_PROOF_CHARS = 12;
const TEXT_KINDS = new Set(['text', 'json', 'html']);
const MAX_PER_BATCH_SHARE = 0.5;

/** How many decoys a run wants per round (0 = off). Old runs without the setting get the default. */
export function decoysWanted(run) {
  const v = run?.canaries?.decoysPerRound;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/** How many candidates the decoy writer is asked for. */
export function candidatesAsked(perRound) {
  return perRound + DECOY_SPARES;
}

function safeRel(rel) {
  const r = String(rel ?? '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.split('/').some((c) => c === '..' || c === '' || c === '.')) return null;
  return r;
}

function textFileOk(copyDir, rel) {
  if (!rel) return false;
  const abs = path.join(copyDir, ...rel.split('/'));
  try {
    return fs.statSync(abs).isFile() && TEXT_KINDS.has(fileKind(rel));
  } catch {
    return false;
  }
}

function foundIn(copyDir, rel, text) {
  const r = findQuote(copyDir, rel, text);
  return r.found && String(r.file).toLowerCase() === String(rel).toLowerCase();
}

function overlaps(a, b) {
  const x = normalizeQuote(a);
  const y = normalizeQuote(b);
  if (x.length < 4 || y.length < 4) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * Words that would tell a verifier the claim is not real. The catalogue's trace and meta patterns
 * cover review traces ("round 3", "TODO", talk about checking); these cover this feature's own words.
 */
const GIVEAWAYS = Object.freeze([
  { id: 'D-WORD', re: /\b(?:decoys?|dummy|fake|false (?:report|claim|finding|alarm)|not real|trap|honeypot|bait)\b/iu },
  { id: 'D-ASKED', re: /\b(?:i was asked|as requested|on purpose|mixed in|made up|invented)\b/iu },
  { id: 'D-RU', re: /(?:ловушк|приманк|фиктивн|заведомо|ложн(?:ое|ый|ая|ых)\s+(?:замечани|находк|срабатыван)|выдуман|придуман|специально)/iu },
]);

let patternCache = null;
function leakPatterns() {
  if (!patternCache) patternCache = [...loadPatterns('trace'), ...loadPatterns('meta')];
  return patternCache;
}

/**
 * validateDecoy(candidate, { copyDir, canaries, taken }) -> { ok, errors: [string] }
 *   canaries: the planted edits of this round ([{ file, after }]); a decoy may not touch them
 *   taken: decoys already accepted this round ([{ file, quote }]); no two decoys quote the same text
 */
export function validateDecoy(candidate, { copyDir, canaries = [], taken = [], patterns = null } = {}) {
  const c = candidate ?? {};
  const errors = [];
  const rel = safeRel(c.file);
  if (!rel || !textFileOk(copyDir, rel)) errors.push(`file-unusable: ${c.file}`);
  const proofRel = safeRel(c.proofFile);
  if (!proofRel || !textFileOk(copyDir, proofRel)) errors.push(`proof-file-unusable: ${c.proofFile}`);
  if (errors.length) return { ok: false, errors };

  const quote = String(c.quote ?? '');
  const missingWhat = String(c.missingWhat ?? '');
  if (c.kind === 'quote') {
    if (normalizeQuote(quote).length < MIN_PROOF_CHARS) errors.push('quote-too-short');
    else if (!foundIn(copyDir, rel, quote)) errors.push('quote-not-found-in-file');
    if (normalizeQuote(quote).length > 400) errors.push('quote-too-long');
  } else if (c.kind === 'missing') {
    if (missingWhat.trim().length < 10) errors.push('missing-what-too-short');
  } else {
    errors.push(`bad-kind: ${c.kind}`);
  }

  const proof = String(c.proofQuote ?? '');
  if (normalizeQuote(proof).length < MIN_PROOF_CHARS) errors.push('proof-too-short');
  else if (!foundIn(copyDir, proofRel, proof)) errors.push('proof-not-found-in-file');
  // A proof that is the quoted passage itself proves nothing about a claim made against it.
  if (c.kind === 'quote' && rel === proofRel && normalizeQuote(proof) === normalizeQuote(quote)) errors.push('proof-is-the-quote');

  // Not on a planted edit: the text there is wrong on purpose, so a claim about it may be true.
  for (const k of canaries) {
    const after = String(k?.after ?? '');
    if (!after || after.startsWith('sha256:')) continue;
    if (safeRel(k.file) === rel && c.kind === 'quote' && overlaps(quote, after)) errors.push('touches-a-planted-edit');
    if (safeRel(k.file) === proofRel && overlaps(proof, after)) errors.push('proof-touches-a-planted-edit');
  }
  for (const t of taken) {
    if (c.kind === 'quote' && t.kind === 'quote' && safeRel(t.file) === rel && normalizeQuote(t.quote) === normalizeQuote(quote)) errors.push('duplicate-quote');
    if (c.kind === 'missing' && t.kind === 'missing' && normalizeQuote(t.missingWhat) === normalizeQuote(missingWhat)) errors.push('duplicate-missing');
  }

  // Nothing in the words a verifier sees may betray the check.
  const pats = patterns ?? leakPatterns();
  for (const [name, text] of [['claim', c.claim], ['missingWhat', missingWhat]]) {
    for (const h of scanString(String(text ?? ''), pats, [], ['both', 'content'])) errors.push(`giveaway-in-${name}: ${h.patternId} "${h.text}"`);
    for (const g of GIVEAWAYS) {
      const m = g.re.exec(String(text ?? ''));
      if (m) errors.push(`giveaway-in-${name}: ${g.id} "${m[0]}"`);
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * chooseDecoys(candidates, { copyDir, canaries, perRound }) -> { chosen, rejected }
 *   chosen: up to perRound + DECOY_SPARES valid candidates, as key entries D1, D2, ... (answer order)
 *   rejected: [{ index, errors }]
 */
export function chooseDecoys(candidates, { copyDir, canaries = [], perRound, patterns = null } = {}) {
  const limit = candidatesAsked(perRound);
  const chosen = [];
  const rejected = [];
  (candidates ?? []).forEach((c, index) => {
    if (chosen.length >= limit) return;
    const v = validateDecoy(c, { copyDir, canaries, taken: chosen, patterns });
    if (!v.ok) {
      rejected.push({ index, errors: v.errors });
      return;
    }
    chosen.push({
      decoy: `D${chosen.length + 1}`,
      kind: c.kind,
      file: safeRel(c.file),
      locator: String(c.locator ?? ''),
      quote: c.kind === 'quote' ? String(c.quote) : '',
      missingWhat: c.kind === 'missing' ? String(c.missingWhat) : '',
      claim: String(c.claim),
      claimedSeverity: c.claimedSeverity,
      whyFalse: String(c.whyFalse),
      proofFile: safeRel(c.proofFile),
      proofQuote: String(c.proofQuote),
    });
  });
  return { chosen, rejected };
}

export function buildDecoyKey({ runId, round, decoys, rejected = [] }) {
  return { schemaVersion: 1, runId, round, decoys, rejected };
}

function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** What a verifier is shown for one decoy: the same four fields as for a real item (verify.mjs itemView). */
export function decoyView(d) {
  return {
    file: d.file || null,
    locator: d.locator || '',
    shown: d.kind === 'missing' ? `missing: ${cut(d.missingWhat, 400)}` : String(d.quote ?? ''),
    claim: cut(d.claim, 300),
  };
}

/**
 * How many decoys go into one verification wave: at least one per batch when there are enough,
 * never more than the run asked for, never more than half of the real items.
 */
export function decoyCountFor({ available, perRound, realItems, batchMax }) {
  if (!available || !perRound || !realItems) return 0;
  const batches = Math.max(1, Math.ceil(realItems / Math.max(1, batchMax)));
  const half = Math.max(1, Math.floor(realItems * MAX_PER_BATCH_SHARE));
  return Math.max(0, Math.min(available, perRound, Math.max(batches, 2), half));
}

/** Opaque cluster ids for decoy items: the format of real ids, numbers after the real ones. */
export function opaqueIds(round, existingIds, count) {
  const pad2 = (n) => String(n).padStart(2, '0');
  let max = 0;
  const re = new RegExp(`^C-${pad2(round)}-(\\d+)$`);
  for (const id of existingIds || []) {
    const m = re.exec(String(id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  const out = [];
  for (let i = 1; i <= count; i++) out.push(`C-${pad2(round)}-${pad2(max + i)}`);
  return out;
}

/** Outcome of one verdict on a decoy: rejected | confirmed | undecided | no-answer. */
export function decoyOutcome(entry) {
  if (!entry || entry.noAnswer) return 'no-answer';
  if (entry.verdict === 'confirmed') return 'confirmed';
  if (entry.verdict === 'refuted') return 'rejected';
  return 'undecided';
}

/**
 * summariseResults(results) -> { presented, answered, rejected, confirmed, undecided, noAnswer, taintedJobs }
 *   results: rows of decoy-results.json ({ decoy, job, pass, outcome })
 *   presented counts every (decoy, verifier) presentation; answered leaves out those without an answer
 */
export function summariseResults(results) {
  const rows = results || [];
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  const noAnswer = count('no-answer');
  return {
    presented: rows.length,
    answered: rows.length - noAnswer,
    rejected: count('rejected'),
    confirmed: count('confirmed'),
    undecided: count('undecided'),
    noAnswer,
    taintedJobs: [...new Set(rows.filter((r) => r.outcome === 'confirmed').map((r) => r.job))],
  };
}
