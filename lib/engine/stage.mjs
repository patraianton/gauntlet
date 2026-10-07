// The sealed stage of a round (SPEC 14.4–14.5, D10).
//
// Until the canary key is revealed, every file that would show where the planted errors are lives
// in the data home's sealed folder, not in the run folder next to the review copy:
//   slots.json, approved.json            which kinds of error go where, and the chosen edits
//   planter-<k>/answer.json, code-checks.json, validator[-<k>]/answer.json
//   prompts/<job>.md                     the planter's and the validator's prompts (they carry the
//                                        slots and the candidate edits)
// The run folder keeps only their hashes (job-issued / answer-ingested events). At reveal (end of the
// reviewer wave, an invalid round, an abort, a round closed without review) unstage() moves them into
// rounds/NN/ where audit and the report read them.
//
// The decoys (false findings mixed into verifier batches) have a stage of their own,
// <NN>-decoy-stage: the decoy writer's answer, the chosen decoys, which verifier items they became and
// the verdicts on them. It stays sealed until the round closes (the verifiers are still working after
// the canary key is revealed) and moves into rounds/NN/ by unstageDecoys().

import fs from 'node:fs';
import path from 'node:path';
import { listFiles, exists, ensureDir, safeRemove } from '../core/fsx.mjs';
import { readJsonIf } from './state.mjs';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** <data home>/sealed/<runId>/<NN>-stage */
export function stageDirOf(dataPaths, runId, n) {
  return path.join(dataPaths.sealedDir(runId), `${pad2(n)}-stage`);
}

export function stageDir(rc, n) {
  return stageDirOf(rc.dataPaths, rc.runId, n);
}

/** <data home>/sealed/<runId>/<NN>-decoy-stage */
export function decoyStageDirOf(dataPaths, runId, n) {
  return path.join(dataPaths.sealedDir(runId), `${pad2(n)}-decoy-stage`);
}

export function decoyStageDir(rc, n) {
  return decoyStageDirOf(rc.dataPaths, rc.runId, n);
}

function decoysRevealed(rc, n) {
  return !!readJsonIf(rc.paths.roundDir(n).roundJson, {})?.decoysRevealed;
}

/**
 * Where a decoy file of round n lives now: in the sealed decoy stage until the round closes, in
 * rounds/NN/ afterwards. Use the result for reading and writing.
 */
export function decoyPath(rc, n, rel) {
  const parts = String(rel).split('/');
  const staged = path.join(decoyStageDir(rc, n), ...parts);
  const final = path.join(rc.paths.roundDir(n).dir, ...parts);
  if (exists(staged)) return staged;
  if (exists(final) || decoysRevealed(rc, n)) return final;
  return staged;
}

function revealed(rc, n) {
  return !!readJsonIf(rc.paths.roundDir(n).roundJson, {})?.revealed;
}

/**
 * Where a canary-phase file of round n lives now: in the sealed stage until the key is revealed,
 * in rounds/NN/ afterwards. Use the result for reading and writing.
 */
export function phasePath(rc, n, rel) {
  const parts = String(rel).split('/');
  const staged = path.join(stageDir(rc, n), ...parts);
  const final = path.join(rc.paths.roundDir(n).dir, ...parts);
  if (exists(staged)) return staged;
  const decoyStaged = path.join(decoyStageDir(rc, n), ...parts);
  if (exists(decoyStaged)) return decoyStaged;
  if (exists(final) || revealed(rc, n)) return final;
  return staged;
}

/** Same lookup without a run context (fake agents, audit). */
export function phasePathOf({ dataPaths, runId, roundDir }, n, rel) {
  const parts = String(rel).split('/');
  const staged = path.join(stageDirOf(dataPaths, runId, n), ...parts);
  if (exists(staged)) return staged;
  const decoyStaged = path.join(decoyStageDirOf(dataPaths, runId, n), ...parts);
  if (exists(decoyStaged)) return decoyStaged;
  return path.join(roundDir, ...parts);
}

/** Move every staged file of round n into rounds/NN/ (at reveal). -> moved relative paths */
export function unstage(rc, n) {
  return moveStage(rc, n, stageDir(rc, n));
}

/** Move the decoy stage of round n into rounds/NN/ (when the round closes). -> moved relative paths */
export function unstageDecoys(rc, n) {
  return moveStage(rc, n, decoyStageDir(rc, n));
}

function moveStage(rc, n, dir) {
  if (!exists(dir)) return [];
  const moved = [];
  for (const rel of listFiles(dir)) {
    const from = path.join(dir, ...rel.split('/'));
    const to = path.join(rc.paths.roundDir(n).dir, ...rel.split('/'));
    ensureDir(path.dirname(to));
    if (exists(to)) {
      // A write-once copy already in place (should not happen): keep it, drop the staged one.
      fs.rmSync(from, { force: true });
      continue;
    }
    try {
      fs.renameSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    }
    moved.push(rel);
  }
  safeRemove(dir);
  return moved;
}
