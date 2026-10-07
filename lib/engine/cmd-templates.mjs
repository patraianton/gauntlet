// `templates approve --owner-quote <text> --question <text>` / `templates status` (SPEC 10.2, r3-f6).
//
// The repository templates are frozen by templates/MANIFEST.json, but that file sits next to them and
// templates/update-manifest.mjs rewrites it in one line: an executor could weaken reviewer.md, re-run
// the script and pass every hash check. So a template version is usable only after the owner approved
// it: the approval (MANIFEST sha256, version, the owner's words, date) lives in the data home
// (templates-approved.json), outside the repository. `init` refuses a version that is not approved,
// and SETUP-SUMMARY and the report print the version with the owner's approval.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, IntegrityError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, exists } from '../core/fsx.mjs';
import { sha256Hex } from '../core/hash.mjs';
import { now, localDate } from '../core/clock.mjs';
import { dataPaths as defaultDataPaths } from '../core/datahome.mjs';
import { parseArgv } from './state.mjs';
import { ownerWords } from '../core/owner.mjs';
import { computeFiles, readManifest, diffFiles } from '../../templates/update-manifest.mjs';

/** The repository templates checked against their MANIFEST -> { version, manifestSha256 } (throws on a mismatch). */
export function repoTemplates(repoDir) {
  const tplSrc = path.join(repoDir, 'templates');
  const man = readManifest(tplSrc);
  if (!man) throw new IntegrityError('TEMPLATE_MISMATCH', `${tplSrc} has no MANIFEST.json`);
  const d = diffFiles(man.files || {}, computeFiles(tplSrc));
  const bad = [...d.added.map((f) => `${f} (not in MANIFEST)`), ...d.removed.map((f) => `${f} (missing)`), ...d.changed.map((f) => `${f} (changed)`)];
  if (bad.length) throw new IntegrityError('TEMPLATE_MISMATCH', `the repository templates differ from templates/MANIFEST.json version ${man.version}: ${bad.join(', ')}. Restore them (git checkout templates/).`);
  return { version: man.version ?? null, manifestSha256: sha256Hex(fs.readFileSync(path.join(tplSrc, 'MANIFEST.json'))) };
}

export function readApprovals(dp) {
  if (!exists(dp.templatesApproved)) return [];
  const j = readJson(dp.templatesApproved);
  return Array.isArray(j?.approvals) ? j.approvals : [];
}

/** The owner's approval of a MANIFEST sha256, or null. */
export function findApproval(dp, manifestSha256) {
  return readApprovals(dp).find((a) => a && a.manifestSha256 === manifestSha256) ?? null;
}

export function addApproval(dp, entry) {
  const approvals = readApprovals(dp).filter((a) => a.manifestSha256 !== entry.manifestSha256);
  approvals.push(entry);
  writeJsonAtomic(dp.templatesApproved, { schemaVersion: 1, approvals });
}

export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const { opts } = parseArgv(rest, { options: ['owner-quote', 'question'] });
  const dp = ctx.dataPaths ?? defaultDataPaths(ctx.dataHome);
  const cur = repoTemplates(ctx.repoDir);
  if (sub === 'status') {
    const a = findApproval(dp, cur.manifestSha256);
    return {
      exitCode: 0,
      state: null,
      payload: { ...cur, approved: !!a, approval: a },
      text: a
        ? `Templates version ${cur.version} (${cur.manifestSha256.slice(0, 12)}) approved by the owner on ${a.date}: "${a.quote}".`
        : `Templates version ${cur.version} (${cur.manifestSha256.slice(0, 12)}) are NOT approved. Show the owner what changed (git log -p templates/) and, on the owner's words, run templates approve --owner-quote "<the owner's words>" --question "<the exact question you asked the owner>".`,
    };
  }
  if (sub !== 'approve') throw new UsageError('usage: templates status | templates approve --owner-quote <text> --question <text>');
  const words = ownerWords(opts.ownerQuote, opts.question);
  const quote = words.quote;
  const entry = { manifestSha256: cur.manifestSha256, version: cur.version, quote, ...(words.question ? { question: words.question } : {}), date: localDate(), ts: now() };
  addApproval(dp, entry);
  return { exitCode: 0, state: null, payload: entry, text: `Templates version ${cur.version} (${cur.manifestSha256.slice(0, 12)}) approved on the owner's words: "${quote}".\nNEXT: run init` };
}
