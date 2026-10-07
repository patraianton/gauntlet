// The owner's words (r3-f21). The owner often answers a yes/no question with one word («да», «стоп»,
// «продолжай», "yes", "stop"). Such an answer is recorded exactly as it was said, never padded or
// rephrased.
//
// In one early run a single quote («just do it quickly, don't spare tokens») backed a limit
// raise AND a later amend of the sources, although the owner never spoke about sources. So every recorded
// decision now carries the exact question it answers (--question), whatever the length of the quote,
// and both are printed back in the report. The report also flags one quote used for decisions of
// different kinds, and words recorded before the problem they are used for existed (quoteFlags).

import { UsageError } from './errors.mjs';

/**
 * The label stored in `approvedBy` next to every recorded owner decision. Set the env var
 * GAUNTLET_OWNER (for example to a name or a handle) before `init`; the default is "owner".
 */
export function ownerLabel(env = process.env) {
  const v = String(env.GAUNTLET_OWNER ?? '').trim();
  return v === '' ? 'owner' : v;
}

export const SHORT_QUOTE = 10;

/**
 * ownerWords(quote, question, { what, required, questionRequired }) -> null | { quote, question }
 * Throws UsageError when the words are missing (and required), carry no letter or digit, or the
 * question is missing (and questionRequired, the default), has no letter or digit, is shorter than
 * SHORT_QUOTE characters, or is just the quote again.
 * A question that is given is always validated, also when questionRequired is false.
 */
export function ownerWords(quote, question = null, { what = '--owner-quote', required = true, questionRequired = true } = {}) {
  if (quote === null || quote === undefined || String(quote).trim() === '') {
    if (required) throw new UsageError(`${what} with the owner's own words is required`);
    return null;
  }
  const q = String(quote);
  if (!/[\p{L}\p{N}]/u.test(q)) throw new UsageError(`${what} must carry the owner's own words`);
  const qq = question === null || question === undefined || String(question).trim() === '' ? null : String(question).trim();
  if (!qq) {
    if (questionRequired) {
      throw new UsageError(`${what} "${q.trim().slice(0, 60)}" needs --question "<the exact question you asked the owner>": every owner decision records what the owner was asked, so that the owner's words cannot be reused for another decision`);
    }
    return { quote: q, question: null };
  }
  if (!/[\p{L}\p{N}]/u.test(qq) || qq.length < SHORT_QUOTE) {
    throw new UsageError(`--question "${qq}" must be the exact question you asked the owner (at least ${SHORT_QUOTE} characters, with words in it)`);
  }
  if (sameText(qq, q)) throw new UsageError('--question must be what you asked the owner, not the answer repeated');
  return { quote: q, question: qq };
}

/**
 * The same rule for words recorded in run.json ({ quote, question }) -> [{ path, message }].
 * The question is required whatever the length of the quote, as for every command. Only a run that
 * is already frozen may keep an entry written before the rule (legacyQuestions: true): such a run
 * must stay usable, and every entry a command writes carries its question anyway.
 */
export function ownerWordsErrors(w, at, { legacyQuestions = false } = {}) {
  try {
    ownerWords(w?.quote, w?.question ?? null, { what: `${at}/quote`, questionRequired: false });
    if (!legacyQuestions && !String(w?.question ?? '').trim()) {
      return [{ path: `${at}/question`, message: `${at}/question is required: record the owner's words exactly as said (short or long) and add "question": "<the exact question you asked the owner>", so that the words cannot be read as an answer to another question` }];
    }
    return [];
  } catch (e) {
    return [{ path: `${at}/quote`, message: e.message }];
  }
}

function sameText(a, b) {
  return normText(a) === normText(b);
}

/** Lower-cased text without punctuation and extra blanks: «Да!» and «да» are the same words. */
export function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * What a decision is about, for comparing two uses of one quote. An amend is about what it
 * changed (sources are not task lines), so the key carries `set.what`; `owner` decisions keep their kind.
 */
export function decisionSubject(d) {
  const what = d?.set?.what;
  return d?.kind === 'amend' && what ? `amend:${what}` : String(d?.kind ?? '?');
}

/**
 * Flags on how the owner's words were used.
 *  - `reuse`: one quote backs decisions about different subjects (different kinds, or amends of
 *    different parts). -> { quote, decisions: [{ id, kind, subject, question }] }
 *  - `predates`: a decision about a problem that did not exist yet when its quote was first
 *    recorded (the same quote was already recorded by an earlier decision, or is dated before
 *    the problem appeared). -> { id, quote, cluster, quoteSince, problemSince }
 * decisions: owner-decisions.json entries ({ id, ts, kind, set?, quote, question, clusters? });
 * opts.clusterBorn: (clusterId) -> ISO timestamp | null; opts.datedQuotes: [{ quote, date }] from
 * run.json (limitsOptIn, models.optIn, workflowOptIn; a day, not a moment).
 */
export function quoteFlags(decisions, { clusterBorn = () => null, datedQuotes = [] } = {}) {
  const list = (decisions || []).filter((d) => d && typeof d.quote === 'string' && normText(d.quote));
  const by = new Map();
  for (const d of list) {
    const k = normText(d.quote);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(d);
  }
  const reuse = [];
  for (const group of by.values()) {
    const subjects = new Set(group.map(decisionSubject));
    if (subjects.size > 1) {
      reuse.push({
        quote: group[0].quote,
        decisions: group.map((d) => ({ id: d.id, kind: d.kind, subject: decisionSubject(d), question: d.question ?? null })),
      });
    }
  }
  const predates = [];
  const firstUse = (key) => {
    let best = null;
    for (const d of by.get(key)) {
      const t = Date.parse(d.ts);
      if (Number.isFinite(t) && (best === null || t < best.t)) best = { t, iso: d.ts };
    }
    return best;
  };
  for (const d of list) {
    for (const cid of d.clusters ?? []) {
      const bornIso = clusterBorn(cid) ?? null;
      const born = Date.parse(bornIso ?? '');
      if (!Number.isFinite(born)) continue;
      const key = normText(d.quote);
      let since = firstUse(key);
      // a dated quote from run.json counts at the end of its day, so only a clearly earlier day flags
      for (const dq of datedQuotes) {
        if (normText(dq.quote) !== key) continue;
        const t = Date.parse(`${dq.date}T23:59:59.999`);
        if (Number.isFinite(t) && (since === null || t < since.t)) since = { t, iso: dq.date };
      }
      if (since !== null && since.t < born) predates.push({ id: d.id, quote: d.quote, cluster: cid, quoteSince: since.iso, problemSince: bornIso });
    }
  }
  return { reuse, predates };
}
