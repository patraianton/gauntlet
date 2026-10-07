// Import of the hand-transcribed 2026-10-05 outcomes (SPEC 14.9).
//
// Every imported row is marked contaminated:true (the person who planted the errors also
// wrote the checklists) and canaries planterIndependent:false. Rows keep their own
// instrumentId strings and are shown only in the legacy table of `ledger stats`.
// The import is idempotent: a row whose legacyId is already in the target file is skipped.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { readJson } from '../core/fsx.mjs';
import { UsageError } from '../core/errors.mjs';
import { appendChained } from '../core/chain.mjs';
import { readRows } from './mledger.mjs';

export const DEFAULT_LEGACY_FILE = fileURLToPath(new URL('../../bench/legacy-2026-10.json', import.meta.url));

// [section of the legacy file, measurement file it goes to]. Aggregate rows
// ({ legacyId, runId, unit, lens, k, n }) stand for cells without a per-pair matrix and
// are stored beside the detection rows.
const SECTIONS = Object.freeze([
  ['runs', 'runs'],
  ['canaries', 'canaries'],
  ['detections', 'detections'],
  ['aggregates', 'detections'],
]);

/** Structural check of a legacy file; returns error strings. */
export function checkLegacy(data) {
  const errors = [];
  if (!data || data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const ids = new Set();
  for (const [section] of SECTIONS) {
    const rows = data?.[section] ?? (section === 'aggregates' ? [] : undefined);
    if (!Array.isArray(rows)) {
      errors.push(`${section} must be an array`);
      continue;
    }
    rows.forEach((r, i) => {
      if (!r || typeof r.legacyId !== 'string' || !r.legacyId) errors.push(`${section}[${i}]: legacyId missing`);
      else if (ids.has(r.legacyId)) errors.push(`${section}[${i}]: duplicate legacyId ${r.legacyId}`);
      else ids.add(r.legacyId);
      if (!r?.runId) errors.push(`${section}[${i}]: runId missing`);
      for (const k of ['seq', 'prev', 'hash', 'ts']) if (r && k in r) errors.push(`${section}[${i}]: reserved key ${k}`);
    });
  }
  for (const [i, d] of (data?.detections ?? []).entries()) {
    if (!['caught', 'seen_underclassified', 'missed'].includes(d?.outcome)) errors.push(`detections[${i}]: bad outcome ${d?.outcome}`);
  }
  for (const [i, a] of (data?.aggregates ?? []).entries()) {
    if (!['pair', 'own-lens'].includes(a?.unit)) errors.push(`aggregates[${i}]: unit must be pair or own-lens`);
    if (!Number.isInteger(a?.k) || !Number.isInteger(a?.n) || a.k < 0 || a.k > a.n) errors.push(`aggregates[${i}]: k/n invalid`);
  }
  return errors;
}

/** importLegacy(dataPaths, file?) -> { added, skipped } */
export function importLegacy(dp, file = DEFAULT_LEGACY_FILE) {
  const data = readJson(path.resolve(file));
  const errors = checkLegacy(data);
  if (errors.length) throw new UsageError(`invalid legacy file: ${errors.slice(0, 10).join('; ')}`, { errors });
  let added = 0;
  let skipped = 0;
  const haveBy = {};
  for (const [section, target] of SECTIONS) {
    const out = dp.measurements[target];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    haveBy[target] ??= new Set(readRows(out).map((r) => r.legacyId).filter(Boolean));
    const have = haveBy[target];
    for (const row of data[section] ?? []) {
      if (have.has(row.legacyId)) {
        skipped++;
        continue;
      }
      const payload = { ...row, contaminated: true };
      if (section === 'canaries') payload.planterIndependent = false;
      appendChained(out, payload);
      have.add(row.legacyId);
      added++;
    }
  }
  return { added, skipped };
}
