// The cross-run measurement ledger (SPEC 14.7). Seven hash-chained files in
// <dataHome>/measurements/: runs, canaries, detections, verdicts, decoys, controls, escapes.
//
// Lost data cannot be recovered, so every round's canaries, detections and verified
// items are appended at round close, whatever the decision. Rows are plain payloads;
// chain.mjs adds seq/prev/hash/ts.

import fs from 'node:fs';
import path from 'node:path';
import { appendChained, readChained } from '../core/chain.mjs';
import { dataPaths as coreDataPaths } from '../core/datahome.mjs';
import { hashJson } from '../core/hash.mjs';
import { UsageError } from '../core/errors.mjs';
import { ownerWords } from '../core/owner.mjs';
import { loadTaxonomy } from './taxonomy.mjs';

export const ESCAPE_FOUND_BY = Object.freeze(['owner', 'production', 'later-run']);

/** dataPaths for an explicit data home, or the default one. */
export function measurePaths(home) {
  return coreDataPaths(home);
}

function files(dp) {
  const m = dp?.measurements;
  if (!m) throw new UsageError('measurement ledger: dataPaths.measurements missing');
  return m;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function append(file, payload) {
  ensureParent(file);
  return appendChained(file, payload);
}

/** All rows of one ledger file ([] when the file does not exist). */
export function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return readChained(file);
}

/** Every measurement file as arrays of rows. */
export function readLedger(dp) {
  const m = files(dp);
  return {
    runs: readRows(m.runs),
    canaries: readRows(m.canaries),
    detections: readRows(m.detections),
    verdicts: readRows(m.verdicts),
    decoys: readRows(m.decoys),
    controls: readRows(m.controls),
    escapes: readRows(m.escapes),
  };
}

function modelFor(run, role) {
  const e = (run?.models?.optIn ?? []).find((x) => x && x.role === role);
  return e?.model ?? 'default';
}

function lensInfo(lenses, id) {
  if (!id) return null;
  const l = (lenses ?? []).find((x) => x && x.id === id);
  return { id, title: l?.title ?? null, sha: l ? hashJson(l) : null };
}

/**
 * Row for verdicts.jsonl from a cluster after the gate (SPEC 9.12, 14.7).
 * Only clusters that went through verification (have evidence) are recorded.
 */
export function verdictRowFromCluster(cluster, { round, roundKind, kind = null } = {}) {
  const ev = (cluster?.evidence ?? []).filter((e) => e && (round === undefined || e.round === round));
  return {
    clusterId: cluster.id,
    clusterOrigin: cluster.origin ?? 'finding',
    claimedSeverity: cluster.claimedSeverity ?? null,
    finalStatus: cluster.status ?? null,
    finalSeverity: cluster.severity ?? null,
    verdicts: ev.map((e) => ({ verdict: e.verdict ?? null, severity: e.severity ?? null })),
    lenses: [...new Set((cluster.members ?? []).map((m) => m.lens).filter(Boolean))].sort(),
    nFinders: new Set((cluster.members ?? []).map((m) => `${m.job ?? ''}#${m.n ?? ''}`)).size,
    kind: kind ?? cluster.kind ?? null,
    grounded: Boolean(cluster.grounded),
    roundKind: roundKind ?? null,
  };
}

function existingKeys(file, keyOf) {
  return new Set(readRows(file).map(keyOf));
}

/**
 * appendRunRows(dataPaths, { run, round, roundKind, instrumentId, lenses, key, detections, verdicts,
 *                            templateSha?, materialChars?, jobModels?, seeded? })
 *   run         run.json (runId, artifactType, models)
 *   key         the revealed canary key of the round (or null when no canary was planted)
 *   detections  detections.json rows (SPEC 9.11)
 *   verdicts    rows from verdictRowFromCluster (or the same shape)
 *   jobModels   { <job>: model|null } from jobs.json (confirm-extra reviewers use another model)
 * Idempotent per (runId, round, canary) and (runId, round, canary, job, attempt) and
 * (runId, round, clusterId): a repeated close of the same round adds nothing twice.
 * -> { canaries, detections, verdicts, decoys, controls } counts appended
 */
export function appendRunRows(dp, input) {
  const m = files(dp);
  const { run, round, key = null, lenses = [], detections = [], verdicts = [] } = input;
  if (!run?.runId) throw new UsageError('appendRunRows: run.runId missing');
  if (!Number.isInteger(round)) throw new UsageError('appendRunRows: round must be an integer');
  const taxonomy = input.taxonomy ?? loadTaxonomy();
  const runId = run.runId;
  const roundKind = input.roundKind ?? null;
  const instrumentId = input.instrumentId ?? null;
  const lensSetId = input.lensSetId ?? null;
  const artifactType = run.artifactType ?? null;
  // Pre-planted canaries (a fixed key reused from an earlier run, e.g. the bench) are not
  // independent measurements: the lenses may have been written knowing them. They are kept but marked
  // contaminated, so recall, slot balancing and the report's cross-run figures leave them out.
  const prePlantedIds = new Set((key?.canaries ?? []).filter((c) => c.prePlanted).map((c) => c.canary));
  // A run with a fixed (bench) key is contaminated as a whole: the key is known in advance and
  // reused every round, whether or not its edits were pre-planted.
  const benchRun = Boolean(input.fixedKey ?? run?.canaries?.fixedKey);
  const counts = { canaries: 0, detections: 0, verdicts: 0, decoys: 0, controls: 0 };

  const haveC = existingKeys(m.canaries, (r) => `${r.runId}|${r.round}|${r.canary}`);
  for (const c of key?.canaries ?? []) {
    const k = `${runId}|${round}|${c.canary}`;
    if (haveC.has(k)) continue;
    append(m.canaries, {
      runId,
      round,
      roundKind,
      canary: c.canary,
      purpose: c.purpose,
      type: c.type,
      omission: Boolean(taxonomy.byId(c.type)?.omission),
      targetLens: lensInfo(lenses, c.targetLens),
      band: c.band ?? null,
      positionFraction: typeof c.positionFraction === 'number' ? c.positionFraction : null,
      intendedSeverity: c.intendedSeverity ?? null,
      validatorSeverity: c.validatorSeverity ?? null,
      description: c.description ?? '',
      planterModel: c.prePlanted ? null : modelFor(run, 'planter'),
      planterIndependent: !c.prePlanted,
      prePlanted: Boolean(c.prePlanted),
      artifactType,
      instrumentId,
      lensSetId,
      materialChars: input.materialChars ?? null,
      seeded: Boolean(input.seeded),
      contaminated: benchRun || Boolean(c.prePlanted),
    });
    counts.canaries++;
  }

  const haveD = existingKeys(m.detections, (r) => `${r.runId}|${r.round}|${r.canary}|${r.job}|${r.attempt}`);
  for (const d of detections ?? []) {
    const k = `${runId}|${round}|${d.canary}|${d.job}|${d.attempt}`;
    if (haveD.has(k)) continue;
    const jm = input.jobModels ?? {};
    append(m.detections, {
      runId,
      round,
      roundKind,
      canary: d.canary,
      purpose: d.purpose ?? null,
      targetLens: d.targetLens ?? null,
      lens: d.lens ?? null,
      job: d.job,
      attempt: d.attempt ?? 1,
      reviewerModel: Object.prototype.hasOwnProperty.call(jm, d.job) ? jm[d.job] ?? 'default' : modelFor(run, 'reviewer'),
      instrumentId,
      lensSetId,
      templateSha: input.templateSha ?? null,
      outcome: d.outcome,
      stage: d.stage ?? null,
      matcherScore: d.matcherScore ?? null,
      severityGiven: d.severityGiven ?? null,
      artifactType,
      contaminated: benchRun || prePlantedIds.has(d.canary),
    });
    counts.detections++;
  }

  // Decoys: false findings shown to verifiers (SPEC 14.11). One row per (decoy, verifier job).
  const haveX = existingKeys(m.decoys, (r) => `${r.runId}|${r.round}|${r.decoy}|${r.wave}|${r.pass}|${r.job}`);
  for (const x of input.decoys ?? []) {
    const k = `${runId}|${round}|${x.decoy}|${x.wave}|${x.pass}|${x.job}`;
    if (haveX.has(k)) continue;
    append(m.decoys, { runId, round, roundKind, instrumentId, artifactType, ...x, contaminated: benchRun });
    counts.decoys++;
  }

  // True controls: real defects shown to verifiers (SPEC 14.12). One row per (control, verifier job).
  const haveK = existingKeys(m.controls, (r) => `${r.runId}|${r.round}|${r.control}|${r.wave}|${r.pass}|${r.job}`);
  for (const x of input.controls ?? []) {
    const k = `${runId}|${round}|${x.control}|${x.wave}|${x.pass}|${x.job}`;
    if (haveK.has(k)) continue;
    append(m.controls, { runId, round, roundKind, instrumentId, artifactType, ...x, contaminated: benchRun });
    counts.controls++;
  }

  const haveV = existingKeys(m.verdicts, (r) => `${r.runId}|${r.round}|${r.clusterId}`);
  for (const v of verdicts ?? []) {
    const k = `${runId}|${round}|${v.clusterId}`;
    if (v.clusterId && haveV.has(k)) continue;
    append(m.verdicts, { runId, round, roundKind: v.roundKind ?? roundKind, instrumentId, artifactType, ...v, contaminated: benchRun });
    counts.verdicts++;
  }
  return counts;
}

/**
 * appendRunEnd(dataPaths, summary) — one row per run end (a run that is continued and
 * stops again gets another row; readers take the last row per runId).
 * summary: { runId, project, artifactType, instrumentId, models, lenses, rounds, confirms,
 *            decision, tokens, tokensEstimated, durationMin, seeded }
 */
export function appendRunEnd(dp, summary) {
  const m = files(dp);
  if (!summary?.runId) throw new UsageError('appendRunEnd: runId missing');
  return append(m.runs, {
    runId: summary.runId,
    project: summary.project ?? null,
    artifactType: summary.artifactType ?? null,
    instrumentId: summary.instrumentId ?? null,
    lensSetId: summary.lensSetId ?? null,
    models: summary.models ?? {},
    lenses: summary.lenses ?? [],
    rounds: summary.rounds ?? 0,
    confirms: summary.confirms ?? 0,
    decision: summary.decision ?? null,
    tokens: summary.tokens ?? 0,
    tokensEstimated: Boolean(summary.tokensEstimated),
    durationMin: summary.durationMin ?? null,
    seeded: Boolean(summary.seeded),
    fixedKey: Boolean(summary.fixedKey),
    contaminated: Boolean(summary.fixedKey),
  });
}

/** appendEscape(dataPaths, { runId, description, severity, lens, foundBy }) — a real problem found after "done". */
export function appendEscape(dp, escape) {
  const m = files(dp);
  const e = escape ?? {};
  if (!e.runId || typeof e.runId !== 'string') throw new UsageError('add-escape: --run is required');
  if (typeof e.description !== 'string' || e.description.trim().length < 5) throw new UsageError('add-escape: --description is required');
  if (!['blocker', 'major'].includes(e.severity)) throw new UsageError('add-escape: --severity must be blocker or major');
  const foundBy = e.foundBy ?? 'owner';
  if (!ESCAPE_FOUND_BY.includes(foundBy)) throw new UsageError(`add-escape: --found-by must be one of ${ESCAPE_FOUND_BY.join(', ')}`);
  const lens = !e.lens ? 'none' : String(e.lens);
  // The chain line's own `ts` is the time of the entry.
  // Same rule as every owner decision: the owner's words as he said them, and the exact question they answer.
  const words = ownerWords(e.ownerQuote, e.question ?? null, { what: 'add-escape: --owner-quote' });
  return append(m.escapes, { runId: e.runId, description: e.description, severity: e.severity, lens, foundBy, ownerQuote: words.quote, question: words.question, contaminated: false });
}

/**
 * ledgerCounts(dataPaths, { artifactType, instrumentId }) -> { byType, byBand, omission }
 *   byType   canaries per type for (artifactType, instrumentId)
 *   byBand   canaries per band for the artifact type
 *   omission omission canaries for the artifact type
 * Contaminated (legacy) rows are not counted: their planters knew the checklists.
 */
export function ledgerCounts(dp, { artifactType = null, instrumentId = null } = {}) {
  const rows = readRows(files(dp).canaries).filter((r) => !r.contaminated);
  const byType = {};
  const byBand = {};
  let omission = 0;
  for (const r of rows) {
    if (artifactType && r.artifactType !== artifactType) continue;
    if (r.band) byBand[r.band] = (byBand[r.band] ?? 0) + 1;
    if (r.omission) omission++;
    if (instrumentId && r.instrumentId !== instrumentId) continue;
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }
  return { byType, byBand, omission };
}
