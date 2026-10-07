// Decoys inside a round (SPEC 14.11): the decoy writer job, the sealed key, the mix into verifier
// batches, the verdicts on decoys and the reveal at round close. The checks and the arithmetic live in
// lib/measure/decoys.mjs; round.mjs calls the functions below at the right moments.
//
// Sealed until the round closes (data home, <NN>-decoy-stage, see stage.mjs):
//   decoy-writer/answer.json   the writer's raw answer (hashed in the ledger)
//   decoys.json                the chosen decoys with their proofs = the key; its hash is the commitment
//   decoy-mix.json             which verifier item each decoy became, wave by wave
//   decoy-results.json         every verdict on a decoy, and the verifier jobs that were not trusted
// At close they move into rounds/NN/ (reveal). The run folder keeps only hashes until then, and
// clusters.json never learns of a decoy.

import path from 'node:path';
import { IntegrityError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, exists } from '../core/fsx.mjs';
import { hashJson } from '../core/hash.mjs';
import { manifestOfDir } from '../material/manifest.mjs';
import { log, readJsonIf } from './state.mjs';
import { issueJob } from './ingest.mjs';
import { taskText, sourcesValue, materialListValue } from './setup.mjs';
import { decoyStageDir, decoyPath, unstageDecoys } from './stage.mjs';
import { chooseDecoys, buildDecoyKey, decoyView, decoyCountFor, opaqueIds, decoyOutcome, decoysWanted, candidatesAsked } from '../measure/decoys.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

function readRoundJson(rc, n) {
  return readJsonIf(rc.paths.roundDir(n).roundJson, null);
}

function patchRound(rc, n, patch) {
  const cur = readRoundJson(rc, n) || { schemaVersion: 1, round: n };
  writeJsonAtomic(rc.paths.roundDir(n).roundJson, { ...cur, ...patch, schemaVersion: 1, round: n });
}

/** Decoys run when the settings ask for them, it is not a bench run, and the run's frozen templates have the writer's. */
export function decoysActive(rc) {
  if (rc.run.canaries?.fixedKey) return false;
  if (decoysWanted(rc.run) < 1) return false;
  return exists(path.join(rc.paths.templatesDir, 'decoy-writer.md'));
}

/** The job record of the decoy writer (not yet in jobs.json). */
export function issueDecoyWriter(rc, n, copyDir) {
  const check = readJsonIf(rc.paths.roundDir(n).sourcesCheck, null)?.results || null;
  const values = {
    TASK: taskText(rc),
    COPY_DIR: copyDir,
    MATERIAL_LIST: materialListValue(copyDir, manifestOfDir(copyDir)),
    SOURCES: sourcesValue(rc, check),
    DECOY_COUNT: String(candidatesAsked(decoysWanted(rc.run))),
    ANSWER_LANGUAGE: rc.run.language?.answers || 'ru',
  };
  return issueJob(rc, {
    round: n,
    role: 'decoy',
    attempt: 1,
    values,
    promptsDir: path.join(decoyStageDir(rc, n), 'prompts'),
    lintSkip: Object.keys(values).filter((k) => !['TASK', 'SOURCES'].includes(k)),
  });
}

/** The destination of the decoy writer's raw answer (sealed stage) and the path logged for it. */
export function decoyAnswerDest(rc, n) {
  const rel = 'decoy-writer/answer.json';
  return { dest: decoyPath(rc, n, rel), logDest: `rounds/${pad2(n)}/${rel}` };
}

/** The planted edits of the round, from the sealed key (or rounds/NN/canaries.json after the reveal). */
function plantedEdits(rc, n) {
  const sealed = rc.dataPaths.sealedKey(rc.runId, pad2(n));
  const key = readJsonIf(sealed, null) || readJsonIf(rc.paths.roundDir(n).canaries, null);
  return (key?.canaries || []).map((c) => ({ file: c.file, after: c.after }));
}

/**
 * The decoy writer's answer was ingested (base = ingestAnswer result or null for a given-up job):
 * check every candidate, seal the key, record the commitment. A missing or unusable answer simply
 * means no decoys in this round (logged, shown in the report); it never stops the round.
 */
export function ingestDecoyWriter(rc, n, rec, base) {
  const round = readRoundJson(rc, n);
  if (!base || !base.kept || !base.json) {
    log(rc, 'decoys-ingested', { job: rec.job, ok: false, reasons: base ? base.reasons : ['given-up'] }, n);
    patchRound(rc, n, { decoyCount: 0 });
    return { ok: false, count: 0 };
  }
  const perRound = decoysWanted(rc.run);
  const { chosen, rejected } = chooseDecoys(base.json.decoys, { copyDir: round.copyDir, canaries: plantedEdits(rc, n), perRound });
  // incidental notes of the writer are real problems it noticed: they join the round's incidental list
  const incidental = [...(round.incidental || []), ...(base.json.incidental || [])];
  if (!chosen.length) {
    log(rc, 'decoys-ingested', { job: rec.job, ok: true, candidates: (base.json.decoys || []).length, chosen: 0, rejected: rejected.length }, n);
    patchRound(rc, n, { decoyCount: 0, incidental });
    return { ok: true, count: 0 };
  }
  const key = buildDecoyKey({ runId: rc.runId, round: n, decoys: chosen, rejected });
  writeJsonAtomic(decoyPath(rc, n, 'decoys.json'), key);
  const commitment = hashJson(key);
  patchRound(rc, n, { decoyCommitment: commitment, decoyCount: chosen.length, incidental });
  log(rc, 'decoys-ingested', { job: rec.job, ok: true, candidates: (base.json.decoys || []).length, chosen: chosen.length, rejected: rejected.length, commitment }, n);
  return { ok: true, count: chosen.length };
}

export function loadDecoyKey(rc, n) {
  return readJsonIf(decoyPath(rc, n, 'decoys.json'), null);
}

export function loadMix(rc, n) {
  return readJsonIf(decoyPath(rc, n, 'decoy-mix.json'), { schemaVersion: 1, ids: {}, items: [] });
}

export function loadResults(rc, n) {
  return readJsonIf(decoyPath(rc, n, 'decoy-results.json'), { schemaVersion: 1, results: [], tainted: [] });
}

/**
 * The decoys for one group of verifier batches: [{ id, decoy, file, locator, shown, claim }] for
 * buildItems, or [] when the round has none. `realItems` is how many real items the group verifies.
 * The opaque cluster id of a decoy is chosen once per round and kept in the mix file.
 */
export function decoysForGroup(rc, n, { realItems, batchMax, existingIds, rngFor = null }) {
  const key = loadDecoyKey(rc, n);
  if (!key || !key.decoys?.length) return [];
  const count = decoyCountFor({ available: key.decoys.length, perRound: decoysWanted(rc.run), realItems, batchMax });
  if (count < 1) return [];
  const mix = loadMix(rc, n);
  const rng = rngFor ? rngFor('decoys') : null;
  const ordered = rng && typeof rng.shuffle === 'function' ? rng.shuffle([...key.decoys]) : [...key.decoys];
  const picked = ordered.slice(0, count);
  const need = picked.filter((d) => !mix.ids[d.decoy]);
  if (need.length) {
    // the cluster-like ids of the true controls (SPEC 14.12) are taken too
    const controlIds = Object.values(readJsonIf(decoyPath(rc, n, 'control-mix.json'), { ids: {} }).ids || {});
    const taken = [...(existingIds || []), ...Object.values(mix.ids), ...controlIds];
    const fresh = opaqueIds(n, taken, need.length);
    need.forEach((d, i) => {
      mix.ids[d.decoy] = fresh[i];
    });
    writeJsonAtomic(decoyPath(rc, n, 'decoy-mix.json'), mix);
  }
  return picked.map((d) => ({ id: mix.ids[d.decoy], decoy: d.decoy, ...decoyView(d) }));
}

/** Remember where the decoys of a wave landed: [{ pass, item, decoy, cluster }]. */
export function recordPlacement(rc, n, wave, placed) {
  if (!placed.length) return;
  const mix = loadMix(rc, n);
  for (const p of placed) mix.items.push({ wave, ...p });
  writeJsonAtomic(decoyPath(rc, n, 'decoy-mix.json'), mix);
}

/** Map `${pass}:${item}` -> decoy id for the decoy items of the mix (all waves). */
export function decoyItemIndex(rc, n) {
  const m = new Map();
  for (const x of loadMix(rc, n).items) m.set(`${x.pass}:${x.item}`, x.decoy);
  return m;
}

/**
 * Add the verdicts of one wave to decoy-results.json.
 *  rows: [{ decoy, wave, pass, item, job, batch, verdict, severity, answered }]
 *  tainted: [{ job, wave, pass, decoys, reverify: [{ cluster, slot }] }]
 */
export function recordResults(rc, n, rows, tainted) {
  if (!rows.length && !tainted.length) return;
  const cur = loadResults(rc, n);
  for (const r of rows) cur.results.push({ ...r, outcome: decoyOutcome({ verdict: r.verdict, noAnswer: !r.answered }) });
  cur.tainted.push(...tainted);
  writeJsonAtomic(decoyPath(rc, n, 'decoy-results.json'), cur);
}

/**
 * Check a sealed key against its commitment: the file's hash must equal the one recorded when it was
 * sealed. -> the parsed key
 */
function checkedKey(file, commitment, what) {
  let key;
  try {
    key = readJson(file);
  } catch (e) {
    throw new IntegrityError('COMMITMENT_MISMATCH', `sealed ${what} key unreadable or missing: ${file} (${e.message})`, { path: file });
  }
  if (hashJson(key) !== commitment) {
    throw new IntegrityError('COMMITMENT_MISMATCH', `sealed ${what} key does not match its commitment`, { path: file, expected: commitment, actual: hashJson(key) });
  }
  return key;
}

/**
 * Reveal the decoys and the true controls of round n (they share one sealed stage): check each key
 * against its commitment, move the sealed files into rounds/NN/. Idempotent; a round that never had a
 * decoy writer job or a control does nothing.
 */
export function revealDecoys(rc, n, extra = {}) {
  const round = readRoundJson(rc, n);
  if (!round || round.decoysRevealed) return null;
  const dir = decoyStageDir(rc, n);
  const commitment = round.decoyCommitment ?? null;
  const controlCommitment = round.controlCommitment ?? null;
  if (!commitment && !controlCommitment && !exists(dir)) return null;
  let count = 0;
  let controls = 0;
  if (commitment) {
    const key = checkedKey(path.join(dir, 'decoys.json'), commitment, 'decoy');
    count = key.decoys.length;
    if (!exists(path.join(dir, 'decoy-results.json'))) writeJsonAtomic(path.join(dir, 'decoy-results.json'), { schemaVersion: 1, results: [], tainted: [] });
  }
  if (controlCommitment) {
    const key = checkedKey(path.join(dir, 'controls.json'), controlCommitment, 'control');
    controls = key.controls.length;
    if (!exists(path.join(dir, 'control-results.json'))) writeJsonAtomic(path.join(dir, 'control-results.json'), { schemaVersion: 1, results: [], tainted: [] });
  }
  const moved = unstageDecoys(rc, n);
  patchRound(rc, n, { decoysRevealed: true });
  log(rc, 'decoy-reveal', { commitment, decoys: count, ...(controlCommitment ? { controlCommitment, controls } : {}), unstaged: moved.length, ...extra }, n);
  return { commitment, count, controls };
}

/** The key and results of a round that was revealed (run files; used by the report, the ledger and audit). */
export function revealedDecoys(rc, n) {
  const d = rc.paths.roundDir(n).dir;
  return {
    key: readJsonIf(path.join(d, 'decoys.json'), null),
    results: readJsonIf(path.join(d, 'decoy-results.json'), { results: [], tainted: [] }),
  };
}

/**
 * Rows for the cross-run ledger (measurements/decoys.jsonl): one per (decoy, verifier presentation).
 * jobModels: { <job>: model|null }.
 */
export function ledgerRowsFor(rc, n, { jobModels = {} } = {}) {
  const { key, results } = revealedDecoys(rc, n);
  if (!key) return [];
  const byId = new Map(key.decoys.map((d) => [d.decoy, d]));
  const taintedJobs = new Set((results.tainted || []).map((t) => t.job));
  return (results.results || []).map((r) => ({
    decoy: r.decoy,
    kind: byId.get(r.decoy)?.kind ?? null,
    claimedSeverity: byId.get(r.decoy)?.claimedSeverity ?? null,
    wave: r.wave,
    pass: r.pass,
    job: r.job,
    outcome: r.outcome,
    verdict: r.verdict ?? null,
    severityGiven: r.severity ?? null,
    batchTainted: taintedJobs.has(r.job),
    verifierModel: Object.prototype.hasOwnProperty.call(jobModels, r.job) ? jobModels[r.job] ?? 'default' : 'default',
  }));
}
