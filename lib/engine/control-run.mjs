// True controls inside a round (SPEC 14.12): choosing them from the reviewer findings that were matched
// to planted errors, the sealed key, the mix into verifier batches and the verdicts on them. The
// checks and the arithmetic live in lib/measure/controls.mjs; round.mjs calls the functions below at the
// right moments. The files live in the same sealed stage as the decoys (<NN>-decoy-stage) and move into
// rounds/NN/ when the round closes (revealDecoys in decoy-run.mjs checks the key against its commitment):
//   controls.json          the chosen controls = the key; its hash is the commitment (round.json)
//   control-mix.json       which verifier item each control became, wave by wave
//   control-results.json   every verdict on a control, and the verifier jobs that were not trusted

import path from 'node:path';
import { writeJsonAtomic } from '../core/fsx.mjs';
import { hashJson } from '../core/hash.mjs';
import { log, readJsonIf } from './state.mjs';
import { decoyPath } from './stage.mjs';
import { loadMix as loadDecoyMix } from './decoy-run.mjs';
import { findingsOf } from './ingest.mjs';
import { opaqueIds } from '../measure/decoys.mjs';
import { chooseControls, buildControlKey, controlView, controlCountFor, controlOutcome, controlsWanted } from '../measure/controls.mjs';

function readRoundJson(rc, n) {
  return readJsonIf(rc.paths.roundDir(n).roundJson, null);
}

function patchRound(rc, n, patch) {
  const cur = readRoundJson(rc, n) || { schemaVersion: 1, round: n };
  writeJsonAtomic(rc.paths.roundDir(n).roundJson, { ...cur, ...patch, schemaVersion: 1, round: n });
}

/** Controls run when the settings ask for them and it is not a bench run (a bench key is known in advance). */
export function controlsActive(rc) {
  if (rc.run.canaries?.fixedKey) return false;
  return controlsWanted(rc.run) >= 1;
}

export function loadControlKey(rc, n) {
  return readJsonIf(decoyPath(rc, n, 'controls.json'), null);
}

export function loadControlMix(rc, n) {
  return readJsonIf(decoyPath(rc, n, 'control-mix.json'), { schemaVersion: 1, ids: {}, items: [] });
}

export function loadControlResults(rc, n) {
  return readJsonIf(decoyPath(rc, n, 'control-results.json'), { schemaVersion: 1, results: [], tainted: [] });
}

/**
 * Choose the controls of round n and seal them: the key goes to the sealed stage, its hash to round.json
 * and to the ledger BEFORE any verifier is asked. `keptAnswers`: [{ job, ing, ans }] of the round's kept
 * reviewer answers; `removed`: the ids of findings that were matched to a planted error.
 * Idempotent: a round whose controls are already sealed is left alone. -> { count }
 */
export function sealControls(rc, n, { keptAnswers, removed }) {
  const round = readRoundJson(rc, n);
  if (!round) return { count: 0 };
  if (round.controlCommitment) return { count: loadControlKey(rc, n)?.controls?.length ?? 0 };
  if (round.controlsSealed) return { count: 0 };
  const findings = [];
  for (const k of keptAnswers) findings.push(...findingsOf({ kept: true, json: k.ans }, k.ing, { round: n, copyDir: round.copyDir }));
  const key = readJsonIf(rc.paths.roundDir(n).canaries, null) || readJsonIf(rc.dataPaths.sealedKey(rc.runId, String(n).padStart(2, '0')), null);
  const detections = readJsonIf(rc.paths.roundDir(n).detections, { detections: [] }).detections;
  const controls = chooseControls({ detections, findings, removed, canaries: key?.canaries ?? [] });
  if (!controls.length) {
    patchRound(rc, n, { controlsSealed: true, controlCount: 0 });
    log(rc, 'controls-sealed', { chosen: 0, removedFindings: removed.length }, n);
    return { count: 0 };
  }
  const full = buildControlKey({ runId: rc.runId, round: n, controls });
  writeJsonAtomic(decoyPath(rc, n, 'controls.json'), full);
  const commitment = hashJson(full);
  patchRound(rc, n, { controlsSealed: true, controlCommitment: commitment, controlCount: controls.length });
  log(rc, 'controls-sealed', { chosen: controls.length, removedFindings: removed.length, commitment }, n);
  return { count: controls.length };
}

/**
 * The controls for one group of verifier batches: [{ id, control, file, locator, shown, claim }] for
 * buildItems, or [] when the round has none. `realItems` is how many real items the group verifies.
 * The opaque cluster id of a control is chosen once per round and kept in the mix file; it never equals
 * the id of a cluster or of a decoy.
 */
export function controlsForGroup(rc, n, { realItems, batchMax, existingIds, rngFor = null }) {
  const key = loadControlKey(rc, n);
  if (!key || !key.controls?.length) return [];
  const count = controlCountFor({ available: key.controls.length, perRound: controlsWanted(rc.run), realItems, batchMax });
  if (count < 1) return [];
  const mix = loadControlMix(rc, n);
  const rng = rngFor ? rngFor('controls') : null;
  const ordered = rng && typeof rng.shuffle === 'function' ? rng.shuffle([...key.controls]) : [...key.controls];
  const picked = ordered.slice(0, count);
  const need = picked.filter((k) => !mix.ids[k.control]);
  if (need.length) {
    const taken = [...(existingIds || []), ...Object.values(mix.ids), ...Object.values(loadDecoyMix(rc, n).ids || {})];
    const fresh = opaqueIds(n, taken, need.length);
    need.forEach((k, i) => {
      mix.ids[k.control] = fresh[i];
    });
    writeJsonAtomic(decoyPath(rc, n, 'control-mix.json'), mix);
  }
  return picked.map((k) => ({ id: mix.ids[k.control], control: k.control, ...controlView(k) }));
}

/** Remember where the controls of a wave landed: [{ pass, item, control, cluster }]. */
export function recordControlPlacement(rc, n, wave, placed) {
  if (!placed.length) return;
  const mix = loadControlMix(rc, n);
  for (const p of placed) mix.items.push({ wave, ...p });
  writeJsonAtomic(decoyPath(rc, n, 'control-mix.json'), mix);
}

/** Map `${pass}:${item}` -> control id for the control items of the mix (all waves). */
export function controlItemIndex(rc, n) {
  const m = new Map();
  for (const x of loadControlMix(rc, n).items) m.set(`${x.pass}:${x.item}`, x.control);
  return m;
}

/** The planted class of each control of round n: { K1: 'major', ... }. */
export function plantedOf(rc, n) {
  const out = {};
  for (const k of loadControlKey(rc, n)?.controls ?? []) out[k.control] = k.plantedSeverity;
  return out;
}

/**
 * Add the verdicts of one wave to control-results.json.
 *  rows: [{ control, wave, pass, item, job, batch, verdict, severity, answered }]
 *  tainted: [{ job, wave, pass, controls, items, reverify }]
 * -> the rows as stored (with `outcome`)
 */
export function recordControlResults(rc, n, rows, tainted) {
  const planted = plantedOf(rc, n);
  const stored = rows.map((r) => ({ ...r, plantedSeverity: planted[r.control] ?? null, outcome: controlOutcome({ verdict: r.verdict, severity: r.severity, noAnswer: !r.answered }, planted[r.control]) }));
  if (!stored.length && !tainted.length) return stored;
  const cur = loadControlResults(rc, n);
  cur.results.push(...stored);
  cur.tainted.push(...tainted);
  writeJsonAtomic(decoyPath(rc, n, 'control-results.json'), cur);
  return stored;
}

/**
 * What the ledger says about the controls of round `num`, checked for order (SPEC 14.12): the commitment was
 * recorded (controls-sealed) and equals the round's, BEFORE the first verifier job of the round was issued;
 * and the reveal came only after every verifier answer of the round was ingested. A round that closed
 * without a reveal is reported too. -> [problem text]
 */
export function controlLedgerProblems(num, round, lines) {
  const problems = [];
  if (!round.controlCommitment) {
    // A round without a commitment is fine only when no control was chosen; the ledger is hash-chained, so a
    // `controls-sealed` event with chosen > 0 cannot be undone by editing round.json.
    const chosen = lines.find((l) => l.type === 'controls-sealed' && l.round === num && Number(l.data?.chosen) > 0);
    if (chosen) problems.push(`round ${num}: the ledger says ${chosen.data.chosen} control(s) were sealed, but round.json carries no control commitment`);
    return problems;
  }
  const sealed = lines.find((l) => l.type === 'controls-sealed' && l.round === num);
  if (!sealed) problems.push(`round ${num}: no controls-sealed event`);
  else {
    if (sealed.data?.commitment !== round.controlCommitment) problems.push(`round ${num}: the commitment of the controls in the ledger differs from the round's`);
    for (const l of lines.filter((x) => x.round === num && x.type === 'job-issued' && x.data?.role === 'verifier')) {
      if (l.seq < sealed.seq) problems.push(`round ${num}: verifier job ${l.data.job} was issued before the controls were committed`);
    }
  }
  if (!round.decoysRevealed) {
    if (round.closedAt) problems.push(`round ${num}: the controls were not revealed when the round closed`);
    return problems;
  }
  const rev = lines.find((l) => l.type === 'decoy-reveal' && l.round === num);
  if (!rev) problems.push(`round ${num}: no reveal event for the controls`);
  else {
    for (const l of lines.filter((x) => x.round === num && x.type === 'answer-ingested' && x.data?.role === 'verifier')) {
      if (l.seq > rev.seq) problems.push(`round ${num}: the controls were revealed before the answer of job ${l.data.job} was ingested`);
    }
  }
  return problems;
}

/** The key and results of a round that was revealed (run files; used by the report, the ledger and audit). */
export function revealedControls(rc, n) {
  const d = rc.paths.roundDir(n).dir;
  return {
    key: readJsonIf(path.join(d, 'controls.json'), null),
    results: readJsonIf(path.join(d, 'control-results.json'), { results: [], tainted: [] }),
  };
}

/**
 * Rows for the cross-run ledger (measurements/controls.jsonl): one per (control, verifier presentation).
 * jobModels: { <job>: model|null }.
 */
export function ledgerRowsFor(rc, n, { jobModels = {} } = {}) {
  const { key, results } = revealedControls(rc, n);
  if (!key) return [];
  const byId = new Map(key.controls.map((k) => [k.control, k]));
  const failed = new Set((results.tainted || []).map((t) => t.job));
  return (results.results || []).map((r) => ({
    control: r.control,
    canary: byId.get(r.control)?.canary ?? null,
    plantedSeverity: byId.get(r.control)?.plantedSeverity ?? null,
    wave: r.wave,
    pass: r.pass,
    job: r.job,
    outcome: r.outcome,
    verdict: r.verdict ?? null,
    severityGiven: r.severity ?? null,
    batchTainted: failed.has(r.job),
    verifierModel: Object.prototype.hasOwnProperty.call(jobModels, r.job) ? jobModels[r.job] ?? 'default' : 'default',
  }));
}
