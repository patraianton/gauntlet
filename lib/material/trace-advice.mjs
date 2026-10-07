// What to tell the executor when the trace scan stops on material (SPEC 15.5).
//
// The scan is a filter for leftovers of earlier reviews. It is not a goal: on 06-07.10.2026 a window
// rewrote 182 values of its evidence data (a shop rating "9,5", the words "panel", "reviewer",
// "round 3") and split the same words inside its own code so that its tools passed the scan. That
// falsifies the material and hides it from the owner. The only honest ways out are to remove a real
// leftover by hand, or to ask the owner for a traceAllow entry. This module builds that message,
// with the exact question the executor must ask.

import { allowProblems, loadPatterns } from './lint.mjs';

const MAX_PLACES = 6;

/** Words of `text` with their positions: [{ start, end }]. */
function wordSpans(text) {
  const out = [];
  for (const m of String(text).matchAll(/\S+/gu)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

const EDGE_PUNCT = /^[\s.,;:!?()[\]"'«»“”„]+|[\s.,;:!?()[\]"'«»“”„]+$/gu;

/**
 * suggestAllowPhrase(context, hitText, patterns?) -> string | null
 * The shortest run of whole words around the hit that is a valid traceAllow phrase (literal, at least
 * 8 characters, exactly one trace word, at least 4 other letters), or null when there is none.
 */
export function suggestAllowPhrase(context, hitText, patterns = loadPatterns('trace')) {
  const ctx = String(context ?? '');
  const at = ctx.toLowerCase().indexOf(String(hitText ?? '').toLowerCase());
  if (at < 0 || !hitText) return null;
  const words = wordSpans(ctx);
  const first = words.findIndex((w) => w.end > at);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < words.length && words[last + 1].start < at + hitText.length) last += 1;
  const tries = [];
  for (let n = 0; n <= 6; n++) for (let l = 0; l <= n; l++) tries.push([l, n - l]);
  for (const [l, r] of tries) {
    const a = words[Math.max(0, first - l)];
    const b = words[Math.min(words.length - 1, last + r)];
    const phrase = ctx.slice(a.start, b.end).replace(EDGE_PUNCT, '');
    if (!phrase || phrase.includes('...')) continue;
    if (allowProblems({ phrase, why: 'x' }, patterns).length === 0) return phrase;
  }
  return null;
}

/**
 * traceAdvice(hits, { runHint? }) -> string[]
 * hits: scanTrace / scanPaths results. Returns the lines to append to the problem list of a
 * BLOCKED_TRACE decision (empty when there are no hits).
 */
export function traceAdvice(hits, { patterns = null } = {}) {
  const list = (hits || []).filter(Boolean);
  if (!list.length) return [];
  const pats = patterns ?? loadPatterns('trace');
  const seen = new Set();
  const places = [];
  for (const h of list) {
    const key = `${h.file ?? ''}\0${h.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(h);
  }
  const shown = places.slice(0, MAX_PLACES);
  const items = shown.map((h, i) => {
    const where = h.file ? `${h.file}${h.line ? `, line ${h.line}` : ''}` : 'a folder or file name of the copy';
    const ctx = h.context ? `: "${h.context}"` : `: "${h.text}"`;
    return `${i + 1}) ${where}${ctx}`;
  });
  const more = places.length > shown.length ? ` (and ${places.length - shown.length} more place(s) in the list above)` : '';
  const phrases = shown.map((h) => ({ h, phrase: h.context ? suggestAllowPhrase(h.context, h.text, pats) : null })).filter((x) => x.phrase);
  const lines = [];
  lines.push(
    'NEVER change the material, or write a tool that changes it, to get past this scan: do not rewrite, reformat or "normalise" values, do not reword or delete flagged words in order to pass, and do not split a word inside your own files to hide it (a split word fools the scan; it is still falsification, and the report tells the owner what you did). The scan catches accidental leftovers of earlier reviews; it does not decide what the work may say.',
  );
  lines.push(
    `If a flagged text is a REAL leftover of a review (a score of an earlier round, "round 3 notes", a reviewer's remark), remove it by hand like any other edit of the work (or, when a frozen strip rule already exists for that kind of text, let the rule remove it). If it is an ordinary word or value of the work itself (a product name, a shop's own rating, a quote of a source), it is not a leftover: only the owner can allow it. Ask the owner exactly this, in his language and in plain words: «The check for leftovers of earlier reviews stops on these places of the work: ${items.join(' ; ')}${more}. Each one is ordinary text or an ordinary value of the work itself, not a leftover of a review. May reviewers read them unchanged? Please answer yes or no for each.»`,
  );
  if (phrases.length) {
    lines.push(
      `If the owner says yes: write a new strip.json whose traceAllow lists, for each place the owner allowed, an entry {"phrase": "<literal text>", "why": "<the owner's reason>"} (suggested phrases: ${phrases.map((x) => `"${x.phrase}"`).join(', ')}), then run amend <run> --what strip --file <new strip.json> --reason "<why>" --owner-quote "<the owner's words>" --question "<the exact question you asked the owner>". Each allowed word is listed in the report. If he says no, it is a leftover: remove it by hand.`,
    );
  } else {
    lines.push(
      'If the owner says yes: write a new strip.json whose traceAllow lists, for each place the owner allowed, an entry {"phrase": "<literal text of 8 or more characters with exactly one flagged word>", "why": "<the owner\'s reason>"}, then run amend <run> --what strip --file <new strip.json> --reason "<why>" --owner-quote "<the owner\'s words>" --question "<the exact question you asked the owner>". Each allowed word is listed in the report. If the owner says no, it is a leftover: remove it by hand.',
    );
  }
  return lines;
}
