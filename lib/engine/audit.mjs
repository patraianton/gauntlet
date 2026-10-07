// `audit` (SPEC 11.9): replay what the run files claim and list every check as pass/fail.
//
//  1 chain       run ledger chain + anchor head; every chained file of the data home; usage.jsonl
//  2 answers     every kept answer file hashes to its `answer-ingested` event (write-once)
//  3 prompts     every prompt copy hashes to jobs.json promptSha256 and its `job-issued` event
//  4 templates   run templates equal FROZEN.json (and the repo MANIFEST of the same version)
//  5 frozen      frozen files equal FROZEN.json; FROZEN.json equals the last freeze/amend/owner event
//  6 gate        decide() replayed on every stored gate-input equals gate.json; hashes equal the events;
//                the input's version hash equals the round manifest, and its lens facts (valid answer,
//                attempts, guarded, caught, own planted-error outcome) are rebuilt from the round files
//                (jobs, ingest records, canary key, detections) and must match (r3-f17). The input's
//                clusters are NOT rebuilt: clusters.json is run-level and changes in later rounds; it is
//                guarded by hashes between commands instead (runstore guard).
//  7 report      the numbers logged with the last report equal the run files now
//  8 done        DONE.json: the live material still hashes to finalVersionHash
//  9 reveal      every first-wave reviewer answer was ingested before the canary key was revealed
// 10 state       state.json equals the last state in the ledger
// 11 sample      the sealed sample of large data files (sample.json) of every round hashes to the
//                `sampleCommitment` of that round's `canary-commit` event (SPEC 14.10)
// 12 decoys      the false findings mixed into verifier batches: revealed key equals its commitment, revealed
//                only after every verifier answer of the round was ingested, and none of them is a cluster
// 13 controls    the true controls (real planted defects) mixed into verifier batches: the key was committed
//                (controls-sealed event, hash equal to the round's commitment) BEFORE the first verifier was
//                asked, revealed only after every verifier answer of the round was ingested, revealed key
//                equals its commitment, and none of them is a cluster (SPEC 14.12)
// Writes AUDIT.json and logs `audit`. `ok` is false when any check fails.

import fs from 'node:fs';
import path from 'node:path';
import { IntegrityError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, exists, readRaw, listFiles } from '../core/fsx.mjs';
import { sha256Hex, hashJson, hashFile } from '../core/hash.mjs';
import { canonical } from '../core/canon.mjs';
import { readChained, verifyChained } from '../core/chain.mjs';
import { controlLedgerProblems } from './control-run.mjs';
import { chainedFiles } from '../core/datahome.mjs';
import { verifyRunIntegrity } from '../core/runstore.mjs';
import { assertFrozen } from '../core/config.mjs';
import { now } from '../core/clock.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { openRun, log, roundNumbers, readJsonIf } from './state.mjs';
import { decide } from './gate.mjs';
import { reportNumbers, lensFacts, sampleSealProblem } from './round.mjs';
import { phasePath } from './stage.mjs';

function check(id, ok, details = []) {
  return { id, ok: !!ok, details: details.slice(0, 50) };
}

function gateComparable(g) {
  if (!g) return null;
  const { schemaVersion: _s, ...rest } = g;
  return canonical(rest);
}

/**
 * audit(runDir, ctx, { automatic, record, rebuildingReport, reportNumbers }) -> { ok, checks, notCompared, reportNumbers }
 * record: false -> nothing is written (no AUDIT.json, no ledger event); used by `report --summary`.
 * rebuildingReport: the caller writes a new report right after this audit. Check 7 then has no old
 *   report to judge (an old report is by definition older than the events that made the caller rebuild it);
 *   it compares the numbers the caller is about to log (`reportNumbers`) with the numbers read afresh from the files.
 * notCompared: comparisons that could not be made (not failures, never silent): the run was frozen by
 *   another version of the program (`frozen`), or the report on disk is older than the last events of the run (`report`).
 * reportNumbers: the numbers of the report, read afresh from the run files by this audit.
 */
export function audit(runDir, ctx = {}, opts = {}) {
  const checks = [];
  const notCompared = [];
  let rc;
  try {
    rc = openRun(runDir, ctx, { command: 'audit', tolerateToolDrift: true });
  } catch (e) {
    // A changed frozen file is not a broken chain: name the check that failed.
    const res = { ok: false, checks: [check(e.code === 'FROZEN_MISMATCH' ? 'frozen' : 'chain', false, [`${e.code || e.name}: ${e.message}`])], notCompared };
    // Without an intact chain nothing else can be trusted; record what we can.
    try {
      if (opts.record !== false) writeJsonAtomic(path.join(runDir, 'AUDIT.json'), { schemaVersion: 1, at: now(), ...res });
    } catch {
      /* ignore */
    }
    return res;
  }
  const lines = readChained(rc.paths.ledger);

  // 1. chains
  {
    const details = [];
    try {
      verifyRunIntegrity(rc.runDir, { dataPaths: rc.dataPaths });
    } catch (e) {
      details.push(e.message);
    }
    for (const f of [...chainedFiles(rc.dataPaths), rc.paths.usage]) {
      if (!exists(f)) continue;
      const v = verifyChained(f);
      if (!v.ok) details.push(`${f}: chain broken at line ${v.firstBrokenSeq}`);
    }
    checks.push(check('chain', details.length === 0, details));
  }

  // 2. answers write-once
  {
    const details = [];
    let n = 0;
    for (const l of lines.filter((x) => x.type === 'answer-ingested')) {
      let dest = l.data?.dest ? path.join(rc.runDir, ...String(l.data.dest).split('/')) : null;
      if (!dest) continue;
      // Planter and validator answers sit in the sealed stage until the key is revealed.
      const m = /^rounds\/(\d{2,})\/(.+)$/.exec(String(l.data.dest));
      if (!exists(dest) && m) dest = phasePath(rc, Number(m[1]), m[2]);
      n++;
      if (!exists(dest)) details.push(`missing answer file ${l.data.dest}`);
      else if (sha256Hex(readRaw(dest)) !== l.data.sha256) details.push(`answer ${l.data.dest} changed after ingest`);
    }
    checks.push(check('answers', details.length === 0, details.length ? details : [`${n} answers verified`]));
  }

  // 3. prompts
  {
    const details = [];
    const issued = new Map();
    for (const l of lines.filter((x) => x.type === 'job-issued' && x.data?.promptSha256)) issued.set(l.data.job, { sha: l.data.promptSha256, round: l.round });
    for (const [job, info] of issued) {
      let promptCopy = null;
      let jobRec = null;
      if (info.round != null) {
        const rp = rc.paths.roundDir(info.round);
        promptCopy = path.join(rp.prompts, `${job}.md`);
        if (!exists(promptCopy)) promptCopy = phasePath(rc, info.round, `prompts/${job}.md`);
        const jobs = readJsonIf(rp.jobs, { jobs: [] }).jobs;
        jobRec = jobs.find((j) => j.job === job) || null;
      } else {
        for (const d of exists(rc.paths.setupDir) ? fs.readdirSync(rc.paths.setupDir) : []) {
          const p = path.join(rc.paths.setupDir, d, `${job}.md`);
          if (exists(p)) promptCopy = p;
          const jr = readJsonIf(path.join(rc.paths.setupDir, d, 'job.json'), null);
          if (jr && jr.job === job) jobRec = jr;
        }
      }
      if (!promptCopy || !exists(promptCopy)) details.push(`prompt copy of job ${job} is missing`);
      else if (sha256Hex(readRaw(promptCopy)) !== info.sha) details.push(`prompt copy of job ${job} differs from the issued prompt`);
      if (!jobRec) details.push(`job ${job} is missing from its jobs file`);
      else if (jobRec.promptSha256 !== info.sha) details.push(`jobs file promptSha256 of ${job} differs from the job-issued event`);
    }
    checks.push(check('prompts', details.length === 0, details.length ? details : [`${issued.size} prompts verified`]));
  }

  // 4. templates
  {
    const details = [];
    const frozen = rc.frozen;
    const runTpl = {};
    if (exists(rc.paths.templatesDir)) for (const rel of listFiles(rc.paths.templatesDir)) runTpl[rel] = hashFile(path.join(rc.paths.templatesDir, rel));
    if (frozen) {
      const want = frozen.sha256?.templates || {};
      for (const k of new Set([...Object.keys(want), ...Object.keys(runTpl)])) if (want[k] !== runTpl[k]) details.push(`run template ${k} differs from FROZEN.json`);
    }
    const initEv = lines.find((l) => l.type === 'init');
    const manifestPath = path.join(rc.ctx.repoDir || '', 'templates', 'MANIFEST.json');
    if (rc.ctx.repoDir && exists(manifestPath)) {
      const man = readJsonIf(manifestPath, null);
      const recorded = initEv?.data?.templatesManifestVersion ?? null;
      if (man && recorded != null && String(man.version) === String(recorded)) {
        for (const [name, sha] of Object.entries(man.files || {})) {
          const p = path.join(rc.paths.templatesDir, name);
          if (!exists(p)) continue;
          const raw = sha256Hex(readRaw(p));
          const norm = hashFile(p);
          if (sha !== raw && sha !== norm) details.push(`run template ${name} differs from the repository MANIFEST (version ${man.version})`);
        }
      }
    }
    checks.push(check('templates', details.length === 0, details));
  }

  // 5. frozen
  {
    const details = [];
    if (exists(rc.paths.frozen)) {
      try {
        const fz = assertFrozen(rc.runDir, { repoDir: rc.ctx.repoDir, tolerateToolDrift: true });
        if (fz?.toolDrift) notCompared.push({ id: 'frozen', kind: 'tool-version', ...fz.toolDrift });
      } catch (e) {
        details.push(e.message);
      }
      const ev = [...lines].reverse().find((l) => ['freeze', 'amend', 'owner-decision'].includes(l.type) && l.data?.frozenSha256);
      if (ev && ev.data.frozenSha256 !== hashJson(readJson(rc.paths.frozen))) details.push('FROZEN.json differs from the last freeze/amend/owner event');
    }
    checks.push(check('frozen', details.length === 0, details));
  }

  // 6. gate replay
  {
    const details = [];
    let replayed = 0;
    for (const n of roundNumbers(rc)) {
      const rp = rc.paths.roundDir(n);
      const g = readJsonIf(rp.gate, null);
      if (!g) continue;
      const ev = [...lines].reverse().find((l) => l.type === 'gate' && l.round === n && l.data?.gateSha256);
      if (ev && ev.data.gateSha256 !== hashJson(g)) details.push(`round ${n}: gate.json differs from its gate event`);
      const inputPath = path.join(rp.dir, 'gate-input.json');
      if (!exists(inputPath)) continue; // pre-gate decisions (blocked, invalid) have no input
      const input = readJson(inputPath);
      if (ev && ev.data.inputSha256 && ev.data.inputSha256 !== hashJson(input)) details.push(`round ${n}: gate-input.json differs from its gate event`);
      const { schemaVersion: _s, ...inp } = input;
      const again = decide(inp);
      if (gateComparable(again) !== gateComparable(g)) details.push(`round ${n}: replaying the gate gives ${again.decision}, stored ${g.decision}`);
      const man = readJsonIf(rp.manifest, null);
      if (man && man.versionHash !== inp.versionHash) details.push(`round ${n}: gate input version hash differs from the round manifest`);
      // lens facts rebuilt from the round files (r3-f17); lenses that no longer exist are skipped
      let rebuilt = null;
      try {
        rebuilt = lensFacts(rc, n);
      } catch (e) {
        details.push(`round ${n}: lens facts could not be rebuilt: ${e.message}`);
      }
      const pick = (f) => (f ? { answerValid: !!f.answerValid, attempts: f.attempts, guarded: !!f.guarded, caught: !!f.caught, outcome: f.ownCanary?.outcome ?? null } : null);
      for (const [id, stored] of Object.entries(inp.lensFacts || {})) {
        if (!rebuilt || !rebuilt[id]) continue;
        if (canonical(pick(stored)) !== canonical(pick(rebuilt[id]))) details.push(`round ${n}: lens ${id} facts in the gate input differ from the round files (${canonical(pick(stored))} vs ${canonical(pick(rebuilt[id]))})`);
      }
      replayed++;
    }
    checks.push(check('gate', details.length === 0, details.length ? details : [`${replayed} gate decisions replayed`]));
  }

  // 7. report numbers
  let freshNumbers = null;
  {
    const details = [];
    freshNumbers = reportNumbers(rc);
    if (opts.rebuildingReport) {
      // The report is rewritten by the caller from these same files. An older report would only be
      // compared with a state it was never meant to describe (the owner stopped the run after it), which
      // once made the new report say «НЕ пройдена» about a report that did not exist yet (bug 12).
      if (opts.reportNumbers && canonical(opts.reportNumbers) !== canonical(freshNumbers)) {
        details.push(`the numbers about to be logged with the new report differ from the run files: ${canonical(opts.reportNumbers)} vs ${canonical(freshNumbers)}`);
      }
    } else {
      const lastReport = [...lines].reverse().find((l) => l.type === 'report' && l.data?.numbers);
      if (lastReport) {
        // Every ledger event that moves the state (round close, owner stop, done, continue ...) makes an older
        // report stale on purpose: its numbers are then compared with nothing, and the report says so.
        const laterState = lines.filter((l) => l.seq > lastReport.seq && l.data && l.data.stateAfter);
        if (laterState.length) {
          notCompared.push({ id: 'report', kind: 'stale', events: laterState.length });
        } else {
          let was = lastReport.data.numbers;
          let nowN = freshNumbers;
          // A report logged by another version of the program may carry other fields: compare the common ones, say so.
          const wk = Object.keys(was ?? {}).sort();
          const nk = Object.keys(nowN ?? {}).sort();
          if (wk.join() !== nk.join()) {
            const common = wk.filter((k) => nk.includes(k));
            notCompared.push({ id: 'report', kind: 'fields', fields: [...wk.filter((k) => !nk.includes(k)), ...nk.filter((k) => !wk.includes(k))] });
            was = Object.fromEntries(common.map((k) => [k, was[k]]));
            nowN = Object.fromEntries(common.map((k) => [k, nowN[k]]));
          }
          if (canonical(nowN) !== canonical(was)) {
            details.push(`report numbers differ from the run files: reported ${canonical(was)}, now ${canonical(nowN)}`);
          }
        }
      }
    }
    checks.push(check('report', details.length === 0, details));
  }

  // 8. DONE.json still matches the live files
  {
    const details = [];
    if (exists(rc.paths.done)) {
      const d = readJson(rc.paths.done);
      const live = buildManifest(rc.run, { countsFor: [] });
      if (live.versionHash !== d.finalVersionHash) details.push('UNREVIEWED CHANGES: the live material differs from the version recorded in DONE.json');
    }
    checks.push(check('done', details.length === 0, details));
  }

  // 9. reveal order
  {
    const details = [];
    for (const rev of lines.filter((l) => l.type === 'canary-reveal')) {
      const n = rev.round;
      const round = readJsonIf(rc.paths.roundDir(n).roundJson, {});
      for (const job of round.wave1Jobs || []) {
        const ing = lines.find((l) => (l.type === 'answer-ingested' || l.type === 'job-given-up') && l.data?.job === job);
        // A reveal that ends the round early (abort, invalid round) legitimately precedes jobs that
        // never answered; an answer ingested after any reveal is still a failure.
        const endsRound = rev.data?.aborted === true || rev.data?.invalidRound === true;
        if (!ing && endsRound) continue;
        if (!ing || ing.seq > rev.seq) details.push(`round ${n}: the key was revealed before the answer of job ${job} was ingested`);
      }
    }
    checks.push(check('reveal', details.length === 0, details));
  }

  // 10. state cache
  {
    const details = [];
    const last = [...lines].reverse().find((l) => l.data && l.data.stateAfter);
    const st = readJsonIf(rc.paths.state, null);
    if (last && st && hashJson(st) !== hashJson(last.data.stateAfter)) details.push('state.json differs from the ledger');
    checks.push(check('state', details.length === 0, details));
  }

  // 11. sealed sample of large data files
  {
    const details = [];
    const rounds = [...new Set(lines.filter((l) => l.type === 'canary-commit').map((l) => l.round))];
    for (const n of rounds) {
      let problem = null;
      try {
        problem = sampleSealProblem(rc, n, lines);
      } catch (e) {
        problem = `round ${n}: the sample could not be checked: ${e.message}`;
      }
      if (problem) details.push(problem);
    }
    checks.push(check('sample', details.length === 0, details));
  }

  // 12. decoys (SPEC 14.11)
  {
    const details = [];
    const clusterIds = new Set((readJsonIf(rc.paths.clusters, { clusters: [] }).clusters || []).map((c) => c.id));
    let n = 0;
    for (const num of roundNumbers(rc)) {
      const rp = rc.paths.roundDir(num);
      const round = readJsonIf(rp.roundJson, {});
      if (!round.decoyCommitment) continue;
      n++;
      if (!round.decoysRevealed) {
        if (round.closedAt) details.push(`round ${num}: the decoys were not revealed when the round closed`);
        continue;
      }
      const key = readJsonIf(path.join(rp.dir, 'decoys.json'), null);
      if (!key) details.push(`round ${num}: decoys.json is missing`);
      else if (hashJson(key) !== round.decoyCommitment) details.push(`round ${num}: the revealed decoys differ from their commitment`);
      const rev = lines.find((l) => l.type === 'decoy-reveal' && l.round === num);
      if (!rev) details.push(`round ${num}: no decoy-reveal event`);
      else {
        for (const l of lines.filter((x) => x.round === num && x.type === 'answer-ingested' && x.data?.role === 'verifier')) {
          if (l.seq > rev.seq) details.push(`round ${num}: the decoys were revealed before the answer of job ${l.data.job} was ingested`);
        }
      }
      const mix = readJsonIf(path.join(rp.dir, 'decoy-mix.json'), { items: [] });
      for (const it of mix.items || []) if (clusterIds.has(it.cluster)) details.push(`round ${num}: decoy ${it.decoy} became cluster ${it.cluster}`);
    }
    checks.push(check('decoys', details.length === 0, details.length ? details : [`${n} round(s) with decoys verified`]));
  }

  // 13. true controls (SPEC 14.12)
  {
    const details = [];
    const clusterIds = new Set((readJsonIf(rc.paths.clusters, { clusters: [] }).clusters || []).map((c) => c.id));
    let n = 0;
    for (const num of roundNumbers(rc)) {
      const rp = rc.paths.roundDir(num);
      const round = readJsonIf(rp.roundJson, {});
      const problems = controlLedgerProblems(num, round, lines);
      if (!round.controlCommitment) {
        // no commitment in round.json: only a problem when the (hash-chained) ledger says controls were sealed
        details.push(...problems);
        continue;
      }
      n++;
      details.push(...problems);
      if (!round.decoysRevealed) continue;
      const key = readJsonIf(path.join(rp.dir, 'controls.json'), null);
      if (!key) details.push(`round ${num}: controls.json is missing`);
      else if (hashJson(key) !== round.controlCommitment) details.push(`round ${num}: the revealed controls differ from their commitment`);
      const mix = readJsonIf(path.join(rp.dir, 'control-mix.json'), { items: [] });
      for (const it of mix.items || []) if (clusterIds.has(it.cluster)) details.push(`round ${num}: control ${it.control} became cluster ${it.cluster}`);
    }
    checks.push(check('controls', details.length === 0, details.length ? details : [`${n} round(s) with controls verified`]));
  }

  const ok = checks.every((c) => c.ok);
  const res = { ok, checks, notCompared, reportNumbers: freshNumbers };
  if (opts.record !== false) {
    writeJsonAtomic(rc.paths.audit, { schemaVersion: 1, at: now(), runId: rc.runId, ok, checks, notCompared });
    log(rc, 'audit', { ok, failed: checks.filter((c) => !c.ok).map((c) => c.id), automatic: !!opts.automatic, ...(notCompared.length ? { notCompared: notCompared.map((n) => `${n.id}:${n.kind}`) } : {}) });
  }
  return res;
}

