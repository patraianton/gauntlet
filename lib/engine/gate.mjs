// The gate (SPEC 13). `decide(input)` is a PURE function: no I/O, no clock, no randomness.
// round.mjs assembles `input` from round files and stores it as rounds/NN/gate-input.json;
// audit.mjs replays decide() over the stored input and compares with gate.json.
//
// Honesty rules implemented here (all CODE level):
//  - the decision uses verified blocker/major counts of the WORST lens, never an average;
//    no average of anything is computed in this file;
//  - DONE needs a clean confirm round on the candidate's version hash;
//  - an unguarded or unreliable lens can never certify "clean";
//  - the reference band is computed for confirm rounds only and never feeds the decision.

import { bandFor, panelBand } from './band.mjs';

export const OPEN_STATUSES = Object.freeze(['open', 'unverified', 'contested']);
export const SERIOUS = Object.freeze(['blocker', 'major']);
export const PRE_GATE_DECISIONS = Object.freeze(['RERUN_LENS', 'INVALID_ROUND', 'BLOCKED_PRECHECK', 'BLOCKED_TRACE']);
export const STOP_DECISIONS = Object.freeze(['STOP_PLATEAU', 'STOP_LIMIT', 'STOP_INCONCLUSIVE', 'STOP_OWNER']);

/** A cluster that blocks: status open/unverified/contested, severity blocker/major, not waived. */
export function isOpenCluster(c) {
  return !!c && OPEN_STATUSES.includes(c.status) && SERIOUS.includes(c.severity) && !c.waived;
}

/** Lens ids that have a member in the cluster (input clusters carry `lenses`). */
function lensesOf(c) {
  if (Array.isArray(c.lenses)) return [...new Set(c.lenses)];
  if (Array.isArray(c.members)) return [...new Set(c.members.map((m) => m.lens).filter(Boolean))];
  return [];
}

/**
 * Per-lens validity (SPEC 13.1).
 * fact: { answerValid, attempts, guarded, caught, ownCanary, invalidReasons, guardable?, unguardedStreak? }
 *  valid      = answerValid && guarded && caught
 *  unreliable = !valid && nothing more can help: attempts > maxLensReruns; or the lens is unguarded
 *               and either no attention check can ever be planted for it (guardable === false) or it
 *               stayed unguarded for two rounds in a row (unguardedStreak >= 2). A lens left unguarded
 *               once (a planted-error slot that could not be filled) only makes the round not clean;
 *               the next round plants again. (Inputs without `guardable` keep the old rule.)
 */
export function lensValidity(fact, maxLensReruns) {
  const f = fact || {};
  const guarded = !!f.guarded;
  const canaryOk = guarded && !!f.caught;
  const answerOk = !!f.answerValid;
  const valid = answerOk && canaryOk;
  const attempts = Number(f.attempts) || 0;
  const neverGuardable = f.guardable === undefined ? true : f.guardable === false || (Number(f.unguardedStreak) || 0) >= 2;
  const unreliable = !valid && (attempts > maxLensReruns || (!guarded && neverGuardable));
  const invalidReasons = [...(f.invalidReasons || [])];
  if (!answerOk && !invalidReasons.some((r) => r.startsWith('answer'))) invalidReasons.push('answer not valid');
  if (!guarded) invalidReasons.push('no attention check this round');
  else if (!canaryOk) invalidReasons.push('attention check missed');
  return { valid, unreliable, guarded, attempts, answerOk, canaryOk, invalidReasons: valid ? [] : invalidReasons };
}

/** Counts over a cluster list (distinct and per lens). */
export function countOpen(clusters, lensIds) {
  const open = { blocker: 0, major: 0, unverified: 0, contested: 0, requirements: 0 };
  const perLens = {};
  for (const id of lensIds) perLens[id] = { open: { blocker: 0, major: 0 }, cosmetic: 0, unverified: 0, contested: 0 };
  for (const c of clusters || []) {
    const ls = lensesOf(c);
    if (isOpenCluster(c)) {
      open[c.severity] += 1;
      if (c.status === 'unverified') open.unverified += 1;
      if (c.status === 'contested') open.contested += 1;
      if (c.origin === 'requirement') open.requirements += 1;
      for (const l of ls) {
        if (!perLens[l]) continue;
        perLens[l].open[c.severity] += 1;
        if (c.status === 'unverified') perLens[l].unverified += 1;
        if (c.status === 'contested') perLens[l].contested += 1;
      }
    } else if (c.status === 'cosmetic' && !c.waived) {
      for (const l of ls) if (perLens[l]) perLens[l].cosmetic += 1;
    }
  }
  return { open, perLens, distinct: open.blocker + open.major };
}

/**
 * What is known about one version up to (and including) a point in the history (r3-f13, r3-f14): a
 * version reviewed twice (a clean candidate, then a confirm round that found problems) is judged by
 * the worse of its rounds, so a count the confirm round disproved never stands.
 * -> Map versionHash -> { distinctOpen, openBlockers, openMajors } (worst seen)
 */
function worstByVersion(rounds) {
  const out = new Map();
  for (const r of rounds || []) {
    if (r.versionHash == null) continue;
    const w = out.get(r.versionHash) || { distinctOpen: 0, openBlockers: 0, openMajors: 0 };
    const worse = r.openBlockers > w.openBlockers || (r.openBlockers === w.openBlockers && r.openMajors > w.openMajors);
    out.set(r.versionHash, {
      distinctOpen: Math.max(w.distinctOpen, Number(r.distinctOpen) || 0),
      openBlockers: worse ? r.openBlockers : w.openBlockers,
      openMajors: worse ? r.openMajors : w.openMajors,
    });
  }
  return out;
}

/**
 * Plateau counter (SPEC 13.2).
 * rounds: chronological list of { round, kind, valid, reviewed, versionHash, distinctOpen } INCLUDING the current round.
 * stagnant = number of most recent consecutive counted working rounds k with M(k) >= min{M'(j): j<k counted},
 * where M'(j) is the worst count any round up to k found on round j's version (a candidate's 0 that a
 * failed confirm round disproved counts as what the confirm round found, r3-f13);
 * confirm rounds and non-counted rounds are skipped (neither counted nor breaking the streak);
 * rounds at or before `lastContinueRound` are not counted but still define the minimum.
 * Counted rounds: with `reviewedRounds` every round the reviewers actually reviewed (`reviewed === true`),
 * whatever the validity of its lenses (the same set as the best version, SPEC 13.2: a run in which a lens
 * was invalid in every round must still be able to stop on a plateau); without it (inputs stored by an
 * older run) only rounds whose every lens was valid.
 * A round with an invalid lens has too few open problems (that lens found nothing), so with `reviewedRounds`
 * it never LOWERS the minimum while a fully valid round before k exists: the minimum is taken over the fully
 * valid rounds before k, and only when there is none over the reviewed rounds before k. Such a round can still
 * count as stagnant; if its count looks like an improvement it breaks the streak (the run goes on, capped by
 * maxRounds, rather than stopping on a round that may have been better only because a lens was blind).
 */
export function stagnantCount(rounds, lastContinueRound = null, { reviewedRounds = false } = {}) {
  const all = rounds || [];
  const valid = all.filter((r) => (reviewedRounds ? r.reviewed === true : r.valid));
  let stagnant = 0;
  for (let i = valid.length - 1; i >= 0; i--) {
    const k = valid[i];
    if (lastContinueRound != null && k.round <= lastContinueRound) break;
    if (k.kind !== 'working') continue;
    const worst = worstByVersion(all.filter((r) => r.round <= k.round));
    const countFor = (v) => (v.versionHash != null && worst.has(v.versionHash) ? worst.get(v.versionHash).distinctOpen : v.distinctOpen);
    const before = valid.slice(0, i);
    const fullyValidBefore = reviewedRounds ? before.filter((v) => v.valid) : before;
    const reference = fullyValidBefore.length ? fullyValidBefore : before;
    let min = Infinity;
    for (const v of reference) min = Math.min(min, countFor(v));
    if (k.distinctOpen >= min) stagnant += 1;
    else break;
  }
  return stagnant;
}

/**
 * Best version: lexicographic minimum of (blockers, majors) over the versions of valid rounds (or,
 * with `reviewedRounds`, of every reviewed round; `lensesValid` then says whether all its lenses were
 * valid), each
 * version scored by the worst counts any round found on it (r3-f14: a candidate a confirm round
 * found a blocker in is not "0/0"); ties keep the earlier. The round named is the version's first
 * valid round (its snapshot is the version).
 */
export function bestOf(rounds, { reviewedRounds = false } = {}) {
  const worst = worstByVersion(rounds);
  let best = null;
  const seen = new Set();
  for (const r of rounds || []) {
    // Old rule: only rounds whose every lens was valid. New rule (`reviewedRounds`): every round the
    // reviewers actually reviewed, whatever the lenses' validity; "clean" stays separate (a lens that
    // failed its attention check never certifies clean, but its round still names a version).
    if (reviewedRounds ? r.reviewed !== true : !r.valid) continue;
    const key = r.versionHash ?? `round:${r.round}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = r.versionHash != null && worst.has(r.versionHash) ? worst.get(r.versionHash) : { openBlockers: r.openBlockers, openMajors: r.openMajors };
    if (best === null || w.openBlockers < best.blockers || (w.openBlockers === best.blockers && w.openMajors < best.majors)) {
      best = { round: r.round, versionHash: r.versionHash, blockers: w.openBlockers, majors: w.openMajors, ...(reviewedRounds ? { lensesValid: !!r.valid } : {}) };
    }
  }
  return best;
}

/**
 * decide(input) -> gate (SPEC 9.13 shape).
 *
 * input = {
 *   round, kind: 'working'|'confirm', versionHash,
 *   candidate: null|{ round, versionHash },
 *   ownerStop: bool,                                   // owner 'stop' recorded after the previous gate
 *   lenses: [lensId],                                  // lenses that have validity (confirm-extra excluded)
 *   lensFacts: { lensId: { answerValid, attempts, guarded, caught, ownCanary, invalidReasons } },
 *   clusters: [ { id, origin, status, severity, waived?, lenses: [lensId] } ],
 *   pendingDisputes: n,
 *   history: [ { round, kind, valid, reviewed, versionHash, openBlockers, openMajors, distinctOpen } ],  // earlier rounds
 *   bestRule: 'reviewed'|undefined,                    // best over every reviewed round (undefined: valid rounds only)
 *   plateauRule: 'reviewed'|undefined,                 // plateau over every reviewed round (undefined: valid rounds only)
 *   lastContinueRound: n|null,
 *   confirmsDone: n,                                   // before this round
 *   roundsDone: n,                                     // working rounds, INCLUDING this one when it is working (r3-f16)
 *   tokensSpent: n, nextEstimate: n,
 *   limits: { maxRounds, maxConfirms, maxPanelTokens, plateauRounds, maxLensReruns },
 *   panelCatch: { pairsCaught, pairsTotal }
 * }
 */
export function decide(input) {
  const inp = input || {};
  const limits = {
    maxRounds: 8, maxConfirms: 2, maxPanelTokens: 15000000, plateauRounds: 2, maxLensReruns: 1,
    ...(inp.limits || {}),
  };
  const lensIds = [...(inp.lenses || [])];
  const reasons = [];

  // Per-lens validity.
  const validity = {};
  for (const id of lensIds) validity[id] = lensValidity((inp.lensFacts || {})[id], limits.maxLensReruns);
  const counts = countOpen(inp.clusters || [], lensIds);

  const perLens = {};
  for (const id of lensIds) {
    const v = validity[id];
    const f = (inp.lensFacts || {})[id] || {};
    perLens[id] = {
      valid: v.valid,
      unreliable: v.unreliable,
      guarded: v.guarded,
      attempts: v.attempts,
      invalidReasons: v.invalidReasons,
      ownCanary: f.ownCanary || null,
      open: { ...counts.perLens[id].open },
      cosmetic: counts.perLens[id].cosmetic,
      unverified: counts.perLens[id].unverified,
      contested: counts.perLens[id].contested,
    };
  }

  const allValid = lensIds.length > 0 && lensIds.every((id) => validity[id].valid);
  const anyUnreliable = lensIds.some((id) => validity[id].unreliable);
  const pendingDisputes = Number(inp.pendingDisputes) || 0;
  const distinctOpen = counts.distinct;
  const clean = allValid && distinctOpen === 0 && pendingDisputes === 0;

  const current = {
    round: inp.round,
    kind: inp.kind,
    valid: allValid,
    // Only new-rule inputs carry the flag: the output of an input stored by an older run must replay unchanged.
    ...(inp.bestRule === 'reviewed' || inp.plateauRule === 'reviewed' ? { reviewed: true } : {}),
    versionHash: inp.versionHash,
    openBlockers: counts.open.blocker,
    openMajors: counts.open.major,
    distinctOpen,
  };
  const history = [...(inp.history || []), current];
  // Inputs of runs written before these rules (no `plateauRule` / `bestRule`) replay with the old ones (audit).
  const stagnant = stagnantCount(history, inp.lastContinueRound ?? null, { reviewedRounds: inp.plateauRule === 'reviewed' });
  const best = bestOf(history, { reviewedRounds: inp.bestRule === 'reviewed' });

  let confirmsDone = Number(inp.confirmsDone) || 0;
  const roundsDone = Number(inp.roundsDone) || 0;
  const tokensSpent = Number(inp.tokensSpent) || 0;
  const nextEstimate = Number(inp.nextEstimate) || 0;
  const overTokens = tokensSpent + nextEstimate > limits.maxPanelTokens;
  const overRounds = roundsDone >= limits.maxRounds;

  if (!allValid) {
    for (const id of lensIds) {
      if (!validity[id].valid) reasons.push(`lens ${id}: ${validity[id].invalidReasons.join('; ')}`);
    }
  }
  if (distinctOpen > 0) reasons.push(`open verified problems: ${counts.open.blocker} blocker, ${counts.open.major} major`);
  if (pendingDisputes > 0) reasons.push(`pending disputes: ${pendingDisputes}`);

  let decision = null;
  let skipCleanToConfirm = false;

  if (inp.ownerStop) {
    decision = 'STOP_OWNER';
    reasons.unshift('owner asked to stop');
  } else if (inp.kind === 'confirm') {
    const sameVersion = !!inp.candidate && inp.candidate.versionHash === inp.versionHash;
    if (clean && sameVersion) {
      decision = 'DONE';
      reasons.unshift('clean candidate round followed by a clean confirm round on the same version');
    } else {
      if (!sameVersion) reasons.push('confirm round version differs from the candidate');
      confirmsDone += 1;
      skipCleanToConfirm = true;
      if (anyUnreliable && distinctOpen === 0) {
        decision = 'STOP_INCONCLUSIVE';
        reasons.unshift('a lens stayed unreliable and nothing serious is open');
      } else if (confirmsDone >= limits.maxConfirms) {
        decision = 'STOP_LIMIT';
        reasons.unshift('confirm rounds');
      }
    }
  }

  if (decision === null) {
    if (!skipCleanToConfirm && inp.kind === 'working' && clean) {
      decision = 'CONFIRM';
      reasons.unshift('clean working round; the next round on this version is the confirm round');
    } else if (!skipCleanToConfirm && anyUnreliable && distinctOpen === 0) {
      decision = 'STOP_INCONCLUSIVE';
      reasons.unshift('a lens stayed unreliable and nothing serious is open');
    } else if (overRounds || overTokens) {
      decision = 'STOP_LIMIT';
      reasons.unshift(overRounds ? 'rounds limit reached' : 'panel token budget would be exceeded');
    } else if (stagnant >= limits.plateauRounds) {
      decision = 'STOP_PLATEAU';
      reasons.unshift(`no fewer open problems for ${stagnant} rounds`);
    } else {
      decision = 'FIX';
    }
  }

  // Reference band: confirm rounds only, report only (never read above).
  let band = null;
  if (inp.kind === 'confirm') {
    const per = {};
    for (const id of lensIds) {
      const p = perLens[id];
      per[id] = bandFor({ blockers: p.open.blocker, majors: p.open.major, cosmetics: p.cosmetic });
    }
    band = { perLens: per, worst: panelBand(per) };
  }

  return {
    schemaVersion: 1,
    round: inp.round,
    kind: inp.kind,
    versionHash: inp.versionHash,
    decision,
    reasons,
    perLens,
    open: { ...counts.open },
    pendingDisputes,
    history,
    plateau: { stagnant, patience: limits.plateauRounds },
    best,
    limits: {
      rounds: roundsDone,
      maxRounds: limits.maxRounds,
      confirmsDone,
      maxConfirms: limits.maxConfirms,
      tokensSpent,
      nextEstimate,
      maxPanelTokens: limits.maxPanelTokens,
    },
    band,
    panelCatch: { pairsCaught: 0, pairsTotal: 0, ...(inp.panelCatch || {}) },
  };
}

/**
 * Gate record for decisions taken before the gate runs (RERUN_LENS, INVALID_ROUND,
 * BLOCKED_PRECHECK, BLOCKED_TRACE) or for a limit stop without a round. Same schema.
 */
export function preGateRecord({ round = null, kind = null, versionHash = null, decision, reasons = [], history = [],
  limits = {}, best = null, confirmsDone = 0, roundsDone = 0, tokensSpent = 0, nextEstimate = 0, plateau = null }) {
  return {
    schemaVersion: 1,
    round,
    kind,
    versionHash,
    decision,
    reasons: [...reasons],
    perLens: {},
    open: { blocker: 0, major: 0, unverified: 0, contested: 0, requirements: 0 },
    pendingDisputes: 0,
    history: [...history],
    plateau: plateau || { stagnant: 0, patience: limits.plateauRounds ?? 2 },
    best,
    limits: {
      rounds: roundsDone,
      maxRounds: limits.maxRounds ?? 8,
      confirmsDone,
      maxConfirms: limits.maxConfirms ?? 2,
      tokensSpent,
      nextEstimate,
      maxPanelTokens: limits.maxPanelTokens ?? 15000000,
    },
    band: null,
    panelCatch: { pairsCaught: 0, pairsTotal: 0 },
  };
}
