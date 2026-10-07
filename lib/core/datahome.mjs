// The data home: anchors, runs index, sealed canary keys, measurement ledger (SPEC 7).
//
// Resolution order:
//   1. env GAUNTLET_DATA
//   2. otherwise <home>/gauntlet-data
// Created on first use.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeInput } from './paths.mjs';
import { UsageError } from './errors.mjs';

/** Data home path. opts: { env, home, create = true } */
export function dataHome(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  let dir;
  if (env.GAUNTLET_DATA && env.GAUNTLET_DATA.trim() !== '') {
    dir = normalizeInput(env.GAUNTLET_DATA, { home });
  } else {
    dir = path.join(home, 'gauntlet-data');
  }
  if (opts.create !== false) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function safeId(id, what) {
  const s = String(id);
  if (!SAFE_ID.test(s) || s.includes('..')) throw new UsageError(`unsafe ${what}: ${s}`);
  return s;
}

/** Every path inside the data home. `home` defaults to dataHome(). */
export function dataPaths(home) {
  const root = home ?? dataHome();
  const m = path.join(root, 'measurements');
  const sealedRoot = path.join(root, 'sealed');
  return {
    root,
    anchors: path.join(root, 'anchors.jsonl'),
    runsIndex: path.join(root, 'runs-index.jsonl'),
    sealedRoot,
    sealedDir: (runId) => path.join(sealedRoot, safeId(runId, 'runId')),
    sealedKey: (runId, round) => path.join(sealedRoot, safeId(runId, 'runId'), `${safeId(round, 'round')}.key.json`),
    measurementsDir: m,
    measurements: {
      runs: path.join(m, 'runs.jsonl'),
      canaries: path.join(m, 'canaries.jsonl'),
      detections: path.join(m, 'detections.jsonl'),
      verdicts: path.join(m, 'verdicts.jsonl'),
      decoys: path.join(m, 'decoys.jsonl'),
      controls: path.join(m, 'controls.jsonl'),
      escapes: path.join(m, 'escapes.jsonl'),
    },
    statsMd: path.join(m, 'STATS.md'),
    statsJson: path.join(m, 'STATS.json'),
    selftestDir: path.join(root, 'selftest'),
    templatesApproved: path.join(root, 'templates-approved.json'),
  };
}

/** Every chained file of the data home (for `ledger verify-chain`, `doctor`, `audit`). */
export function chainedFiles(paths = dataPaths()) {
  return [paths.anchors, paths.runsIndex, ...Object.values(paths.measurements)];
}
