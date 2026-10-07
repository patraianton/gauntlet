// Round snapshot (SPEC 8, 9.3, 11.2 step 5).
//
// takeSnapshot copies every selected live material file byte-exact into
// <snapshotDir>/<as>/<relInRoot>, then builds the manifest FROM THE SNAPSHOT, so the recorded
// versionHash always describes exactly the bytes that were reviewed (a file edited while the
// snapshot is taken cannot slip in unhashed). unlistedRecent comes from the live roots.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { copyFiles } from '../core/fsx.mjs';
import { selectLiveFiles, manifestOfDir, unlistedRecentOf } from './manifest.mjs';

/**
 * takeSnapshot(run, snapshotDir, { countsFor?, nowMs? }) -> manifest
 * snapshotDir must not exist or be empty.
 */
export function takeSnapshot(run, snapshotDir, opts = {}) {
  if (fs.existsSync(snapshotDir)) {
    if (!fs.statSync(snapshotDir).isDirectory() || fs.readdirSync(snapshotDir).length > 0) {
      throw new UsageError(`snapshot folder is not empty: ${snapshotDir}`);
    }
  }
  fs.mkdirSync(snapshotDir, { recursive: true });
  const selected = selectLiveFiles(run);
  const byRoot = new Map();
  for (const s of selected) {
    if (!byRoot.has(s.as)) byRoot.set(s.as, { root: s.root, rels: [] });
    byRoot.get(s.as).rels.push(s.relInRoot);
  }
  for (const [as, { root, rels }] of byRoot) copyFiles(root.path, rels, path.join(snapshotDir, as));
  const manifest = manifestOfDir(snapshotDir, { countsFor: opts.countsFor });
  manifest.unlistedRecent = unlistedRecentOf(run, selected, opts.nowMs);
  return manifest;
}
