// `done` (SPEC 11.8): bind the result to the live files.
//
// Only after the gate said DONE. The live material is re-hashed with the manifest rules; equal to
// the confirm round's version hash -> DONE.json, report "готово", state DONE. Different -> the
// report says the files changed after the review (listing them), state stays STOPPED: a new
// confirm round or a new run is needed. Detection, not prevention (failure point 15).
// Before "готово" the audit runs: any failed check (a broken chain, a recomputed FROZEN.json,
// templates differing from the MANIFEST, a gate that does not replay, ...) refuses done with
// exit 3. A bench run (canaries.fixedKey) is a check with a known key and is never declared done.
// On a mismatch an existing DONE.json is rewritten with equal:false, so nothing still says "equal".

import { UsageError, IntegrityError } from '../core/errors.mjs';
import { writeJsonAtomic, exists, readJson } from '../core/fsx.mjs';
import { hashJson } from '../core/hash.mjs';
import { now } from '../core/clock.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { openRun, move, readJsonIf } from './state.mjs';
import { countedRounds, writeReport, stopResultFrom, modelsPerRole, tokenSummary } from './round.mjs';

/** Files that differ between two manifests: [{ rel, change: 'changed'|'added'|'removed' }]. */
export function manifestDiff(a, b) {
  const ma = new Map((a?.files || []).map((f) => [f.rel, f.sha256]));
  const mb = new Map((b?.files || []).map((f) => [f.rel, f.sha256]));
  const out = [];
  for (const [rel, sha] of ma) {
    if (!mb.has(rel)) out.push({ rel, change: 'removed' });
    else if (mb.get(rel) !== sha) out.push({ rel, change: 'changed' });
  }
  for (const rel of mb.keys()) if (!ma.has(rel)) out.push({ rel, change: 'added' });
  return out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

/** The round whose gate said DONE (the confirm round), or null. */
export function doneRound(rc) {
  const rounds = countedRounds(rc);
  for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i].gate.decision === 'DONE') return rounds[i];
  return null;
}

/** Live material vs DONE.json / the confirm round. -> { equal, changed, liveVersionHash, reviewedVersionHash } */
export function liveCheck(rc) {
  const dr = doneRound(rc);
  if (!dr) return null;
  const live = buildManifest(rc.run, { countsFor: [] });
  const reviewed = readJsonIf(rc.paths.roundDir(dr.n).manifest, null);
  const reviewedHash = dr.gate.versionHash;
  return {
    round: dr.n,
    equal: live.versionHash === reviewedHash,
    changed: live.versionHash === reviewedHash ? [] : manifestDiff(reviewed, live),
    liveVersionHash: live.versionHash,
    reviewedVersionHash: reviewedHash,
    gate: dr.gate,
  };
}

async function runEnd(rc) {
  try {
    const m = await import('../measure/mledger.mjs');
    const counted = countedRounds(rc);
    const t = tokenSummary(rc);
    const lenses = readJsonIf(rc.paths.lenses, { lenses: [] });
    const start = Date.parse(rc.run.createdAt || '') || null;
    m.appendRunEnd(rc.dataPaths, {
      runId: rc.runId,
      project: rc.run.project,
      artifactType: rc.run.artifactType,
      instrumentId: rc.frozen?.instrumentId ?? null,
      lensSetId: rc.frozen?.lensSetId ?? rc.frozen?.sha256?.lenses ?? null,
      fixedKey: !!rc.run.canaries?.fixedKey,
      models: modelsPerRole(rc.run),
      lenses: (lenses.lenses || []).map((l) => l.id),
      rounds: counted.length,
      confirms: counted.filter((r) => r.gate.kind === 'confirm').length,
      decision: rc.state.state === 'DONE' ? 'DONE' : 'EDITED_AFTER_REVIEW',
      tokens: t.spent,
      tokensEstimated: t.estimatedJobs > 0,
      durationMin: start ? Math.max(0, Math.round((Date.parse(now()) - start) / 60000)) : null,
      seeded: counted.some((r) => r.round?.seeded),
    });
  } catch (e) {
    rc.warnings.push(`measurement ledger: run row not written (${e.message})`);
  }
}

/** done(runDir, ctx) -> { exitCode: 30, state, payload, text } */
export async function done(runDir, ctx = {}) {
  const rc = openRun(runDir, ctx, { states: ['STOPPED', 'DONE'], command: 'done' });
  if (rc.state.lastDecision !== 'DONE') {
    throw new UsageError(`done is allowed only after the decision DONE (the last decision is ${rc.state.lastDecision || 'none'})`);
  }
  if (rc.run.canaries?.fixedKey) {
    throw new UsageError('a bench run (canaries.fixedKey) reuses a known canary key: it is a check of the reviewers, never a result, and cannot be declared done. Show the bench numbers with report, then abort the run');
  }
  const chk = liveCheck(rc);
  if (!chk) throw new UsageError('no round with the decision DONE was found');
  if (chk.equal) {
    const { audit } = await import('./audit.mjs');
    const a = audit(rc.runDir, rc.ctx, { automatic: true });
    // 'report' compares the numbers of the last report with the run files; the report is rewritten
    // below, so only the integrity checks decide here.
    const failed = (a.checks || []).filter((c) => !c.ok && c.id !== 'report');
    if (failed.length) {
      await writeReport(rc);
      throw new IntegrityError(
        'AUDIT_FAILED',
        `done refused: the audit failed (${failed.map((c) => c.id).join(', ')}):\n  ${failed.flatMap((c) => (c.details || []).slice(0, 3)).join('\n  ')}\nThe run stays STOPPED; show the owner the report, never "repair" hashes or ledgers`,
        { failed: failed.map((c) => c.id) },
      );
    }
    if (!exists(rc.paths.done)) {
      writeJsonAtomic(rc.paths.done, {
        schemaVersion: 1,
        runId: rc.runId,
        round: chk.round,
        reviewedVersionHash: chk.reviewedVersionHash,
        finalVersionHash: chk.liveVersionHash,
        equal: true,
        gateSha256: hashJson(chk.gate),
        at: now(),
      });
    }
    move(rc, 'done', { stoppedReason: null }, 'done', { equal: true, round: chk.round, versionHash: chk.liveVersionHash }, chk.round);
    await runEnd(rc);
    const rep = await writeReport(rc);
    const res = stopResultFrom(rc, 'DONE', rep);
    res.text = `Готово: the live files are exactly the version the confirm round reviewed.\n${res.text}`;
    return res;
  }
  const list = chk.changed.map((c) => `${c.rel} (${c.change})`);
  if (exists(rc.paths.done)) {
    // A DONE.json written by an earlier `done` must not keep saying "equal" after an edit.
    const old = readJson(rc.paths.done);
    writeJsonAtomic(rc.paths.done, { ...old, equal: false, liveVersionHash: chk.liveVersionHash, changed: chk.changed, checkedAt: now() });
  }
  move(
    rc,
    'done-mismatch',
    { stoppedReason: `edited-after-review: ${list.join(', ')}` },
    'done',
    { equal: false, round: chk.round, reviewedVersionHash: chk.reviewedVersionHash, liveVersionHash: chk.liveVersionHash, changed: chk.changed },
    chk.round,
  );
  await runEnd(rc);
  const rep = await writeReport(rc);
  const res = stopResultFrom(rc, 'DONE', rep);
  res.payload.editedAfterReview = chk.changed;
  res.text = `EDITED AFTER REVIEW: the live files differ from the reviewed version: ${list.join(', ')}.\nThese edits were not reviewed; a new confirm round (or a new run) is needed.\n${res.text}`;
  return res;
}

export { readJson };
