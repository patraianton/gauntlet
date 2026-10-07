// True controls: real defects mixed into verifier batches (SPEC 14.12).
//
// Decoys (decoys.mjs) show that a verifier can say "no". A verifier that refutes everything would pass
// that test perfectly and still acquit real problems. A true control is the other half: a problem that
// IS in the work, known to be real because the program planted it itself and a reviewer reported it.
// The reviewer findings that the matcher matched to a planted error leave the real-problem pipeline
// (they are the program's own edit, not the author's mistake); here they are reused: they are mixed into
// the verifier items in the same words the reviewer used, so a control looks like any other item.
//
// What the verdicts on controls do:
//   - they go to the run files and the cross-run ledger (controls.jsonl): kept / dismissed / downgraded,
//     with Clopper-Pearson bounds like the decoys;
//   - a verifier job that REFUTES a control, or confirms it in a class below the planted one, is untrusted
//     for its refutations AND for its confirmations that make a serious item cosmetic: those items are
//     re-checked by a fresh verifier (round.mjs afterVerify; other confirmations stand);
//   - a control never becomes a cluster, so it can never reach to-do.md or the owner's open problems.

import { severityRank } from './canary.mjs';
import { floorOf } from './match.mjs';
import { loadTaxonomy } from './taxonomy.mjs';
import { itemView } from '../engine/verify.mjs';

/** How many controls a run wants per round (0 = off). */
export function controlsWanted(run) {
  const v = run?.canaries?.controlsPerRound;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

const MAX_PER_BATCH_SHARE = 0.5;

/**
 * How many controls go into one verification wave: at least one per batch when there are enough,
 * never more than the run asked for, never more than half of the real items.
 */
export function controlCountFor({ available, perRound, realItems, batchMax }) {
  if (!available || !perRound || !realItems) return 0;
  const batches = Math.max(1, Math.ceil(realItems / Math.max(1, batchMax)));
  const half = Math.max(1, Math.floor(realItems * MAX_PER_BATCH_SHARE));
  return Math.max(0, Math.min(available, perRound, Math.max(batches, 2), half));
}

/** Is the finding something a verifier can be asked about (it has a claim and something to check)? */
function usable(f) {
  if (!f || !String(f.problem ?? '').trim()) return false;
  if (f.quote) return f.grounded === true;
  return Boolean(String(f.missingWhat ?? '').trim() || String(f.seen ?? '').trim());
}

function stageRank(d) {
  return d.stage === 'code' ? 1 : 0;
}

/**
 * chooseControls({ detections, findings, removed, canaries, taxonomy }) -> [control]
 *   detections: rows of detections.json (SPEC 9.11) of the round, all waves
 *   findings:   every finding of the round's kept reviewer answers (findingsOf), removed ones included
 *   removed:    ids "<job>#<n>" of findings that left the real-problem pipeline (matched to a planted error)
 *   canaries:   the revealed key (key.canaries)
 * One control per planted error: the matched finding that was reported at or above the planted class
 * (outcome `caught`), preferring a match settled by code over one the matcher settled, then the higher
 * matcher score. Answer order K1, K2, ... follows the planted errors' order.
 */
export function chooseControls({ detections = [], findings = [], removed = [], canaries = [], taxonomy = null } = {}) {
  const tax = taxonomy ?? loadTaxonomy();
  const gone = new Set(removed);
  const byId = new Map(findings.map((f) => [`${f.job}#${f.n}`, f]));
  const out = [];
  for (const c of canaries) {
    const planted = floorOf(c, tax);
    const options = (detections || [])
      .filter((d) => d.canary === c.canary && d.outcome === 'caught' && d.finding !== null && d.finding !== undefined)
      .map((d) => ({ d, id: `${d.job}#${d.finding}`, f: byId.get(`${d.job}#${d.finding}`) }))
      .filter((x) => gone.has(x.id) && usable(x.f))
      .sort(
        (a, b) =>
          stageRank(b.d) - stageRank(a.d) ||
          Number(b.d.matcherScore ?? 0) - Number(a.d.matcherScore ?? 0) ||
          severityRank(b.f.severity) - severityRank(a.f.severity) ||
          String(a.id).localeCompare(String(b.id)),
      );
    if (!options.length) continue;
    const { f, id } = options[0];
    const view = itemView({ origin: 'reviewer', kind: f.kind, file: f.file, locator: f.locator, quote: f.quote, missingWhat: f.missingWhat, seen: f.seen, problem: f.problem });
    out.push({
      control: `K${out.length + 1}`,
      canary: c.canary,
      finding: id,
      kind: f.kind ?? null,
      file: view.file,
      locator: view.locator,
      shown: view.shown,
      claim: view.claim,
      claimedSeverity: f.severity ?? null,
      plantedSeverity: planted,
    });
  }
  return out;
}

export function buildControlKey({ runId, round, controls }) {
  return { schemaVersion: 1, runId, round, controls };
}

/** What a verifier is shown for one control: the same four fields as for a real item. */
export function controlView(k) {
  return { file: k.file || null, locator: k.locator || '', shown: String(k.shown ?? ''), claim: String(k.claim ?? '') };
}

/**
 * Outcome of one verdict on a control: kept | dismissed | downgraded | undecided | no-answer.
 *   kept        confirmed, in the planted class or a higher one
 *   dismissed   refuted: a real problem was acquitted
 *   downgraded  confirmed, but in a class below the planted one
 *   undecided   unverifiable, or confirmed without a class (a real item confirmed without a class is also
 *               unverifiable, so it must not taint the verifier as a downgrade). Evidence is deliberately not
 *               required for `kept`: a control is never grounded against the copy the way a real item is, and a
 *               verdict with the right class still shows that the verifier keeps the problem alive.
 */
export function controlOutcome(entry, plantedSeverity) {
  if (!entry || entry.noAnswer) return 'no-answer';
  if (entry.verdict === 'refuted') return 'dismissed';
  if (entry.verdict === 'confirmed') {
    if (!KNOWN_CLASSES.includes(entry.severity)) return 'undecided';
    return severityRank(entry.severity) >= severityRank(plantedSeverity ?? 'major') ? 'kept' : 'downgraded';
  }
  return 'undecided';
}

const KNOWN_CLASSES = ['cosmetic', 'major', 'blocker'];

/**
 * Does a verifier's confirmation play a real item down, from a serious class (blocker or major) to cosmetic?
 * That is the case where a confirmation acquits in practice: a cosmetic item leaves the open problems and the gate.
 * Used for a verifier job that failed a true control: such a job is not believed when it makes problems
 * cosmetic either (SPEC 14.12). A lowering from blocker to major keeps the item open and is left alone. An item
 * with no claimed class is taken as serious.
 */
export function playsDown(entry, claimedSeverity) {
  if (!entry || entry.verdict !== 'confirmed') return false;
  const serious = severityRank(claimedSeverity ?? 'major') >= severityRank('major');
  return serious && severityRank(entry.severity) === severityRank('cosmetic');
}

/** A verdict that makes the verifier job untrusted for its refutations. */
export function controlFailed(outcome) {
  return outcome === 'dismissed' || outcome === 'downgraded';
}

/**
 * summariseControls(results) -> { presented, answered, kept, dismissed, downgraded, undecided, noAnswer, failedJobs }
 *   results: rows of control-results.json ({ control, job, pass, outcome })
 */
export function summariseControls(results) {
  const rows = results || [];
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  const noAnswer = count('no-answer');
  return {
    presented: rows.length,
    answered: rows.length - noAnswer,
    kept: count('kept'),
    dismissed: count('dismissed'),
    downgraded: count('downgraded'),
    undecided: count('undecided'),
    noAnswer,
    failedJobs: [...new Set(rows.filter((r) => controlFailed(r.outcome)).map((r) => r.job))],
  };
}
