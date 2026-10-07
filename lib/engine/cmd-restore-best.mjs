// `restore-best <run> --to <dir> --owner-quote <text> --question <text> [--overwrite]` — on the owner's word (SPEC 10.2).
// Copies the best round's snapshot (the version with the fewest open blockers, then majors; ties
// keep the earlier round) to <dir>. A non-empty <dir> needs --overwrite. Never writes into the live
// roots unless <dir> is exactly one of them and --overwrite is given; then that root is made equal to
// the snapshot: the snapshot's files are written and material files added after the best round are
// removed (only files the material rules select; anything the rules leave out is not touched).
// Afterwards the live material is hashed again and both hashes are printed (r2-f24). The owner's
// words are required and recorded (r2-f19).

import fs from 'node:fs';
import { ownerWords } from '../core/owner.mjs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { exists, listFiles, copyFiles, readJson, writeJsonAtomic } from '../core/fsx.mjs';
import { normalizeInput, isUnder } from '../core/paths.mjs';
import { withLock } from '../core/runstore.mjs';
import { now } from '../core/clock.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { parseArgv, openRun, log, readJsonIf } from './state.mjs';

function same(a, b) {
  const x = normalizeInput(a);
  const y = normalizeInput(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, { flags: ['overwrite'], options: ['to', 'owner-quote', 'question'] });
  if (!positional[0] || !opts.to) throw new UsageError('usage: restore-best <run> --to <dir> --owner-quote <text> --question <text> [--overwrite]');
  const words = ownerWords(opts.ownerQuote, opts.question, { what: "restore-best runs only on the owner's words: --owner-quote" });
  const quote = words.quote;
  return withLock(normalizeInput(positional[0]), async () => {
    const rc = openRun(positional[0], ctx, { command: 'restore-best' });
    if (!exists(rc.paths.best)) throw new UsageError('there is no best round yet');
    const best = readJson(rc.paths.best);
    const snap = rc.paths.roundDir(best.round).snapshot;
    if (!exists(snap)) throw new UsageError(`the snapshot of round ${best.round} was removed`);
    const to = normalizeInput(opts.to);
    const roots = rc.run.material.roots;
    const exact = roots.find((r) => same(r.path, to));
    const inside = roots.find((r) => isUnder(to, r.path) && !same(r.path, to));
    if (inside) throw new UsageError(`${to} lies inside the live material root ${inside.path}; choose a folder outside the material`);
    if (exists(to) && fs.readdirSync(to).length > 0 && !opts.overwrite) throw new UsageError(`${to} is not empty; add --overwrite to write into it`);
    let src = snap;
    let rels;
    const removed = [];
    if (exact) {
      if (!opts.overwrite) throw new UsageError('writing into a live material root needs --overwrite');
      src = path.join(snap, exact.as);
      rels = exists(src) ? listFiles(src) : [];
      // Material files of this root that the best version did not have: removed, so the root is the
      // best version and not a mix of it with later additions.
      const want = new Set(rels);
      const prefix = `${exact.as}/`;
      for (const f of buildManifest(rc.run, { countsFor: [] }).files) {
        if (!f.rel.startsWith(prefix)) continue;
        const rel = f.rel.slice(prefix.length);
        if (!want.has(rel)) removed.push(rel);
      }
    } else {
      rels = listFiles(snap);
    }
    fs.mkdirSync(to, { recursive: true });
    copyFiles(src, rels, to);
    for (const rel of removed) fs.rmSync(path.join(to, ...rel.split('/')), { force: true });
    let liveHash = null;
    if (exact) liveHash = buildManifest(rc.run, { countsFor: [] }).versionHash;
    const od = readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] });
    od.decisions.push({ id: `O${od.decisions.length + 1}`, ts: now(), kind: 'restore-best', quote, question: words.question, round: best.round, to, liveRoot: !!exact });
    writeJsonAtomic(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: od.decisions });
    log(rc, 'cleanup', { what: 'restore-best', round: best.round, to, files: rels.length, removed, liveRoot: !!exact, ownerQuote: quote, liveVersionHash: liveHash, bestVersionHash: best.versionHash ?? null });
    const lines = [`Copied ${rels.length} file(s) of round ${best.round} (the best version) to ${to}.`];
    if (removed.length) lines.push(`Removed ${removed.length} material file(s) the best version did not have: ${removed.slice(0, 20).join(', ')}${removed.length > 20 ? ', ...' : ''}`);
    if (exact) {
      const equal = liveHash === best.versionHash;
      lines.push(`Live material version: ${String(liveHash).slice(0, 16)}; best version: ${String(best.versionHash).slice(0, 16)} — ${equal ? 'equal' : 'NOT equal (other roots or files outside this root differ)'}.`);
    }
    lines.push('NEXT: tell the owner where the best version is');
    return {
      exitCode: 0,
      state: rc.state.state,
      payload: { round: best.round, to, files: rels.length, removed, liveVersionHash: liveHash, bestVersionHash: best.versionHash ?? null },
      text: lines.join('\n'),
    };
  });
}
