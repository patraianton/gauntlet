// One round of the panel (SPEC 11.2–11.7): precheck, snapshot, blind copy, canary slots,
// planter + validator, planted copy with a sealed key, reviewers, reveal, matching, lens validity
// and reruns, clustering, verification, gate, measurement rows, cleanup, to-do.
//
// Every function takes the run context `rc` (state.mjs openRun) and returns either a final
// result { exitCode, state, payload, text } or { next: true } when step should continue in the
// new state within the same call.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, IntegrityError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic, readText, exists, ensureDir, safeRemove, writeExclusive } from '../core/fsx.mjs';
import { hashJson, sha256Hex } from '../core/hash.mjs';
import { readChained } from '../core/chain.mjs';
import { now, isoLocal } from '../core/clock.mjs';
import { buildManifest, manifestOfDir, countFor, positionIndex, skippedLinksOf } from '../material/manifest.mjs';
import { takeSnapshot } from '../material/snapshot.mjs';
import { makeReviewCopy, copyListing, diffListings, isScratchPath, removeScratch, rebuildCopy } from '../material/copy.mjs';
import { jobWindows, buildTamperRecord, ledgerData, tamperLinesRu, scratchLineRu } from './copy-tamper.mjs';
import { runMechanical } from '../material/mechanical.mjs';
import { loadPatterns, scanTrace, lintPath, findQuote, MAX_NOTES_CHARS } from '../material/lint.mjs';
import { makeChallenges, renderChallenges } from '../material/receipts.mjs';
import { writeSourceTexts } from '../material/sources.mjs';
import { traceAdvice } from '../material/trace-advice.mjs';
import { loadRunTemplate } from '../material/render.mjs';
import { matchGlob } from '../core/glob.mjs';
import { loadTaxonomy } from '../measure/taxonomy.mjs';
import { planSlots, slotsFile } from '../measure/slots.mjs';
import { validateCandidate, chooseApproved, applyEdits, buildKey, sealKey, revealKey, validateFixedKey } from '../measure/canary.mjs';
import { stage1, buildMatcherPairs, mergeMatcher, findingsMatched, pairCounts } from '../measure/match.mjs';
import { log, commitState, move, rngFor, readJsonIf, roundNumbers, isSeeded, ledgerLines } from './state.mjs';
import {
  issueJob,
  spawnResult,
  ingestAnswer,
  loadJobs,
  saveJobs,
  reviewerRecord,
  writeIngest,
  readIngest,
  findingsOf,
  normaliseFile,
  storedAnswer,
} from './ingest.mjs';
import {
  taskText,
  sourcesValue,
  materialListValue,
  runSourcesCheck,
  sourceChangeProblems,
  loadStrip,
  loadMechanical,
  loadLenses,
  minimumCountSpecs,
  loadSourcesFile as loadSourcesFileSafe,
  unguardedLenses,
} from './setup.mjs';
import { clusterFindings, attachMembers, requirementClusters } from './cluster.mjs';
import { buildItems, applyVerdicts, selectForVerification, settleCosmetic, settleUnverified, OPEN_SET } from './verify.mjs';
import { pendingDisputes, renderDisputes, applyDisputeAnswer, loadDisputes, saveDisputes } from './dispute.mjs';
import { decide, preGateRecord, isOpenCluster, STOP_DECISIONS } from './gate.mjs';
import { renderTodo } from './cmd-todo.mjs';
import { phasePath, stageDir, unstage } from './stage.mjs';
import {
  decoysActive,
  issueDecoyWriter,
  decoyAnswerDest,
  ingestDecoyWriter,
  decoysForGroup,
  recordPlacement,
  decoyItemIndex,
  recordResults,
  revealDecoys,
  ledgerRowsFor as decoyLedgerRows,
} from './decoy-run.mjs';
import {
  controlsActive,
  sealControls,
  controlsForGroup,
  recordControlPlacement,
  controlItemIndex,
  recordControlResults,
  ledgerRowsFor as controlLedgerRows,
} from './control-run.mjs';
import { controlFailed, playsDown } from '../measure/controls.mjs';
import { stripNarrowing, rebuildOutputsCheck } from './strip-preview.mjs';
import {
  samplingSettings,
  planSample,
  sampleHash,
  sampleView,
  addCanaryRows,
  makeSampleGuard,
  assertStructure,
  clearSampleCaches,
  annotateForPlanter,
  annotateForReviewer,
  jobFile,
} from '../material/sample.mjs';

// ---------------------------------------------------------------- small helpers

export function loadClusters(rc) {
  return readJsonIf(rc.paths.clusters, { schemaVersion: 1, clusters: [] }).clusters || [];
}

export function saveClusters(rc, clusters) {
  writeJsonAtomic(rc.paths.clusters, { schemaVersion: 1, clusters });
}

function rp(rc, n) {
  return rc.paths.roundDir(n);
}

export function readRound(rc, n) {
  return readJsonIf(rp(rc, n).roundJson, null);
}

export function saveRound(rc, n, patch) {
  const cur = readRound(rc, n) || { schemaVersion: 1, round: n };
  const next = { ...cur, ...patch, schemaVersion: 1, round: n };
  writeJsonAtomic(rp(rc, n).roundJson, next);
  return next;
}

function lensById(lensesJson, id) {
  return (lensesJson.lenses || []).find((l) => l.id === id) || null;
}

function giveUpSet(opts) {
  return new Set(opts.giveUp || []);
}

function isGivenUp(opts, job) {
  const g = giveUpSet(opts);
  return g.has('missing') || g.has(job);
}

/** Rounds that reached a gate (or INVALID_ROUND), in order: [{ n, gate, round }] (blocked rounds excluded). */
export function countedRounds(rc, beforeRound = Infinity) {
  const out = [];
  for (const n of roundNumbers(rc)) {
    if (n >= beforeRound) continue;
    const g = readJsonIf(rp(rc, n).gate, null);
    if (!g) continue;
    if (g.decision === 'BLOCKED_PRECHECK' || g.decision === 'BLOCKED_TRACE') continue;
    out.push({ n, gate: g, round: readRound(rc, n) });
  }
  return out;
}

/**
 * Working rounds counted toward maxRounds (r3-f16): a confirm round is counted by maxConfirms
 * instead, so it never uses up a working round. A round without a recorded kind counts as working.
 */
export function workingRoundsCount(rc, beforeRound = Infinity) {
  return countedRounds(rc, beforeRound).filter((r) => (r.round?.kind ?? r.gate?.kind ?? 'working') !== 'confirm').length;
}

/** Gate history of earlier rounds (each counted round's own entry). */
export function historyBefore(rc, n) {
  const out = [];
  for (const r of countedRounds(rc, n)) {
    const h = (r.gate.history || []).find((x) => x.round === r.n);
    // `reviewed`: the reviewers actually read this round (it reached the gate). An INVALID_ROUND, or a
    // round that stopped before the reviewers, has no findings and can never be the best version.
    if (h) out.push({ ...h, reviewed: h.reviewed ?? (r.gate.decision !== 'INVALID_ROUND') });
    else out.push({ round: r.n, kind: r.gate.kind, valid: false, reviewed: false, versionHash: r.gate.versionHash, openBlockers: 0, openMajors: 0, distinctOpen: 0 });
  }
  return out;
}

/** Token totals from usage.jsonl. */
export function tokenSummary(rc) {
  const lines = exists(rc.paths.usage) ? readChained(rc.paths.usage) : [];
  let spent = 0;
  let estimatedJobs = 0;
  let suspectRecords = 0;
  const perRound = {};
  for (const l of lines) {
    spent += Number(l.tokens) || 0;
    if (l.estimated) estimatedJobs += 1;
    if (l.suspect) suspectRecords += 1;
    const k = l.round == null ? 'setup' : String(l.round);
    perRound[k] = perRound[k] || { tokens: 0, estimated: false, lines: 0 };
    perRound[k].tokens += Number(l.tokens) || 0;
    perRound[k].lines += 1;
    if (l.estimated) perRound[k].estimated = true;
  }
  const closed = new Set(countedRounds(rc).map((r) => String(r.n)));
  const measuredRounds = Object.entries(perRound)
    .filter(([k, v]) => k !== 'setup' && closed.has(k) && !v.estimated && v.tokens > 0)
    .map(([, v]) => v.tokens);
  const est = rc.run.limits.roundTokenEstimate;
  // Never below the configured estimate (r3-f7): self-reported numbers can only raise it.
  const nextEstimate = measuredRounds.length ? Math.max(est, Math.round(measuredRounds.reduce((a, b) => a + b, 0) / measuredRounds.length)) : est;
  return { spent, estimatedJobs, suspectRecords, perRound, measuredRounds, nextEstimate };
}

function ownerDecisions(rc) {
  return readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] }).decisions || [];
}

function lastContinueRound(rc) {
  let r = null;
  for (const d of ownerDecisions(rc)) if (d.kind === 'continue' && Number.isInteger(d.afterRound)) r = d.afterRound;
  return r;
}

export function ownerStopPending(rc, n = null) {
  return ownerDecisions(rc).some((d) => d.kind === 'stop' && !d.applied && (n === null || d.round === n || d.round == null));
}

// ---------------------------------------------------------------- results

export function todoResult(rc, { decision = null, todoPath = null, items = [], summary = '', next }) {
  const todo = items.map((t) => (typeof t === 'string' ? { kind: 'action', text: t } : t));
  const lines = [];
  if (decision) lines.push(`Decision: ${decision}`);
  if (summary) lines.push(summary);
  for (const t of todo) lines.push(`- ${t.text}`);
  if (todoPath) lines.push(`To-do file: ${todoPath}`);
  lines.push('');
  lines.push(`NEXT: ${next}`);
  return { exitCode: 20, state: rc.state.state, payload: { decision, todoPath, todo, summary }, text: lines.join('\n') };
}

// ---------------------------------------------------------------- stop / report

/** Run the automatic audit and write the owner report (P4). -> { reportPath, summaryRu, audit } */
export async function writeReport(rc) {
  const { audit } = await import('./audit.mjs');
  let auditResult;
  try {
    auditResult = audit(rc.runDir, rc.ctx, { automatic: true });
  } catch (e) {
    auditResult = { ok: false, checks: [{ id: 'audit', ok: false, details: [String(e.message || e)] }] };
  }
  let reportPath = rc.paths.report;
  let summaryRu = [];
  try {
    const rep = await import('../report/report-ru.mjs');
    const md = rep.buildReport(rc.runDir, { dataPaths: rc.dataPaths, audit: auditResult });
    writeTextAtomic(reportPath, md);
    const copyName = `gauntlet-${rc.runId}.ru.md`;
    if (rc.run.reportDir) {
      ensureDir(rc.run.reportDir);
      writeTextAtomic(path.join(rc.run.reportDir, copyName), md);
    }
    summaryRu = rep.summaryLines(rc.runDir, { dataPaths: rc.dataPaths, audit: auditResult }) || [];
  } catch (e) {
    const md = fallbackReport(rc, e);
    writeTextAtomic(reportPath, md);
    summaryRu = md.split('\n').filter((l) => l.trim()).slice(1, 6);
  }
  log(rc, 'report', { path: path.relative(rc.runDir, reportPath).replace(/\\/g, '/'), numbers: reportNumbers(rc), sha256: sha256Hex(fs.readFileSync(reportPath)) });
  return { reportPath, summaryRu, audit: auditResult };
}

function fallbackReport(rc, err) {
  const st = rc.state;
  return [
    `# Отчёт о проверке — ${rc.run.project}`,
    '',
    `Итог: ${st.lastDecision === 'DONE' ? 'готово' : 'не готово'} (${st.lastDecision || 'нет решения'}).`,
    `Последний круг: ${st.round ?? '—'}.`,
    `Модуль отчёта не сработал: ${String(err && err.message ? err.message : err).slice(0, 300)}`,
    `Папка запуска: ${rc.runDir}`,
    '',
  ].join('\n');
}

/** Numbers the report shows; logged with the report and re-checked by audit (11.9 point 7). */
export function reportNumbers(rc) {
  const last = countedRounds(rc).slice(-1)[0];
  const g = last ? last.gate : null;
  let caught = 0;
  let pairs = 0;
  for (const r of countedRounds(rc)) {
    caught += r.gate.panelCatch?.pairsCaught || 0;
    pairs += r.gate.panelCatch?.pairsTotal || 0;
  }
  const t = tokenSummary(rc);
  return {
    decision: rc.state.lastDecision ?? null,
    lastRound: last ? last.n : null,
    open: g ? g.open : null,
    pairsCaught: caught,
    pairsTotal: pairs,
    tokens: t.spent,
  };
}

async function appendRunEndRow(rc) {
  try {
    const m = await import('../measure/mledger.mjs');
    const counted = countedRounds(rc);
    const lenses = loadLenses(rc);
    const t = tokenSummary(rc);
    const start = Date.parse(rc.run.createdAt || '') || null;
    m.appendRunEnd(rc.dataPaths, {
      runId: rc.runId,
      project: rc.run.project,
      artifactType: rc.run.artifactType,
      instrumentId: rc.frozen?.instrumentId ?? null,
      lensSetId: rc.frozen?.lensSetId ?? rc.frozen?.sha256?.lenses ?? null,
      fixedKey: !!rc.run.canaries?.fixedKey,
      models: modelsPerRole(rc.run),
      lenses: (lenses?.lenses || []).map((l) => l.id),
      rounds: counted.length,
      confirms: counted.filter((r) => r.gate.kind === 'confirm').length,
      decision: rc.state.lastDecision ?? null,
      tokens: t.spent,
      tokensEstimated: t.estimatedJobs > 0,
      durationMin: start ? Math.max(0, Math.round((Date.parse(now()) - start) / 60000)) : null,
      seeded: isSeeded(),
    });
  } catch (e) {
    rc.warnings.push(`measurement ledger: run row not written (${e.message})`);
  }
}

export function modelsPerRole(run) {
  const out = {};
  for (const r of ['reviewer', 'verifier', 'planter', 'validator', 'matcher', 'lens-writer', 'confirm-extra']) {
    const e = [...(run.models?.optIn || [])].reverse().find((x) => x.role === r);
    out[r] = e ? e.model : 'default';
  }
  return out;
}

/** Stop the run (STOP_*), write the report, exit 30. */
export async function stopRun(rc, decision, reasons = [], { round = null } = {}) {
  move(rc, 'stop', { lastDecision: decision, stoppedReason: reasons.join('; ') || decision, pendingJobs: [] }, 'gate', { decision, reasons, noRound: round === null }, round);
  await appendRunEndRow(rc);
  const rep = await writeReport(rc);
  return stopResultFrom(rc, decision, rep);
}

export function stopResultFrom(rc, decision, rep) {
  const lines = [
    `Stopped: ${decision}.`,
    `Report: ${rep.reportPath}`,
    ...(rep.summaryRu || []).map((l) => `  ${l}`),
    '',
    'NEXT: show the owner the 5 summary lines (report --summary) and the report path; do not start new rounds without the owner\'s word.',
  ];
  return { exitCode: 30, state: rc.state.state, payload: { decision, reportPath: rep.reportPath, summaryRu: rep.summaryRu || [] }, text: lines.join('\n') };
}

// ---------------------------------------------------------------- 11.2 round start

export async function startRound(rc, opts = {}) {
  const run = rc.run;
  const lensesJson = loadLenses(rc);
  if (!lensesJson) throw new UsageError('lenses.json is missing; setup was not completed');
  const counted = countedRounds(rc);
  const t = tokenSummary(rc);
  const specs = minimumCountSpecs(lensesJson);
  const live = buildManifest(run, { countsFor: specs });
  const cand = rc.state.candidate;
  const isConfirm = !!cand && live.versionHash === cand.versionHash;

  // 1. limits (a confirm round is not refused for the rounds count: it has its own maxConfirms, and
  // confirm rounds never count toward maxRounds, r3-f16).
  const working = workingRoundsCount(rc);
  if ((!isConfirm && working >= run.limits.maxRounds) || t.spent + t.nextEstimate > run.limits.maxPanelTokens) {
    const reasons = working >= run.limits.maxRounds && !isConfirm
      ? [`rounds limit reached (${working} working rounds of ${run.limits.maxRounds})`]
      : [`panel token budget would be exceeded (${t.spent} spent + ${t.nextEstimate} next > ${run.limits.maxPanelTokens})`];
    return stopRun(rc, 'STOP_LIMIT', reasons);
  }
  // 2. owner stop
  if (ownerStopPending(rc)) {
    markStopsApplied(rc);
    return stopRun(rc, 'STOP_OWNER', ['owner asked to stop']);
  }
  // 3. unchanged material after FIX
  const last = counted.slice(-1)[0];
  const lastOpen = last ? (last.gate.open?.blocker || 0) + (last.gate.open?.major || 0) : 0;
  if (rc.state.lastDecision === 'FIX' && last && last.gate.versionHash === live.versionHash && !opts.sameMaterial && lastOpen > 0) {
    return todoResult(rc, {
      decision: 'FIX',
      items: [`The material is unchanged since round ${last.n}; fix the open problems first (todo shows them).`],
      summary: 'material unchanged',
      next: `fix the material, then step (or step --same-material to repeat the review of the same version; open problems stay open)`,
    });
  }
  // 4. kind
  const kind = isConfirm ? 'confirm' : 'working';
  const n = (roundNumbers(rc).slice(-1)[0] || 0) + 1;
  const patch = { round: n, roundKind: kind, pendingJobs: [] };
  const openData = { kind, liveVersionHash: live.versionHash, sameMaterial: !!opts.sameMaterial };
  if (cand && !isConfirm) {
    patch.candidate = null;
    openData.candidateCleared = 'material changed after a clean round';
  }
  ensureDir(rp(rc, n).dir);
  saveRound(rc, n, { kind, openedAt: now(), seeded: isSeeded(), blocked: false, sameMaterial: !!opts.sameMaterial, wave: 1, revealed: false, planterAttempts: 0, validatorAttempts: 0 });
  commitState(rc, patch, 'round-open', openData, n);

  // 5. snapshot + mechanical
  const r = rp(rc, n);
  const manifest = takeSnapshot(run, r.snapshot, { countsFor: specs });
  writeJsonAtomic(r.manifest, manifest);
  saveRound(rc, n, { versionHash: manifest.versionHash });
  log(rc, 'snapshot', { versionHash: manifest.versionHash, files: manifest.files.length, unlistedRecent: manifest.unlistedRecent.length }, n);

  // Folder links and junctions inside the roots would be skipped silently by the snapshot.
  const links = skippedLinksOf(run);
  if (links.length) {
    return blockRound(rc, n, 'BLOCKED_PRECHECK', [`These folder links or junctions inside the material roots would never be reviewed: ${links.slice(0, 20).join(', ')}. Replace each with a real folder, add its target as a root (amend --what material), or exclude it.`]);
  }

  // Every material file must still be covered by a frozen all-files / all-entries rule: a file added
  // after freeze would otherwise be in the copy without anyone being obliged to read it.
  const coverGlobs = (lensesJson.lenses || []).flatMap((l) => (l.minimum || []).filter((m) => (m.kind === 'all-files' || m.kind === 'all-entries') && m.glob).map((m) => m.glob));
  const uncovered = manifest.files.map((f) => f.rel).filter((rel) => !coverGlobs.some((g) => matchGlob(rel, g)));
  if (uncovered.length) {
    return blockRound(rc, n, 'BLOCKED_PRECHECK', [`These material files are not covered by any lens's mandatory reading rule: ${uncovered.slice(0, 20).join(', ')}${uncovered.length > 20 ? ', ...' : ''}. Move them out of the material roots, or (on the owner's words) widen the lenses with amend --what lenses.`]);
  }

  // A failing primary source stops the round before any agent runs (fail closed): reviewers who
  // cannot check facts against it would file them under notVerified, which never blocks "done".
  if ((loadSourcesFileSafe(rc).sources || []).length) {
    const check = runSourcesCheck(rc);
    writeJsonAtomic(r.sourcesCheck, { schemaVersion: 1, round: n, results: check });
    writeSourceTexts(r.dir, check);
    log(rc, 'sources-check', { results: check.map((c) => ({ id: c.id, ok: c.ok, sha256: c.sha256 })) }, n);
    const failing = check.filter((c) => !c.ok);
    if (failing.length) {
      return blockRound(rc, n, 'BLOCKED_PRECHECK', failing.map((c) => `Primary source ${c.id} does not work now: ${c.error || 'exit ' + c.exitCode}. Repair it (or, if the recipe itself must change, amend --what sources with the owner's words), then step.`));
    }
    // A file a source reads that changed since setup (a facts script edited mid-run, even with its
    // modification time set back) blocks the round (r3-f3).
    const changed = sourceChangeProblems(rc, check);
    if (changed.length) return blockRound(rc, n, 'BLOCKED_PRECHECK', changed);
  }

  const mech = runMechanical(loadMechanical(rc), r.snapshot, { allow: run.allowExecutables });
  writeJsonAtomic(r.precheck, { schemaVersion: 1, round: n, results: mech });
  log(rc, 'precheck', { results: mech.map((m) => ({ id: m.id, ok: m.ok, severity: m.severity })) }, n);
  const hard = mech.filter((m) => !m.ok && (m.severity === 'blocker' || m.severity === 'major'));
  if (hard.length) {
    return blockRound(rc, n, 'BLOCKED_PRECHECK', hard.map((m) => `Mechanical check ${m.id} (${m.severity}) failed: ${m.what}. ${(m.details || []).slice(0, 5).join(' | ')}`));
  }

  // 6. review copy
  const strip = loadStrip(rc);
  const tracePatterns = loadPatterns('trace');
  const copy = makeReviewCopy({ run, strip, snapshotDir: r.snapshot, reviewBase: run.reviewBase, rng: rngFor(rc, `copy:${n}`), patterns: tracePatterns, templatesDir: rc.paths.templatesDir });
  // The strip rules are frozen, but the material keeps changing: on every round the rules may only
  // remove review traces, as at setup (r2-f40). Anything they now remove that is not a trace, and
  // that the owner did not approve, blocks the round.
  const nar = stripNarrowing(r.snapshot, strip, { patterns: tracePatterns });
  const approvedNarrowing = new Set([
    ...(readJsonIf(rc.paths.stripPreview, {}).narrowingApproved || []),
    ...readJsonIf(rc.paths.ownerDecisions, { decisions: [] }).decisions
      .filter((d) => d.kind === 'strip-narrowing' || (d.kind === 'amend' && d.set?.what === 'strip'))
      .flatMap((d) => d.narrowing || []),
  ]);
  const newNarrowing = nar.narrowing.filter((x) => !approvedNarrowing.has(x));
  // The rebuilt outputs must equal the delivered ones when strip touched no rebuild source (r2-f43).
  const rbCheck = copy.rebuild && copy.rebuild.exitCode === 0 ? rebuildOutputsCheck({ run, nar, snapDir: r.snapshot, copyDir: copy.copyDir }) : null;
  const copyRecord = {
    schemaVersion: 1,
    round: n,
    copyDir: copy.copyDir,
    copyId: copy.copyId,
    stripLog: copy.stripLog,
    stripViolations: copy.stripViolations || [],
    excluded: copy.excluded || [],
    bannerFiles: copy.bannerFiles,
    bannerMissing: copy.bannerMissing || [],
    rebuild: copy.rebuild,
    traceHits: copy.traceHits,
    notesHits: copy.notesHits || [],
    copyTreeHash0: copy.copyTreeHash,
    stripExcluded: nar.excluded,
    stripRules: nar.rules.map((x) => ({ index: x.index, matches: x.matches, files: x.files, nonTrace: x.nonTrace })),
    stripNarrowingNew: newNarrowing,
    rebuildDiffers: rbCheck ? rbCheck.differs : [],
  };
  writeJsonAtomic(r.copy, copyRecord);
  saveRound(rc, n, { copyId: copy.copyId, copyDir: copy.copyDir, copyTreeHash0: copy.copyTreeHash });
  writeCopyListing(rc, n, copy.listing);
  log(rc, 'copy', { copyId: copy.copyId, copyTreeHash: copy.copyTreeHash, excluded: (copy.excluded || []).length, bannerFiles: copy.bannerFiles }, n);
  log(rc, 'trace-scan', { hits: copy.traceHits.length, notesHits: (copy.notesHits || []).length, stripViolations: (copy.stripViolations || []).length }, n);
  const problems = [];
  for (const v of copy.stripViolations || []) problems.push(`Strip rule ${v.rule} expected ${v.expect} but matched ${v.matches}${v.why ? ` (${v.why})` : ''}${v.error ? `: ${v.error}` : ''}.`);
  for (const h of copy.notesHits || []) problems.push(`Author notes ${h.file}${h.line ? ` line ${h.line}` : ''}: "${h.text}" (${h.patternId}). Notes may only point reviewers to where things are; claims of intent, of fixes or checks, and of what is not an error are refused, and a notes file may hold at most ${MAX_NOTES_CHARS} characters. Edit the notes file.`);
  for (const h of copy.traceHits) problems.push(`Review trace in ${h.file || 'the copy path'}${h.line ? ` line ${h.line}` : ''}: "${h.text}" (${h.patternId}). Read what to do at the end of this list before you touch anything.`);
  problems.push(...traceAdvice(copy.traceHits, { patterns: tracePatterns }));
  if (copy.rebuild && copy.rebuild.exitCode !== 0) problems.push(`The rebuild of the copy failed (exit ${copy.rebuild.exitCode}): ${String(copy.rebuild.stderrTail || copy.rebuild.error || '').slice(-400)}`);
  for (const x of newNarrowing) problems.push(`The frozen strip rules now remove material that carries no review trace: ${x}.`);
  if (rbCheck && rbCheck.differs.length && !rbCheck.stripTouchedSources) {
    problems.push(`The rebuild on the review copy gives output files that differ from the material although strip changed none of the rebuild sources: ${rbCheck.differs.slice(0, 10).join(', ')}. Reviewers would see a different build than the one delivered.`);
  }
  if (problems.length) {
    safeRemove(copy.copyDir);
    if ((copy.stripViolations || []).length || copy.traceHits.length || newNarrowing.length) {
      problems.push('Settings are frozen: change strip.json only with amend <run> --what strip --file <new strip.json> --reason <why>. A new traceAllow entry, or a strip rule that matches a material file, narrows what is reviewed and needs --owner-quote with the owner\'s words and --question with the exact question you asked him; editing the material itself needs no quote.');
    }
    return blockRound(rc, n, 'BLOCKED_TRACE', problems);
  }

  // 7. sample of large data files (SPEC 14.10): drawn now, after the snapshot, kept in the sealed
  // stage like the canary key; only its hash is logged until reveal. No large file, no draw.
  const selection = planSample(copy.copyDir, samplingSettings(run), () => rngFor(rc, `sample:${n}`));
  if (selection) writeJsonAtomic(phasePath(rc, n, 'sample.json'), selection);
  const sampleCommitment = selection ? sampleHash(selection) : null;

  // 8. canaries
  const fixed = run.canaries?.fixedKey;
  if (fixed && fixed.path) return plantFixedKey(rc, n, copy.copyDir, fixed);

  const taxonomy = loadTaxonomy();
  const pidx = positionIndex(copy.copyDir, run.material?.readingOrder || []);
  let ledgerCounts = null;
  try {
    const m = await import('../measure/mledger.mjs');
    ledgerCounts = m.ledgerCounts(rc.dataPaths, { artifactType: run.artifactType, instrumentId: rc.frozen?.instrumentId ?? null });
  } catch {
    ledgerCounts = null;
  }
  const usedThisRun = [];
  for (const k of roundNumbers(rc)) {
    if (k >= n) continue;
    const s = readJsonIf(phasePath(rc, k, 'slots.json'), null);
    const rr = readRound(rc, k);
    for (const sl of s?.slots || []) usedThisRun.push({ round: k, type: sl.type, band: sl.band, purpose: sl.purpose, targetLens: sl.targetLens, roundKind: rr?.kind });
  }
  const plan = planSlots({
    lenses: lensesJson.lenses,
    taxonomy,
    positionIndex: pidx,
    ledgerCounts,
    run,
    roundKind: kind,
    usedThisRun,
    rng: rngFor(rc, `slots:${n}`),
    candidateRound: cand && isConfirm ? cand.round : undefined,
  });
  writeJsonAtomic(phasePath(rc, n, 'slots.json'), slotsFile(plan));
  writeJsonAtomic(seedPath(rc, n), { schemaVersion: 1, seedHex: plan.seedHex, seedCommitment: plan.seedCommitment });
  saveRound(rc, n, { unguardedBySlots: plan.unguarded || [], seedCommitment: plan.seedCommitment });
  log(rc, 'slots', { seedCommitment: plan.seedCommitment, slots: plan.slots.length, unguarded: plan.unguarded || [], ...(sampleCommitment ? { sampleCommitment, sampledFiles: selection.files.length, ...((selection.unsampled ?? []).length ? { unsampledFiles: selection.unsampled.length } : {}) } : {}) }, n);
  if (plan.slots.length === 0) return plantApproved(rc, n, []);
  return issuePlanter(rc, n, plan.slots, 1);
}

/** The round's sample of large data files (SPEC 14.10), or null when the round has none. */
function readSelection(rc, n) {
  return readJsonIf(phasePath(rc, n, 'sample.json'), null);
}

/**
 * The sample is sealed like the canary key (SPEC 14.10): the `canary-commit` event of the round
 * carries its hash. Returns a sentence when sample.json (in the stage, or revealed) no longer
 * matches that hash, is missing although the ledger committed to one, or exists although none was
 * committed; null when all is well (or the round has no commit event or no sample).
 */
export function sampleSealProblem(rc, n, lines = ledgerLines(rc)) {
  const commit = [...lines].reverse().find((l) => l.type === 'canary-commit' && l.round === n);
  if (!commit) return null;
  const expected = commit.data?.sampleCommitment ?? null;
  const sel = readSelection(rc, n);
  if (!expected && !sel) return null;
  if (!expected) return `round ${n}: sample.json exists but the ledger committed to no sample`;
  if (!sel) return `round ${n}: the ledger committed to a sample (${String(expected).slice(0, 12)}) but sample.json is missing`;
  const actual = hashJson(sel);
  if (actual !== expected) return `round ${n}: sample.json (${actual.slice(0, 12)}) does not match the sample committed in the ledger (${String(expected).slice(0, 12)})`;
  return null;
}

function assertSampleSeal(rc, n) {
  const problem = sampleSealProblem(rc, n);
  if (problem) throw new IntegrityError('COMMITMENT_MISMATCH', `the sealed sample changed after it was committed: ${problem}`);
}

/**
 * The planted (or rebuilt) copy must still have the rows the sample counted. When it does not
 * (a rebuild that regenerates a data file), the round ends as a clean BLOCKED_PRECHECK with a
 * to-do instead of a crash. Returns the block result, or null when the structure holds.
 */
function blockOnSampleStructure(rc, n, copyDir, selection) {
  if (!selection) return null;
  try {
    assertStructure(copyDir, selection);
    return null;
  } catch (e) {
    safeRemove(copyDir);
    return blockRound(rc, n, 'BLOCKED_PRECHECK', [`${e.message}. The review copy is built from the snapshot, so a rebuild of the copy that regenerates a large data file (or an edit that adds or removes a row) changes which rows the sample counted. Make the rebuild of the copy leave the rows of large data files as they are (exclude them from the rebuild outputs), then step.`]);
  }
}

/** Sealed file list of the review copy of round n (see checkPlantedCopy). Removed when the round closes. */
function copyListingPath(rc, n) {
  return path.join(rc.dataPaths.sealedDir(rc.runId), `${String(n).padStart(2, '0')}.copy-files.json`);
}

function writeCopyListing(rc, n, listing) {
  writeJsonAtomic(copyListingPath(rc, n), { schemaVersion: 1, round: n, takenAt: now(), treeHash: listing.treeHash, files: listing.files });
}

function readCopyListing(rc, n) {
  return readJsonIf(copyListingPath(rc, n), null);
}

function seedPath(rc, n) {
  return path.join(rc.dataPaths.sealedDir(rc.runId), `${String(n).padStart(2, '0')}.seed.json`);
}

function markStopsApplied(rc) {
  const f = readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] });
  for (const d of f.decisions) if (d.kind === 'stop') d.applied = true;
  writeJsonAtomic(rc.paths.ownerDecisions, f);
}

/** BLOCKED_PRECHECK / BLOCKED_TRACE: not a round; state stays READY; exit 20. */
function blockRound(rc, n, decision, problems) {
  const r = rp(rc, n);
  const history = historyBefore(rc, n);
  const t = tokenSummary(rc);
  const g = preGateRecord({
    round: n,
    kind: rc.state.roundKind,
    versionHash: readRound(rc, n)?.versionHash ?? null,
    decision,
    reasons: problems,
    history,
    limits: rc.run.limits,
    best: rc.state.best,
    confirmsDone: rc.state.confirmsDone,
    roundsDone: workingRoundsCount(rc, n),
    tokensSpent: t.spent,
    nextEstimate: t.nextEstimate,
  });
  writeJsonAtomic(r.gate, g);
  saveRound(rc, n, { blocked: true, closedAt: now() });
  unstage(rc, n);
  const todoText = renderTodo({ decision, gate: g, problems, clusters: [], extra: {} });
  writeTextAtomic(r.todo, todoText);
  log(rc, 'gate', { decision, gateSha256: hashJson(g), reasons: problems.slice(0, 20) }, n);
  safeRemove(seedPath(rc, n));
  commitState(rc, { state: 'READY', pendingJobs: [], round: n }, 'round-close', { decision, blocked: true }, n);
  return todoResult(rc, {
    decision,
    todoPath: r.todo,
    items: problems,
    summary: decision === 'BLOCKED_PRECHECK' ? 'mechanical checks failed before any agent ran (not a round)' : 'the review copy has review traces or strip problems (not a round)',
    next: 'fix what the list says, then step',
  });
}

// ---------------------------------------------------------------- planter

function bandFiles(pidx, range) {
  const total = pidx.totalChars || 0;
  if (!total) return '';
  const [lo, hi] = range;
  const parts = [];
  for (const f of pidx.files || []) {
    const a = f.start / total;
    const b = (f.start + f.chars) / total;
    if (b <= lo || a >= hi) continue;
    const from = Math.max(0, (lo - a) / (b - a));
    const to = Math.min(1, (hi - a) / (b - a));
    parts.push(`${f.rel} (from about ${Math.round(from * 100)}% to ${Math.round(to * 100)}% of the file)`);
  }
  return parts.join('; ');
}

function slotsValue(slots, taxonomy, pidx) {
  return slots
    .map((s) => {
      const t = taxonomy.byId(s.type);
      const where = pidx ? bandFiles(pidx, s.range) : '';
      return `- ${s.slot}: kind ${s.type} (${t ? t.title : s.type}); part of the material: ${s.band} (from ${Math.round(s.range[0] * 100)}% to ${Math.round(s.range[1] * 100)}% of the text in reading order)${where ? ` — that is: ${where}` : ''}; minimum class: ${s.severityFloor}.`;
    })
    .join('\n');
}

function typeDefsValue(typeIds, taxonomy) {
  return [...new Set(typeIds)]
    .map((id) => taxonomy.byId(id))
    .filter(Boolean)
    .map((t) => `- ${t.id} — ${t.title}: ${t.definition}${t.example ? ` Example: ${t.example}` : ''}`)
    .join('\n');
}

function usedValue(rc, n) {
  const out = [];
  for (const k of roundNumbers(rc)) {
    if (k >= n) continue;
    const key = readJsonIf(rp(rc, k).canaries, null);
    for (const c of key?.canaries || []) out.push(`- ${c.type} in ${c.file} (${c.band || 'unknown part'})`);
  }
  return out.length ? out.join('\n') : '(nothing yet)';
}

function issuePlanter(rc, n, slots, attempt) {
  const run = rc.run;
  const round = readRound(rc, n);
  const copyDir = round.copyDir;
  const taxonomy = loadTaxonomy();
  const pidx = positionIndex(copyDir, run.material?.readingOrder || []);
  const check = readJsonIf(rp(rc, n).sourcesCheck, null)?.results || null;
  const selection = readSelection(rc, n);
  const view = selection ? sampleView(copyDir, selection) : null;
  const values = {
    TASK: taskText(rc),
    COPY_DIR: copyDir,
    MATERIAL_LIST: materialListValue(copyDir, manifestOfDir(copyDir), { annotate: view ? annotateForPlanter(view) : null }),
    SOURCES: sourcesValue(rc, check),
    SLOTS: slotsValue(slots, taxonomy, pidx),
    TYPE_DEFINITIONS: typeDefsValue(slots.map((s) => s.type), taxonomy),
    USED: usedValue(rc, n),
    MAX_EDIT: String(run.canaries.maxEditChars),
    CANDIDATES_PER_SLOT: String(run.canaries.candidatesPerSlot),
    REPORT_LANGUAGE: run.language?.report || 'ru',
  };
  const rec = issueJob(rc, {
    round: n,
    role: 'planter',
    attempt,
    values,
    extra: { slots: slots.map((s) => s.slot) },
    promptsDir: path.join(stageDir(rc, n), 'prompts'),
    lintSkip: Object.keys(values).filter((k) => !['TASK', 'SOURCES'].includes(k)),
    files: view ? view.files : [],
  });
  const jobs = loadJobs(rc, n);
  jobs.push(rec);
  saveJobs(rc, n, jobs);
  saveRound(rc, n, { planterAttempts: attempt });
  const ev = rc.state.state === 'READY' ? 'start-round' : 'reissue-planter';
  move(rc, ev, { pendingJobs: [rec.job] }, 'job-issued', { job: rec.job, role: 'planter', attempt, phase: 'planter' }, n);
  return spawnResult(rc, [rec]);
}

/** AWAIT_PLANTER */
export async function afterPlanter(rc, opts = {}) {
  const n = rc.state.round;
  const jobs = loadJobs(rc, n);
  const rec = jobs.find((j) => rc.state.pendingJobs.includes(j.job));
  if (!rec) throw new UsageError('no planter job is pending');
  const r = rp(rc, n);
  const rel = `planter-${rec.attempt}/answer.json`;
  const base = ingestAnswer(rc, n, rec, { dest: phasePath(rc, n, rel), logDest: `rounds/${String(n).padStart(2, '0')}/${rel}` });
  if (!base || !base.kept) {
    if (!base && !isGivenUp(opts, rec.job)) return spawnResult(rc, [rec], 'The planter answer is not there yet.');
    rec.status = base ? 'answered' : 'given-up';
    if (!base) log(rc, 'job-given-up', { job: rec.job, role: 'planter' }, n);
    saveJobs(rc, n, jobs);
    log(rc, 'planter-ingested', { job: rec.job, ok: false, reasons: base ? base.reasons : ['given-up'] }, n);
    if (rec.attempt < 2) {
      const slots = (readJsonIf(phasePath(rc, n, 'slots.json')).slots || []).filter((s) => (rec.slots || []).includes(s.slot));
      return issuePlanter(rc, n, slots, rec.attempt + 1);
    }
    return closeWithoutReview(rc, n, 'STOP_INCONCLUSIVE', ['the planter gave no usable answer twice'], 'planter');
  }
  rec.status = 'answered';
  rec.answerSha256 = base.answerSha256;
  saveJobs(rc, n, jobs);
  const answer = base.json;
  const slotsAll = readJsonIf(phasePath(rc, n, 'slots.json')).slots || [];
  const mySlots = slotsAll.filter((s) => (rec.slots || []).includes(s.slot));
  const round = readRound(rc, n);
  const pidx = positionIndex(round.copyDir, rc.run.material?.readingOrder || []);
  const tracePatterns = loadPatterns('trace');
  const prevApproved = readJsonIf(phasePath(rc, n, 'approved.json'), { approved: [] }).approved || [];
  const selection = readSelection(rc, n);
  const guard = selection ? makeSampleGuard(round.copyDir, selection) : null;
  const checks = [];
  for (const c of answer.candidates || []) {
    const slot = mySlots.find((s) => s.slot === c.slot);
    if (!slot) {
      checks.push({ slot: c.slot, alt: c.alt, ok: false, errors: ['not a slot of this request'] });
      continue;
    }
    const v = validateCandidate(c, { copyDir: round.copyDir, slot, run: rc.run, otherEdits: prevApproved, patterns: tracePatterns, positionIndex: pidx, sample: guard });
    checks.push({ slot: c.slot, alt: c.alt, ok: v.ok, errors: v.errors, index: v.index, positionFraction: v.positionFraction });
  }
  const incidental = [...(round.incidental || []), ...(answer.incidental || [])];
  saveRound(rc, n, { incidental });
  writeJsonAtomic(phasePath(rc, n, `planter-${rec.attempt}/code-checks.json`), { schemaVersion: 1, checks });
  log(rc, 'planter-ingested', { job: rec.job, ok: true, candidates: (answer.candidates || []).length, codeValid: checks.filter((x) => x.ok).length }, n);
  const valid = (answer.candidates || []).filter((c) => checks.find((x) => x.slot === c.slot && x.alt === c.alt && x.ok));
  if (valid.length === 0) return afterSelection(rc, n, rec.attempt, mySlots, [], []);
  return issueValidator(rc, n, rec.attempt, valid, mySlots);
}

function candidatesValue(cands, copyDir) {
  return cands
    .map((c) =>
      [
        `### ${c.slot} alt ${c.alt}`,
        `- File: ${c.file} (${path.join(copyDir, ...String(c.file).split('/'))})`,
        `- Place: ${c.locator}`,
        `- Before: ${JSON.stringify(c.before)}`,
        `- After: ${JSON.stringify(c.after)}`,
        `- What would be wrong: ${c.description}`,
        `- How it can be proven: ${c.howProvable}`,
        `- Proposed class: ${c.intendedSeverity}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function issueValidator(rc, n, planterAttempt, cands, slots) {
  const round = readRound(rc, n);
  const taxonomy = loadTaxonomy();
  const check = readJsonIf(rp(rc, n).sourcesCheck, null)?.results || null;
  const values = {
    TASK: taskText(rc),
    COPY_DIR: round.copyDir,
    SOURCES: sourcesValue(rc, check),
    SEVERITY: loadRunTemplate(rc.runDir, 'severity.md'),
    TYPE_DEFINITIONS: typeDefsValue(slots.map((s) => s.type), taxonomy),
    CANDIDATES: candidatesValue(cands, round.copyDir),
  };
  const attempt = (round.validatorAttempts || 0) + 1;
  const rec = issueJob(rc, {
    round: n,
    role: 'validator',
    attempt,
    values,
    extra: { planterAttempt, slots: slots.map((s) => s.slot) },
    promptsDir: path.join(stageDir(rc, n), 'prompts'),
    lintSkip: Object.keys(values).filter((k) => !['TASK', 'SOURCES'].includes(k)),
  });
  const jobs = loadJobs(rc, n);
  jobs.push(rec);
  saveJobs(rc, n, jobs);
  saveRound(rc, n, { validatorAttempts: attempt });
  const ev = rc.state.state === 'AWAIT_PLANTER' ? 'planter-ingested' : 'reissue-validator';
  move(rc, ev, { pendingJobs: [rec.job] }, 'job-issued', { job: rec.job, role: 'validator', attempt, phase: 'validator' }, n);
  return spawnResult(rc, [rec]);
}

/** AWAIT_VALIDATOR */
export async function afterValidator(rc, opts = {}) {
  const n = rc.state.round;
  const jobs = loadJobs(rc, n);
  const rec = jobs.find((j) => rc.state.pendingJobs.includes(j.job));
  if (!rec) throw new UsageError('no validator job is pending');
  const r = rp(rc, n);
  const vrel = `${rec.attempt === 1 ? 'validator' : `validator-${rec.attempt}`}/answer.json`;
  const base = ingestAnswer(rc, n, rec, { dest: phasePath(rc, n, vrel), logDest: `rounds/${String(n).padStart(2, '0')}/${vrel}` });
  const planterAttempt = rec.planterAttempt || 1;
  const planterAnswer = readJsonIf(phasePath(rc, n, `planter-${planterAttempt}/answer.json`), { candidates: [] });
  const codeChecks = readJsonIf(phasePath(rc, n, `planter-${planterAttempt}/code-checks.json`), { checks: [] }).checks;
  const slots = (readJsonIf(phasePath(rc, n, 'slots.json')).slots || []).filter((s) => (rec.slots || []).includes(s.slot));
  if (!base || !base.kept) {
    if (!base && !isGivenUp(opts, rec.job)) return spawnResult(rc, [rec], 'The validator answer is not there yet.');
    rec.status = base ? 'answered' : 'given-up';
    if (!base) log(rc, 'job-given-up', { job: rec.job, role: 'validator' }, n);
    saveJobs(rc, n, jobs);
    log(rc, 'validator-ingested', { job: rec.job, ok: false, reasons: base ? base.reasons : ['given-up'] }, n);
    const round = readRound(rc, n);
    if ((round.validatorAttempts || 1) < 2) {
      const valid = (planterAnswer.candidates || []).filter((c) => codeChecks.find((x) => x.slot === c.slot && x.alt === c.alt && x.ok));
      return issueValidator(rc, n, planterAttempt, valid, slots);
    }
    return closeWithoutReview(rc, n, 'STOP_INCONCLUSIVE', ['the canary validator gave no usable answer twice'], 'validator');
  }
  rec.status = 'answered';
  rec.answerSha256 = base.answerSha256;
  saveJobs(rc, n, jobs);
  const verdicts = base.json.verdicts || [];
  log(rc, 'validator-ingested', { job: rec.job, ok: true, kept: verdicts.filter((v) => v.keep).length }, n);
  const valid = (planterAnswer.candidates || []).filter((c) => codeChecks.find((x) => x.slot === c.slot && x.alt === c.alt && x.ok));
  return afterSelection(rc, n, planterAttempt, slots, valid, verdicts, codeChecks);
}

async function afterSelection(rc, n, planterAttempt, slots, candidates, verdicts, codeChecks = []) {
  const { approved, unfilled } = chooseApproved(slots, candidates, verdicts, codeChecks, { run: rc.run });
  const approvedPath = phasePath(rc, n, 'approved.json');
  const allApproved = [...(readJsonIf(approvedPath, { approved: [] }).approved || []), ...approved];
  // The chosen edits stay in the sealed stage until reveal (never in round.json).
  writeJsonAtomic(approvedPath, { schemaVersion: 1, approved: allApproved });
  if (unfilled.length && planterAttempt < 2) {
    const allSlots = readJsonIf(phasePath(rc, n, 'slots.json')).slots || [];
    const again = allSlots.filter((s) => unfilled.includes(s.slot));
    // From AWAIT_VALIDATOR (or AWAIT_PLANTER when nothing passed code checks) back to the planter.
    return issuePlanter(rc, n, again, planterAttempt + 1);
  }
  const allSlots = readJsonIf(phasePath(rc, n, 'slots.json')).slots || [];
  const filled = new Set(allApproved.map((a) => a.slot));
  const dropped = allSlots.filter((s) => !filled.has(s.slot)).map((s) => s.slot);
  saveRound(rc, n, { droppedSlots: dropped });
  return plantApproved(rc, n, allApproved);
}

// ---------------------------------------------------------------- planting, sealing, reviewers

async function plantApproved(rc, n, approved) {
  const round = readRound(rc, n);
  const r = rp(rc, n);
  let copyDir = round.copyDir;
  // The copy waited on disk while the planter and the validator worked. Anything written into it
  // in that window would be baked into what reviewers see (r2-f42): rebuild it from the snapshot.
  const nowListing = round.copyTreeHash0 && exists(copyDir) ? copyListing(copyDir) : null;
  if (round.copyTreeHash0 && (!nowListing || nowListing.treeHash !== round.copyTreeHash0)) {
    const known = readCopyListing(rc, n);
    const listingKnown = !!known && known.treeHash === round.copyTreeHash0;
    const diff = listingKnown ? diffListings(known, nowListing) : { added: [], changed: [], removed: [] };
    const record = buildTamperRecord({ round: n, diff, expectedTreeHash: round.copyTreeHash0, foundTreeHash: nowListing?.treeHash ?? null, listingKnown, copyMissing: !nowListing, windows: null, detectedAt: now(), isoLocal });
    safeRemove(copyDir);
    const fresh = makeReviewCopy({ run: rc.run, strip: loadStrip(rc), snapshotDir: r.snapshot, reviewBase: rc.run.reviewBase, rng: rngFor(rc, `copy-fresh:${n}`), templatesDir: rc.paths.templatesDir });
    copyDir = fresh.copyDir;
    saveRound(rc, n, { copyDir, copyId: fresh.copyId, copyTreeHash0: fresh.copyTreeHash });
    writeCopyListing(rc, n, fresh.listing);
    const cr = readJsonIf(r.copy, {});
    writeJsonAtomic(r.copy, { ...cr, copyDir, copyId: fresh.copyId, copyTreeHash0: fresh.copyTreeHash, rebuiltAfterTamper: true });
    log(rc, 'copy-tampered', ledgerData(record, { stage: 'before planting', action: 'rebuilt from the snapshot' }), n);
    rc.warnings.push('the review copy changed while the planter worked; it was rebuilt from the snapshot (recorded in the ledger)');
  }
  const pidx = positionIndex(copyDir, rc.run.material?.readingOrder || []);
  const taxonomy = loadTaxonomy();
  let list = [...approved];
  // Every row a planted error sits in belongs to the sample (SPEC 14.10). The planter and the code
  // check keep edits inside it already; this is the net under that rule.
  let selection = readSelection(rc, n);
  if (selection && list.length) selection = extendSelection(rc, n, copyDir, selection, list, 'before');
  let applied = list.length ? applyEdits(copyDir, list, { positionIndex: pidx }).applied : [];

  // Rebuild after edits of rebuild sources; a visual canary must change an output.
  const rb = rc.run.rebuild;
  if (rb && applied.some((a) => (rb.sourcesGlob || []).some((g) => matchGlob(a.file, g)))) {
    const res = rebuildCopy(rc.run, loadStrip(rc), copyDir, { snapshotDir: r.snapshot });
    const visual = applied.filter((a) => taxonomy.byId(a.type || slotType(rc, n, a.slot))?.needsRebuild);
    if (visual.length && (!res.changedOutputs || res.changedOutputs.length === 0)) {
      // Drop visual canaries: rebuild the copy from the snapshot and re-plant without them.
      safeRemove(copyDir);
      const copy = makeReviewCopy({ run: rc.run, strip: loadStrip(rc), snapshotDir: r.snapshot, reviewBase: rc.run.reviewBase, rng: rngFor(rc, `copy2:${n}`), templatesDir: rc.paths.templatesDir });
      copyDir = copy.copyDir;
      list = list.filter((a) => !visual.some((v) => v.slot === a.slot));
      clearSampleCaches();
      applied = list.length ? applyEdits(copyDir, list, { positionIndex: pidx }).applied : [];
      saveRound(rc, n, { copyDir, copyId: copy.copyId, droppedSlots: [...(round.droppedSlots || []), ...visual.map((v) => v.slot)] });
      const cr = readJsonIf(r.copy, {});
      writeJsonAtomic(r.copy, { ...cr, copyDir, copyId: copy.copyId, replantedWithoutVisual: true });
      if (rb && applied.some((a) => (rb.sourcesGlob || []).some((g) => matchGlob(a.file, g)))) rebuildCopy(rc.run, loadStrip(rc), copyDir, { snapshotDir: r.snapshot });
    }
  }
  clearSampleCaches();
  const structureBlock = blockOnSampleStructure(rc, n, copyDir, selection);
  if (structureBlock) return structureBlock;
  // Trace scan again on the planted copy.
  const hits = scanTrace(copyDir, loadPatterns('trace'), loadStrip(rc).traceAllow || []);
  if (hits.length) {
    safeRemove(copyDir);
    return blockRound(rc, n, 'BLOCKED_TRACE', [...hits.map((h) => `Review trace after planting in ${h.file} line ${h.line}: "${h.text}" (${h.patternId}).`), ...traceAdvice(hits)]);
  }
  const seed = readJsonIf(seedPath(rc, n), { seedHex: null });
  const slots = readJsonIf(phasePath(rc, n, 'slots.json'), { slots: [] }).slots;
  const key = buildKey({ runId: rc.runId, round: n, seedHex: seed.seedHex, applied, slots, validator: [] });
  return sealAndIssueReviewers(rc, n, copyDir, key);
}

function slotType(rc, n, slotId) {
  const s = (readJsonIf(phasePath(rc, n, 'slots.json'), { slots: [] }).slots || []).find((x) => x.slot === slotId);
  return s ? s.type : null;
}

/** Add the rows of the given canaries to the round's sample; rewrites sample.json when rows were added. */
function extendSelection(rc, n, copyDir, selection, canaries, use) {
  const { selection: next, added } = addCanaryRows(copyDir, selection, canaries, { use });
  if (added.length) {
    writeJsonAtomic(phasePath(rc, n, 'sample.json'), next);
    return next;
  }
  return selection;
}

function plantFixedKey(rc, n, copyDir, fixed) {
  const raw = readJson(fixed.path);
  const prePlanted = fixed.prePlanted !== false;
  const v = validateFixedKey(raw, copyDir, { prePlanted });
  if (!v.ok) {
    safeRemove(copyDir);
    throw new UsageError('the fixed canary key does not fit the copy:\n  ' + v.errors.slice(0, 20).join('\n  '));
  }
  // A bench key may name rows the draw missed: they join the sample (SPEC 14.10).
  let selection = readSelection(rc, n);
  if (selection) selection = extendSelection(rc, n, copyDir, selection, raw.canaries, prePlanted ? 'after' : 'before');
  if (!prePlanted) applyEdits(copyDir, raw.canaries);
  clearSampleCaches();
  const structureBlock = blockOnSampleStructure(rc, n, copyDir, selection);
  if (structureBlock) return structureBlock;
  const key = {
    schemaVersion: 1,
    runId: rc.runId,
    round: n,
    seedHex: raw.seedHex ?? null,
    canaries: raw.canaries.map((c) => ({ ...c, prePlanted })),
  };
  // Synthesize slots.json from the fixed key so the run files stay uniform.
  writeJsonAtomic(phasePath(rc, n, 'slots.json'), {
    schemaVersion: 1,
    seedCommitment: null,
    slots: key.canaries.map((c, i) => ({ slot: c.slot || `S${i + 1}`, purpose: c.purpose, targetLens: c.targetLens ?? null, type: c.type, band: c.band ?? null, range: null, severityFloor: c.severityFloor || 'major' })),
    fixedKey: true,
  });
  return sealAndIssueReviewers(rc, n, copyDir, key, { fixed: true });
}

function sealAndIssueReviewers(rc, n, copyDir, key, { fixed = false } = {}) {
  const r = rp(rc, n);
  safeRemove(seedPath(rc, n));
  let commitment = null;
  if (key.canaries.length) {
    const s = sealKey(rc.dataPaths, rc.runId, n, key);
    commitment = s.commitment;
  }
  const finalSample = readSelection(rc, n);
  log(rc, 'canary-commit', { commitment, canaries: key.canaries.length, fixed, ...(finalSample ? { sampleCommitment: sampleHash(finalSample) } : {}) }, n);
  const listing = copyListing(copyDir);
  const hash1 = listing.treeHash;
  // The file list of the planted copy stays sealed (it would show where the edits are) and is only
  // read when the copy no longer hashes to hash1, to say which files changed (SPEC 14.13).
  writeCopyListing(rc, n, listing);
  const lensesJson = loadLenses(rc);
  const guardedLenses = [...new Set(key.canaries.filter((c) => c.purpose === 'attention' && c.targetLens).map((c) => c.targetLens))];
  saveRound(rc, n, { copyDir, copyTreeHash1: hash1, commitment, canaryCount: key.canaries.length, guarded: guardedLenses });
  const wave1 = [];
  const cr = readJsonIf(r.copy, {});
  writeJsonAtomic(r.copy, { ...cr, copyDir, copyTreeHash1: hash1 });

  // One reviewer per lens (generalist included), plus the opt-in extra reviewer in confirm rounds.
  const recs = [];
  for (const lens of lensesJson.lenses) recs.push(issueReviewer(rc, n, lens, 1));
  if (rc.state.roundKind === 'confirm') {
    const extra = [...(rc.run.models?.optIn || [])].reverse().find((e) => e.role === 'confirm-extra');
    if (extra) {
      const lens = lensById(lensesJson, extra.lens) || lensById(lensesJson, 'generalist') || lensesJson.lenses[0];
      recs.push(issueReviewer(rc, n, lens, 1, { confirmExtra: true }));
    }
  }
  // The decoy writer works beside the reviewers on the same planted copy; its answer stays sealed
  // until the round closes (SPEC 14.11). It is not a reviewer: it is not part of wave 1.
  const decoyRec = !fixed && decoysActive(rc) ? issueDecoyWriter(rc, n, copyDir) : null;
  const all = decoyRec ? [...recs, decoyRec] : recs;
  const jobs = loadJobs(rc, n);
  jobs.push(...all);
  saveJobs(rc, n, jobs);
  wave1.push(...recs.map((x) => x.job));
  saveRound(rc, n, { wave: 1, wave1Jobs: wave1, ...(decoyRec ? { decoyJob: decoyRec.job } : {}) });
  const ev = rc.state.state === 'READY' ? 'fixed-key' : 'validator-ingested';
  move(rc, ev, { pendingJobs: all.map((x) => x.job) }, 'job-issued', { phase: 'reviewers', jobs: recs.map((x) => x.job), wave: 1 }, n);
  return spawnResult(rc, all);
}

/**
 * The mandatory minimum of a lens as the reviewer reads it. For a rule over files that are reviewed
 * through a sample (SPEC 14.10) the program rewrites the rule: "every row" becomes every sampled row,
 * plus every summary number the other (prose) files state about those files. `view` is sampleView().
 */
export function minimumValue(lens, copyDir, manifest, view = null) {
  const lines = [];
  const rels = manifest.files.map((f) => f.rel);
  for (const m of lens.minimum || []) {
    const matched = m.glob ? rels.filter((rel) => matchGlob(rel, m.glob)) : [];
    const sampled = view ? matched.filter((rel) => view.byRel.has(rel)) : [];
    // big files that cannot be sampled: the duty cannot be "every line" of them (SPEC 14.10)
    const tooBig = view?.unsampledByRel ? matched.filter((rel) => view.unsampledByRel.has(rel)) : [];
    const plain = matched.filter((rel) => !sampled.includes(rel) && !tooBig.includes(rel));
    const tooBigNote = tooBig.length ? `  Too big to read whole and with no rows to draw (${tooBig.length}): ${tooBig.slice(0, 50).join(', ')}${tooBig.length > 50 ? ', ...' : ''}. For these files the duty is to check their structure and to spot-check them; say under notChecked what you did not read.` : null;
    if ((m.kind === 'all-files' || m.kind === 'all-entries') && sampled.length) {
      lines.push(`- ${m.id} (${m.kind}): every sampled row of the large data files listed below, and every summary number that the other files of the work state about them. What to look at in each row: ${m.rule}`);
      if (plain.length) lines.push(`  Files matching ${m.glob} that are read whole (${plain.length}): ${plain.slice(0, 300).join(', ')}${plain.length > 300 ? ', ...' : ''}`);
      lines.push('  Large data files, read through a sample (the program drew these rows at random; each row is shown with its row number and its line number in the file):');
      for (const rel of sampled) {
        const e = view.byRel.get(rel);
        lines.push(`  - ${rel}: ${e.sampled} of ${e.rows} rows, in ${jobFile(e.name)}`);
      }
      if (tooBigNote) lines.push(tooBigNote);
      lines.push('  For these files "every row" or "every entry" in the rule means every sampled row. Check each summary number that the other files state about them (counts, shares, ranges, dates, percentages) against the sampled rows and, where a script over the whole file is quicker, against the whole file. A problem you find outside the sample counts just the same. A question about a numbered line of such a file is always about a line shown in the sample.');
      continue;
    }
    lines.push(`- ${m.id} (${m.kind}): ${m.rule}`);
    if (m.kind === 'all-files' && m.glob) {
      lines.push(`  Files matching ${m.glob} (${plain.length}): ${plain.slice(0, 300).join(', ')}${plain.length > 300 ? ', ...' : ''}`);
    } else if (m.kind === 'all-entries' && m.glob) {
      const count = countFor(copyDir, { glob: m.glob, pointer: m.pointer });
      lines.push(`  Every entry at ${m.pointer} in ${matched.join(', ')}: ${count} entries in total.`);
    } else if (m.kind === 'source-check') {
      lines.push(`  Run source ${m.sourceId}${m.count ? ` for at least ${m.count} different claims` : ''} and record each command in sourceChecks. If the source refuses you (HTTP 429, a block page, a timeout), still make ${m.count ? `the ${m.count} attempts` : 'the attempt'}, spaced out, and record every one with outcome "unavailable" and the error it gave: documented attempts count toward this item, results you could not get do not.`);
    } else if (m.kind === 'action') {
      if (m.glob) {
        lines.push(`  Applies to ${matched.length} file(s) matching ${m.glob}${m.count ? `; at least ${m.count} times` : ''}.${sampled.length ? ` For the large data files among them (${sampled.join(', ')}) it applies to the rows of their sample files (${sampled.map((r) => `${jobFile(view.byRel.get(r).name)}`).join(', ')}).` : ''}`);
      } else if (m.count) lines.push(`  At least ${m.count} times.`);
    }
    if (tooBigNote) lines.push(tooBigNote);
  }
  return lines.join('\n');
}

function requirementsValue(lensesJson) {
  const reqs = lensesJson.requirements || [];
  if (!reqs.length) return '(the task states no separate requirements)';
  return reqs.map((r) => `- ${r.id}: ${r.text}\n  Words of the task: "${r.taskQuote}"`).join('\n');
}

function issueReviewer(rc, n, lens, attempt, { confirmExtra = false } = {}) {
  const round = readRound(rc, n);
  const copyDir = round.copyDir;
  const lensesJson = loadLenses(rc);
  const manifest = manifestOfDir(copyDir);
  const check = readJsonIf(rp(rc, n).sourcesCheck, null)?.results || null;
  const selection = readSelection(rc, n);
  const view = selection ? sampleView(copyDir, selection) : null;
  const challenges = makeChallenges({ copyDir, lens, manifest, rng: rngFor(rc, `receipts:${n}:${lens.id}:${attempt}`), n: 3, sample: view ? view.receiptLines : null });
  const banner = (readJsonIf(rp(rc, n).copy, {}).bannerFiles || []).map((rel) => `- ${rel} (${path.join(copyDir, ...rel.split('/'))})`);
  const values = {
    DUTY: lens.duty,
    LENS_TITLE: lens.title,
    PROCEDURE: (lens.procedure || []).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    CHECKLIST: (lens.checklist || []).map((s) => `- ${s}`).join('\n'),
    TASK: taskText(rc),
    REQUIREMENTS: requirementsValue(lensesJson),
    MATERIAL_LIST: materialListValue(copyDir, manifest, { annotate: view ? annotateForReviewer(view) : null }),
    AUTHOR_NOTES: banner.join('\n'),
    SOURCES: sourcesValue(rc, check),
    MINIMUM: minimumValue(lens, copyDir, manifest, view),
    SEVERITY: loadRunTemplate(rc.runDir, 'severity.md'),
    CHALLENGES: renderChallenges(challenges),
    ANSWER_LANGUAGE: rc.run.language?.answers || 'ru',
  };
  return issueJob(rc, {
    round: n,
    role: 'reviewer',
    lens: lens.id,
    attempt,
    values,
    confirmExtra,
    extra: { challenges, ...(confirmExtra ? { confirmExtra: true } : {}) },
    promptsDir: rp(rc, n).prompts,
    lintSkip: ['MATERIAL_LIST', 'AUTHOR_NOTES', 'MINIMUM', 'SEVERITY', 'CHALLENGES', 'ANSWER_LANGUAGE', 'NONCE', 'JOB_DIR', 'CHECK_COMMAND'],
    files: view ? view.files : [],
  });
}

// ---------------------------------------------------------------- 11.5 reviewers -> validity

/**
 * The copy must be exactly what was planted (11.5.2, SPEC 14.13). -> { ok: true } or
 * { ok: false, reasons, tamper } where tamper is the record of what differs (files added, changed or
 * removed, with sizes, times and the jobs that were running when each file was written).
 * One thing is tolerated: files ADDED at a place a tool writes by itself (Python byte-code in
 * __pycache__, the .pytest_cache folder). The engine removes them; when the copy then hashes to the
 * planted hash again the round counts, and the ledger and the report say so. A changed or removed
 * file, or any other new file (a helper script, an extract that another reviewer could have read),
 * is never tolerated.
 */
function checkPlantedCopy(rc, n, round, jobs, lensesJson) {
  const copyMissing = !exists(round.copyDir);
  let found = copyMissing ? null : copyListing(round.copyDir);
  if (found && found.treeHash === round.copyTreeHash1) return { ok: true };
  const known = readCopyListing(rc, n);
  const listingKnown = !!known && known.treeHash === round.copyTreeHash1;
  const lensTitle = (id) => (lensesJson?.lenses || []).find((l) => l.id === id)?.title ?? null;
  const windows = jobWindows(jobs, lensTitle);
  const make = (listing) => {
    const diff = listingKnown ? diffListings(known, listing) : { added: [], changed: [], removed: [] };
    return buildTamperRecord({ round: n, diff, expectedTreeHash: round.copyTreeHash1, foundTreeHash: listing?.treeHash ?? null, listingKnown, copyMissing: !listing, windows, detectedAt: now(), isoLocal, copyDir: round.copyDir });
  };
  let record = make(found);
  const onlyScratch = found && listingKnown && record.counts.changed === 0 && record.counts.removed === 0 && record.counts.added > 0 && record.counts.added === record.counts.total && record.files.length === record.counts.total && record.files.every((f) => isScratchPath(f.rel, round.copyDir));
  if (onlyScratch) {
    const rm = removeScratch(round.copyDir, record.files.map((f) => f.rel));
    const again = copyListing(round.copyDir);
    if (rm.failed.length === 0 && again.treeHash === round.copyTreeHash1) {
      log(rc, 'copy-tampered', ledgerData(record, { stage: 'while reviewers worked', action: 'only files that a tool writes by itself were added; they were removed and the round counts' }), n);
      saveRound(rc, n, { copyScratchRemoved: record.counts.total });
      rc.warnings.push(`${record.counts.total} scratch file(s) of a tool (Python byte-code or pytest cache) appeared in the review copy while reviewers worked; they were removed and the round counts (recorded in the ledger)`);
      return { ok: true, scratchRemoved: record.counts.total };
    }
    found = again;
    record = make(found);
  }
  const reasons = ['someone wrote into the review copy while reviewers worked; the round repeats'];
  if (copyMissing) reasons.push('the review copy folder is gone');
  if (listingKnown && record.counts.total > 0) {
    reasons.push(`files in the copy: ${record.counts.added} added, ${record.counts.changed} changed, ${record.counts.removed} removed (details in copy-tamper.json of the round)`);
  } else if (!listingKnown) reasons.push('the file list of the copy taken when it was planted is not available, so the files that differ cannot be named');
  return { ok: false, reasons, tamper: record };
}

export async function afterReviewers(rc, opts = {}) {
  const n = rc.state.round;
  const r = rp(rc, n);
  const jobs = loadJobs(rc, n);
  const round = readRound(rc, n);
  const lensesJson = loadLenses(rc);
  const pending = jobs.filter((j) => rc.state.pendingJobs.includes(j.job) && j.status === 'pending');
  for (const j of pending) {
    if (j.role === 'decoy') {
      const base = ingestAnswer(rc, n, j, decoyAnswerDest(rc, n));
      if (base || isGivenUp(opts, j.job)) {
        j.status = base ? 'answered' : 'given-up';
        if (base) j.answerSha256 = base.answerSha256;
        if (base?.answerFileMs) j.answeredAt = isoLocal(new Date(base.answerFileMs));
        else log(rc, 'job-given-up', { job: j.job, role: 'decoy' }, n);
        ingestDecoyWriter(rc, n, j, base);
      }
      continue;
    }
    const base = ingestAnswer(rc, n, j);
    if (base) {
      const rec = reviewerRecord(base, { job: j, lens: lensById(lensesJson, j.lens), copyDir: round.copyDir, requirements: lensesJson.requirements });
      writeIngest(rc, n, rec);
      j.status = 'answered';
      j.answerSha256 = base.answerSha256;
      if (base.answerFileMs) j.answeredAt = isoLocal(new Date(base.answerFileMs));
    } else if (isGivenUp(opts, j.job)) {
      j.status = 'given-up';
      log(rc, 'job-given-up', { job: j.job, role: 'reviewer', lens: j.lens, attempt: j.attempt }, n);
      writeIngest(rc, n, { job: j.job, lens: j.lens, attempt: j.attempt, confirmExtra: !!j.confirmExtra, kept: false, valid: false, reasons: ['given-up'], receipts: { correct: 0, total: 3 }, minimumMissing: [], minimumNotDone: [], minimumUnavailable: [], sourceAttempts: [], quoteChecks: [], metaMentions: [], ignoredScoreKeys: [], counts: { blocker: 0, major: 0, cosmetic: 0 }, notChecked: [], notVerified: [] });
    }
  }
  saveJobs(rc, n, jobs);
  const missing = jobs.filter((j) => rc.state.pendingJobs.includes(j.job) && j.status === 'pending');
  if (missing.length) return spawnResult(rc, missing, `Waiting for ${missing.length} reviewer answer(s); the calls are repeated below.`);

  // The copy must be exactly what was planted (11.5.2).
  const planted = checkPlantedCopy(rc, n, round, jobs, lensesJson);
  if (!planted.ok) return invalidRound(rc, n, planted.reasons, { tamper: planted.tamper });

  // Reveal (14.5): only after every answer of the wave is ingested and hashed.
  let key = readJsonIf(r.canaries, null);
  if (!round.revealed) {
    assertSampleSeal(rc, n);
    if (round.commitment) {
      key = revealKey(rc.dataPaths, rc.runId, n, round.commitment);
      writeJsonAtomic(r.canaries, key);
    } else {
      key = { schemaVersion: 1, runId: rc.runId, round: n, seedHex: null, canaries: [] };
      writeJsonAtomic(r.canaries, key);
    }
    saveRound(rc, n, { revealed: true });
    const moved = unstage(rc, n);
    log(rc, 'canary-reveal', { commitment: round.commitment ?? null, sha256: hashJson(key), canaries: key.canaries.length, unstaged: moved.length }, n);
  }
  return matchWave(rc, n, key);
}

function waveJobs(rc, n) {
  const jobs = loadJobs(rc, n);
  const round = readRound(rc, n);
  const wave = round.wave || 1;
  const ids = new Set(round[`wave${wave}Jobs`] || rc.state.pendingJobs);
  return jobs.filter((j) => j.role === 'reviewer' && ids.has(j.job));
}

function findingsByJobFor(rc, n, jobs, copyDir) {
  const out = {};
  for (const j of jobs) {
    const ing = readIngest(rc, n, j.job);
    if (!ing || !ing.kept) continue;
    const ans = storedAnswer(rc, n, j);
    const findings = (ans?.findings || []).map((f) => ({ ...f, location: { ...(f.location || {}), file: normaliseFile(copyDir, f.location?.file) } }));
    out[j.job] = { lens: j.lens, attempt: j.attempt, findings };
  }
  return out;
}

async function matchWave(rc, n, key) {
  const r = rp(rc, n);
  const round = readRound(rc, n);
  const wave = round.wave || 1;
  const jobs = waveJobs(rc, n);
  // Rows for every (canary x reviewer job) of the wave, including given-up jobs (missed).
  const fbj = findingsByJobFor(rc, n, jobs, round.copyDir);
  for (const j of jobs) if (!fbj[j.job]) fbj[j.job] = { lens: j.lens, attempt: j.attempt, findings: [] };
  const s1 = stage1(key.canaries, fbj, { copyDir: round.copyDir });
  writeJsonAtomic(path.join(r.dir, `match-${wave}.json`), { schemaVersion: 1, wave, decided: s1.decided, needMatcher: s1.needMatcher, unmatched: s1.unmatched });
  if (s1.needMatcher.length) {
    const pairs = buildMatcherPairs(s1.needMatcher, key.canaries);
    const values = { PAIRS: pairsValue(pairs) };
    const rec = issueJob(rc, { round: n, role: 'matcher', attempt: wave, values, extra: { wave }, promptsDir: r.prompts, lintSkip: ['PAIRS'] });
    const all = loadJobs(rc, n);
    all.push(rec);
    saveJobs(rc, n, all);
    move(rc, 'need-matcher', { pendingJobs: [rec.job] }, 'job-issued', { job: rec.job, role: 'matcher', wave }, n);
    return spawnResult(rc, [rec]);
  }
  return finishWave(rc, n, s1.decided, null);
}

function pairsValue(pairs) {
  return pairs
    .map((p) => {
      const lines = [
        `### ${p.canary}`,
        `- File: ${p.file}; place: ${p.locator || '(not given)'}`,
        `- Before: ${JSON.stringify(p.before)}`,
        `- After: ${JSON.stringify(p.after)}`,
        `- Defect: ${p.description}`,
        'Findings:',
      ];
      if (!p.findings.length) lines.push('- (none)');
      for (const f of p.findings) lines.push(`- ${f.finding} — file ${f.file}, place ${f.locator || '(not given)'}, quote ${JSON.stringify(f.quote)}, problem: ${f.problem}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** AWAIT_MATCHER */
export async function afterMatcher(rc, opts = {}) {
  const n = rc.state.round;
  const r = rp(rc, n);
  const jobs = loadJobs(rc, n);
  const rec = jobs.find((j) => rc.state.pendingJobs.includes(j.job));
  if (!rec) throw new UsageError('no matcher job is pending');
  const base = ingestAnswer(rc, n, rec);
  if (!base && !isGivenUp(opts, rec.job)) return spawnResult(rc, [rec], 'The matcher answer is not there yet.');
  rec.status = base ? 'answered' : 'given-up';
  if (base) rec.answerSha256 = base.answerSha256;
  else log(rc, 'job-given-up', { job: rec.job, role: 'matcher' }, n);
  saveJobs(rc, n, jobs);
  const m = readJsonIf(path.join(r.dir, `match-${rec.wave || 1}.json`));
  const answer = base && base.kept ? base.json : null;
  const detections = mergeMatcher(m.decided, answer, m.needMatcher);
  return finishWave(rc, n, detections, answer);
}

async function finishWave(rc, n, waveDetections, matcherAnswer) {
  const r = rp(rc, n);
  const round = readRound(rc, n);
  const wave = round.wave || 1;
  const prev = readJsonIf(r.detections, { schemaVersion: 1, round: n, detections: [] });
  const detections = [...prev.detections, ...waveDetections];
  writeJsonAtomic(r.detections, { schemaVersion: 1, round: n, detections });
  // Pre-planted (bench) canaries are edits that are really in the delivered material: findings
  // matched to them stay in the real-issue pipeline instead of being removed as canary catches.
  const fk = rc.run.canaries?.fixedKey;
  const allPrePlanted = !!fk && fk.prePlanted !== false;
  const fm = findingsMatched(allPrePlanted ? [] : waveDetections, matcherAnswer);
  const removed = [...new Set([...(round.matchedFindings || []), ...fm.remove])];
  const alsoReal = [...new Set([...(round.alsoReal || []), ...fm.alsoReal])];
  saveRound(rc, n, { matchedFindings: removed, alsoReal });
  const pc = pairCounts(waveDetections);
  log(rc, 'match', { wave, rows: waveDetections.length, caught: pc.caught, underclassified: pc.underclassified, missed: pc.missed, removedFindings: fm.remove.length }, n);

  // Lens validity (13.1) and reruns.
  const facts = lensFacts(rc, n);
  log(rc, 'lens-validity', { wave, facts }, n);
  // A primary source that blocked the reviewers is recorded in the ledger (and shown in the report and
  // the to-do): it never makes a lens invalid, but nobody may think it was checked.
  const unavailable = sourceAvailability(rc, n);
  if (unavailable.length) log(rc, 'source-unavailable', { wave, sources: unavailable }, n);
  const maxR = rc.run.limits.maxLensReruns;
  const rerun = Object.entries(facts)
    .filter(([, f]) => !(f.answerValid && f.caught) && f.guarded && f.attempts <= maxR)
    .map(([id]) => id);
  if (rerun.length) {
    const lensesJson = loadLenses(rc);
    const recs = rerun.map((id) => issueReviewer(rc, n, lensById(lensesJson, id), facts[id].attempts + 1));
    const jobs = loadJobs(rc, n);
    jobs.push(...recs);
    saveJobs(rc, n, jobs);
    const nextWave = wave + 1;
    saveRound(rc, n, { wave: nextWave, [`wave${nextWave}Jobs`]: recs.map((x) => x.job) });
    const rerunRecord = preGateRecord({ round: n, kind: rc.state.roundKind, versionHash: round.versionHash, decision: 'RERUN_LENS', reasons: rerun.map((id) => `lens ${id}: ${facts[id].answerValid ? 'attention check missed' : 'answer not valid'}`), limits: rc.run.limits });
    writeJsonAtomic(path.join(r.dir, `rerun-${wave}.json`), rerunRecord);
    move(rc, 'rerun', { pendingJobs: recs.map((x) => x.job) }, 'rerun', { decision: 'RERUN_LENS', lenses: rerun, jobs: recs.map((x) => x.job), wave: nextWave }, n);
    return spawnResult(rc, recs, `Decision RERUN_LENS: ${rerun.length} lens(es) are reviewed again by fresh reviewers.`);
  }
  return clusterAndVerify(rc, n);
}

/** Facts per lens for the gate: answer validity of the latest attempt, attention canary outcome. */
export function lensFacts(rc, n) {
  const lensesJson = loadLenses(rc);
  const jobs = loadJobs(rc, n).filter((j) => j.role === 'reviewer' && !j.confirmExtra);
  const key = readJsonIf(rp(rc, n).canaries, { canaries: [] });
  const dets = readJsonIf(rp(rc, n).detections, { detections: [] }).detections;
  const neverGuardable = new Set(unguardedLenses(lensesJson, loadTaxonomy(), rc.run));
  const earlier = countedRounds(rc, n);
  const out = {};
  for (const l of lensesJson.lenses) {
    const mine = jobs.filter((j) => j.lens === l.id).sort((a, b) => a.attempt - b.attempt);
    const canary = (key.canaries || []).find((c) => c.purpose === 'attention' && c.targetLens === l.id) || null;
    const rowsOf = (j) => (canary ? dets.filter((d) => d.canary === canary.canary && d.job === j.job) : []);
    // One attempt must be both a valid answer and a catch of the lens's own planted error: an invalid
    // attempt that caught it and a later valid attempt that missed it never add up to a valid lens
    // (r2-f21). The certifying attempt is the latest one that is both; else the latest attempt.
    const certifying = [...mine].reverse().find((j) => readIngest(rc, n, j.job)?.valid && rowsOf(j).some((d) => d.outcome === 'caught')) || null;
    const latest = certifying || mine[mine.length - 1];
    const ing = latest ? readIngest(rc, n, latest.job) : null;
    const rows = latest ? rowsOf(latest) : [];
    const caughtRow = rows.find((d) => d.outcome === 'caught');
    const bestRow = caughtRow || rows.find((d) => d.outcome === 'seen_underclassified') || rows[0] || null;
    // Consecutive rounds (this one included) in which no attention check reached this lens.
    let unguardedStreak = canary ? 0 : 1;
    if (!canary) {
      for (let i = earlier.length - 1; i >= 0; i--) {
        const pl = earlier[i].gate?.perLens?.[l.id];
        if (pl && pl.guarded === false) unguardedStreak += 1;
        else break;
      }
    }
    out[l.id] = {
      answerValid: !!(ing && ing.valid),
      attempts: mine.length,
      guarded: !!canary,
      guardable: !neverGuardable.has(l.id),
      unguardedStreak,
      caught: !!caughtRow,
      ownCanary: canary
        ? { canary: canary.canary, outcome: bestRow ? bestRow.outcome : 'missed', severityGiven: bestRow ? bestRow.severityGiven ?? null : null, intended: canary.intendedSeverity ?? null }
        : null,
      invalidReasons: ing ? (ing.valid ? [] : (ing.reasons || []).map((x) => `answer: ${x}`)) : ['answer: missing'],
    };
  }
  return out;
}

// ---------------------------------------------------------------- 11.6 clustering + verification

function keptReviewerAnswers(rc, n) {
  const jobs = loadJobs(rc, n).filter((j) => j.role === 'reviewer');
  const out = [];
  for (const j of jobs) {
    const ing = readIngest(rc, n, j.job);
    if (!ing || !ing.kept) continue;
    const ans = storedAnswer(rc, n, j);
    if (!ans) continue;
    out.push({ job: j, ing, ans });
  }
  return out;
}

async function clusterAndVerify(rc, n) {
  const round = readRound(rc, n);
  const lensesJson = loadLenses(rc);
  const kept = keptReviewerAnswers(rc, n);
  const removed = new Set(round.matchedFindings || []);
  const findings = [];
  for (const k of kept) {
    const fs2 = findingsOf({ kept: true, json: k.ans }, k.ing, { round: n, copyDir: round.copyDir });
    for (const f of fs2) if (!removed.has(`${f.job}#${f.n}`)) findings.push(f);
  }
  const before = loadClusters(rc);
  const carryIds = before.filter((c) => OPEN_SET.includes(c.status) && !c.waived).map((c) => c.id);
  const openForAttach = before.filter((c) => carryIds.includes(c.id));
  const { clusters: fresh, attached } = clusterFindings(findings, openForAttach, n, { startIndex: 1 });
  let all = [...attachMembers(before, attached), ...fresh];
  const reqAnswers = kept.map((k) => ({ job: k.job.job, lens: k.job.lens, round: n, requirements: k.ans.requirements || [] }));
  const rq = requirementClusters(reqAnswers, lensesJson.requirements, all, n, { startIndex: fresh.length + 1 });
  all = rq.clusters;
  const sel = selectForVerification(all, { versionHash: round.versionHash });
  all = settleCosmetic(all, sel.cosmeticOnly, { round: n, versionHash: round.versionHash });
  saveClusters(rc, all);
  log(rc, 'cluster', { findings: findings.length, newClusters: fresh.map((c) => c.id), attached: attached.length, requirementCreated: rq.created, requirementReopened: rq.reopened, carryOver: carryIds, toVerify: sel.verify.length, cosmetic: sel.cosmeticOnly.length }, n);

  // True controls (SPEC 14.12): the reviewer findings matched to planted errors, sealed before any verifier is asked.
  if (controlsActive(rc) && sel.verify.length) sealControls(rc, n, { keptAnswers: kept, removed: [...removed] });
  const decoys = decoysForGroup(rc, n, { realItems: sel.verify.length, batchMax: rc.run.limits.verifierBatchMax, existingIds: all.map((c) => c.id), rngFor: (p) => rngFor(rc, `${p}:${n}`) });
  const controls = controlsForGroup(rc, n, { realItems: sel.verify.length, batchMax: rc.run.limits.verifierBatchMax, existingIds: all.map((c) => c.id), rngFor: (p) => rngFor(rc, `${p}:${n}`) });
  const built = buildItems(all, { roundKind: rc.state.roundKind, versionHash: round.versionHash, rng: rngFor(rc, `items:${n}`), batchMax: rc.run.limits.verifierBatchMax, only: sel.verify, decoys: [...decoys, ...controls] });
  recordPlacement(rc, n, 1, built.decoyItems);
  recordControlPlacement(rc, n, 1, built.controlItems);
  const disputes = pendingDisputes(rc);
  const recs = [];
  const batches = [];
  const r = rp(rc, n);
  built.batches.forEach((b, i) => {
    const items = built.items.filter((it) => it.pass === b.pass && b.items.includes(it.item));
    const rec = issueVerifier(rc, n, items, { batch: i + 1, pass: b.pass });
    recs.push(rec);
    batches.push({ job: rec.job, pass: b.pass, items: b.items });
  });
  // Two independent dispute verifiers: one alone can never close or lower a cluster.
  const disputeJobs = disputes.length ? [issueDispute(rc, n, disputes, all, 1), issueDispute(rc, n, disputes, all, 2)] : [];
  recs.push(...disputeJobs);
  writeJsonAtomic(r.verifyItems, {
    schemaVersion: 1,
    round: n,
    kind: rc.state.roundKind,
    items: built.items,
    batches,
    carryOverIds: carryIds,
    verify: sel.verify,
    pass2: null,
    verdicts: {},
    dispute: disputeJobs.length ? { jobs: disputeJobs.map((j) => j.job), disputes: disputes.map((d) => d.id) } : null,
  });
  if (!recs.length) return closeRound(rc, n);
  const jobs = loadJobs(rc, n);
  jobs.push(...recs);
  saveJobs(rc, n, jobs);
  move(rc, 'verify', { pendingJobs: recs.map((x) => x.job) }, 'verify-issued', { items: built.items.length, jobs: recs.map((x) => x.job), disputes: disputes.length }, n);
  return spawnResult(rc, recs);
}

function itemsValue(items, copyDir) {
  return items
    .map((it) =>
      [
        `### ${it.item}`,
        `- File: ${it.file ? `${it.file} (${path.join(copyDir, ...String(it.file).split('/'))})` : 'the whole work'}`,
        `- Place: ${it.locator || '(not given)'}`,
        it.shown.startsWith('missing: ') || it.shown.startsWith('visible: ') ? `- ${it.shown[0].toUpperCase()}${it.shown.slice(1)}` : `- Text: ${JSON.stringify(it.shown)}`,
        `- Claim: ${it.claim}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * What the reviewers of this round reported about sources that refused them, as lines to add to the SOURCES
 * block of a verifier prompt: a claim that only such a source could settle is `unverifiable` for the verifier
 * too, unless it reaches the source itself and the source answers. Source ids and counts only (no reviewer text).
 */
export function unavailableSourcesNote(rc, n) {
  const list = sourceAvailability(rc, n);
  if (!list.length) return '';
  const lines = ['', 'Sources that refused the reviewers in this round (a block, an error or a timeout, as the reviewers documented):'];
  for (const u of list) lines.push(`- ${u.sourceId}: ${u.unavailable} of ${u.attempts} documented attempt(s) failed.`);
  lines.push('A claim that only one of these sources could settle is `unverifiable` unless you reach the source yourself and it answers; `evidence` says what you tried.');
  return lines.join('\n');
}

function issueVerifier(rc, n, items, { batch, pass }) {
  const round = readRound(rc, n);
  const check = readJsonIf(rp(rc, n).sourcesCheck, null)?.results || null;
  const values = {
    TASK: taskText(rc),
    MATERIAL_LIST: materialListValue(round.copyDir, manifestOfDir(round.copyDir)),
    SOURCES: sourcesValue(rc, check) + unavailableSourcesNote(rc, n),
    SEVERITY: loadRunTemplate(rc.runDir, 'severity.md'),
    ITEMS: itemsValue(items, round.copyDir),
    ANSWER_LANGUAGE: rc.run.language?.answers || 'ru',
  };
  // Item claims are reviewers' words, not the executor's: they are not prompt-linted (recorded deviation).
  return issueJob(rc, {
    round: n,
    role: 'verifier',
    attempt: 1,
    values,
    extra: { batch, verifierPass: pass, items: items.map((i) => i.item) },
    promptsDir: rp(rc, n).prompts,
    lintSkip: ['MATERIAL_LIST', 'SEVERITY', 'ITEMS', 'ANSWER_LANGUAGE', 'NONCE', 'JOB_DIR', 'CHECK_COMMAND'],
  });
}

function issueDispute(rc, n, disputes, clusters, pass = 1) {
  const round = readRound(rc, n);
  const check = readJsonIf(rp(rc, n).sourcesCheck, null)?.results || null;
  const values = {
    TASK: taskText(rc),
    MATERIAL_LIST: materialListValue(round.copyDir, manifestOfDir(round.copyDir)),
    SOURCES: sourcesValue(rc, check) + unavailableSourcesNote(rc, n),
    SEVERITY: loadRunTemplate(rc.runDir, 'severity.md'),
    DISPUTES: renderDisputes(disputes, clusters, round.copyDir),
    ANSWER_LANGUAGE: rc.run.language?.answers || 'ru',
  };
  return issueJob(rc, {
    round: n,
    role: 'dispute',
    attempt: pass,
    values,
    extra: { disputes: disputes.map((d) => d.id), disputePass: pass },
    promptsDir: rp(rc, n).prompts,
    // DISPUTES quotes the material and reviewers' words; the executor's argument, the evidence command
    // and its output were prompt-linted when the dispute was recorded.
    lintSkip: ['MATERIAL_LIST', 'SEVERITY', 'DISPUTES', 'ANSWER_LANGUAGE', 'NONCE', 'JOB_DIR', 'CHECK_COMMAND'],
  });
}

/**
 * The second wave of verification (state AWAIT_VERIFY2): second verifiers (pass 2) for refuted
 * items that need a second opinion, and fresh verifiers (pass 3 for the first slot, pass 4 for the
 * second) that re-check what an untrusted verifier job decided: its confirmations when it confirmed a decoy
 * (SPEC 14.11), its refutations and its confirmation that makes a serious item cosmetics when it refuted or downgraded a true control
 * (SPEC 14.12).
 */
function issueSecondWave(rc, n, vi, clusters, { needSecond, reverify }) {
  const round = readRound(rc, n);
  const batchMax = rc.run.limits.verifierBatchMax;
  const groups = [];
  if (needSecond.length) groups.push({ pass: 2, ids: needSecond });
  for (const slot of [1, 2]) {
    const ids = [...new Set(reverify.filter((x) => x.slot === slot).map((x) => x.cluster))];
    if (ids.length) groups.push({ pass: 2 + slot, ids });
  }
  const recs = [];
  const newItems = [];
  const newBatches = [];
  for (const g of groups) {
    const decoys = decoysForGroup(rc, n, { realItems: g.ids.length, batchMax, existingIds: clusters.map((c) => c.id), rngFor: (p) => rngFor(rc, `${p}:${n}:${g.pass}`) });
    const controls = controlsForGroup(rc, n, { realItems: g.ids.length, batchMax, existingIds: clusters.map((c) => c.id), rngFor: (p) => rngFor(rc, `${p}:${n}:${g.pass}`) });
    const built = buildItems(clusters, { roundKind: 'working', versionHash: round.versionHash, rng: rngFor(rc, `items${g.pass}:${n}`), batchMax, only: g.ids, pass: g.pass, decoys: [...decoys, ...controls] });
    recordPlacement(rc, n, 2, built.decoyItems);
    recordControlPlacement(rc, n, 2, built.controlItems);
    built.batches.forEach((b, i) => {
      const items = built.items.filter((it) => b.items.includes(it.item));
      const rec = issueVerifier(rc, n, items, { batch: i + 1, pass: g.pass });
      recs.push(rec);
      newBatches.push({ job: rec.job, pass: g.pass, items: b.items });
    });
    newItems.push(...built.items);
  }
  vi.items = [...vi.items, ...newItems];
  vi.batches = [...vi.batches, ...newBatches];
  vi.pass2 = needSecond;
  vi.reverify = reverify;
  writeJsonAtomic(rp(rc, n).verifyItems, vi);
  const all = loadJobs(rc, n);
  all.push(...recs);
  saveJobs(rc, n, all);
  move(rc, 'verify2', { pendingJobs: recs.map((x) => x.job) }, 'verify-issued', { pass: 2, items: newItems.length, jobs: recs.map((x) => x.job), ...(reverify.length ? { reverify: reverify.length } : {}) }, n);
  const note =
    needSecond.length && reverify.length
      ? 'Second verifiers for refuted items that need a second opinion, and fresh verifiers for items that an untrusted verifier decided.'
      : reverify.length
        ? 'Fresh verifiers for items that an untrusted verifier decided.'
        : 'Second verifiers for refuted items that need a second opinion.';
  return spawnResult(rc, recs, note);
}

/** AWAIT_VERIFY / AWAIT_VERIFY2 */
export async function afterVerify(rc, opts = {}) {
  const n = rc.state.round;
  const r = rp(rc, n);
  const round = readRound(rc, n);
  const jobs = loadJobs(rc, n);
  const pending = jobs.filter((j) => rc.state.pendingJobs.includes(j.job) && j.status === 'pending');
  const vi = readJsonIf(r.verifyItems);
  for (const j of pending) {
    const base = ingestAnswer(rc, n, j);
    if (base) {
      j.status = 'answered';
      j.answerSha256 = base.answerSha256;
      j.kept = base.kept;
    } else if (isGivenUp(opts, j.job)) {
      j.status = 'given-up';
      log(rc, 'job-given-up', { job: j.job, role: j.role }, n);
    }
  }
  saveJobs(rc, n, jobs);
  const missing = jobs.filter((j) => rc.state.pendingJobs.includes(j.job) && j.status === 'pending');
  if (missing.length) return spawnResult(rc, missing, `Waiting for ${missing.length} answer(s); the calls are repeated below.`);

  const wave = jobs.filter((j) => rc.state.pendingJobs.includes(j.job));
  const waveNo = rc.state.state === 'AWAIT_VERIFY' ? 1 : 2;
  const itemMap = new Map(vi.items.map((it) => [`${it.pass}:${it.item}`, it.cluster]));
  const decoyAt = decoyItemIndex(rc, n);
  const controlAt = controlItemIndex(rc, n);
  const verdicts = vi.verdicts || {};
  const fresh = [];
  const decoyRows = [];
  const controlRows = [];
  for (const j of wave.filter((x) => x.role === 'verifier')) {
    const ans = j.kept ? storedAnswer(rc, n, j) : null;
    for (const item of j.items || []) {
      const cid = itemMap.get(`${j.verifierPass}:${item}`);
      if (!cid) continue;
      const v = ans ? (ans.items || []).find((x) => x.item === item) : null;
      const decoy = decoyAt.get(`${j.verifierPass}:${item}`);
      if (decoy) {
        // A decoy never becomes a cluster: its verdict goes to the sealed decoy results only.
        decoyRows.push({ decoy, wave: waveNo, pass: j.verifierPass, item, job: j.job, batch: j.batch ?? null, verdict: v ? v.verdict : null, severity: v ? v.severity ?? null : null, answered: !!v });
        continue;
      }
      const control = controlAt.get(`${j.verifierPass}:${item}`);
      if (control) {
        // A true control never becomes a cluster either: its verdict goes to the sealed control results only.
        controlRows.push({ control, wave: waveNo, pass: j.verifierPass, item, job: j.job, batch: j.batch ?? null, verdict: v ? v.verdict : null, severity: v ? v.severity ?? null : null, answered: !!v });
        continue;
      }
      let quoteNowGrounded = false;
      if (v && v.quoteNow) {
        const where = normaliseFile(round.copyDir, String(v.whereNow || '').split(/[ ,;:#]/)[0] || null);
        quoteNowGrounded = findQuote(round.copyDir, where, v.quoteNow).found;
      }
      const entry = v
        ? { verdict: v.verdict, severity: v.severity ?? null, evidence: v.evidence ?? '', quoteNow: v.quoteNow ?? null, whereNow: v.whereNow ?? null, quoteNowGrounded, job: j.job, pass: j.verifierPass, wave: waveNo }
        : { verdict: 'unverifiable', severity: null, evidence: j.status === 'given-up' ? 'verifier gave no answer' : 'no verdict for this item', quoteNow: null, quoteNowGrounded: false, job: j.job, pass: j.verifierPass, wave: waveNo };
      (verdicts[cid] = verdicts[cid] || []).push(entry);
      fresh.push({ cluster: cid, entry });
    }
  }
  // A verifier job that confirmed a decoy is not trusted: what it confirmed is not applied (SPEC 14.11).
  const confirmedBy = new Map();
  for (const row of decoyRows) if (row.verdict === 'confirmed') confirmedBy.set(row.job, [...(confirmedBy.get(row.job) || []), row.decoy]);
  // A verifier job that refuted a true control, or confirmed it below the planted class, is not trusted
  // for its refutations, nor for its confirmations that make a serious item cosmetic: neither is applied
  // (SPEC 14.12). Any other confirmation stands.
  const storedControls = recordControlResults(rc, n, controlRows, []);
  const failedBy = new Map();
  for (const row of storedControls) if (controlFailed(row.outcome)) failedBy.set(row.job, [...(failedBy.get(row.job) || []), row.control]);
  const byDecoy = fresh.filter((f) => confirmedBy.has(f.entry.job) && f.entry.verdict === 'confirmed');
  const claimedOf = new Map(loadClusters(rc).map((c) => [c.id, c.claimedSeverity ?? c.severity ?? null]));
  const byControl = fresh.filter((f) => failedBy.has(f.entry.job) && (f.entry.verdict === 'refuted' || playsDown(f.entry, claimedOf.get(f.cluster))));
  const untrusted = [...new Set([...byDecoy, ...byControl])];
  const reverify = waveNo === 1 ? untrusted.map((u) => ({ cluster: u.cluster, slot: u.entry.pass })) : [];
  for (const u of untrusted) {
    u.entry.untrusted = true;
    if (waveNo === 2) {
      // no third wave: a confirmation (decoy), a refutation or a confirmation that makes a serious item cosmetic (control) of an untrusted verifier counts as "could not decide"
      u.entry.originalVerdict = u.entry.verdict;
      u.entry.verdict = 'unverifiable';
      u.entry.severity = null;
    }
  }
  const passOf = (job) => wave.find((x) => x.job === job)?.verifierPass ?? null;
  const taintedRecords = [...confirmedBy.entries()].map(([job, ds]) => ({
    job,
    wave: waveNo,
    pass: passOf(job),
    decoys: ds,
    items: byDecoy.filter((u) => u.entry.job === job).length,
    reverify: waveNo === 1,
  }));
  const taintedControls = [...failedBy.entries()].map(([job, ks]) => ({
    job,
    wave: waveNo,
    pass: passOf(job),
    controls: ks,
    items: byControl.filter((u) => u.entry.job === job).length,
    reverify: waveNo === 1,
  }));
  recordResults(rc, n, decoyRows, taintedRecords);
  if (taintedControls.length) recordControlResults(rc, n, [], taintedControls);
  if (confirmedBy.size) log(rc, 'decoy-confirmed', { wave: waveNo, jobs: [...confirmedBy.keys()], untrustedItems: byDecoy.length, reverify: reverify.length }, n);
  if (failedBy.size) log(rc, 'control-dismissed', { wave: waveNo, jobs: [...failedBy.keys()], untrustedItems: byControl.length, reverify: reverify.length }, n);

  // Dispute answers (first wave only): one list per dispute verifier.
  const djs = wave.filter((x) => x.role === 'dispute').sort((a, b) => (a.attempt || 1) - (b.attempt || 1));
  if (djs.length) {
    vi.disputeAnswers = djs.map((dj) => {
      const ans = dj.kept ? storedAnswer(rc, n, dj) : null;
      log(rc, 'dispute-ingested', { job: dj.job, pass: dj.attempt || 1, ok: !!ans }, n);
      return ans ? ans.items || [] : null;
    });
  }
  let clusters = loadClusters(rc);
  const kind = rc.state.roundKind;
  if (rc.state.state === 'AWAIT_VERIFY' && kind === 'working') {
    const deferred = new Set(reverify.map((x) => x.cluster));
    const firstMap = {};
    for (const cid of vi.verify) if (!deferred.has(cid)) firstMap[cid] = verdicts[cid] || [];
    const res = applyVerdicts(clusters, firstMap, { roundKind: 'working', pass: 1, round: n, versionHash: round.versionHash, carryOverIds: vi.carryOverIds });
    clusters = res.clusters;
    saveClusters(rc, clusters);
    vi.verdicts = verdicts;
    log(rc, 'verify-ingested', { pass: 1, changes: res.changes, needSecond: res.needSecond }, n);
    if (res.needSecond.length || reverify.length) return issueSecondWave(rc, n, vi, clusters, { needSecond: res.needSecond, reverify });
  } else if (rc.state.state === 'AWAIT_VERIFY2') {
    const map = {};
    for (const cid of vi.pass2 || []) map[cid] = verdicts[cid] || [];
    const res = applyVerdicts(clusters, map, { roundKind: 'working', pass: 2, round: n, versionHash: round.versionHash, carryOverIds: vi.carryOverIds });
    clusters = res.clusters;
    // Items re-checked by fresh verifiers: the fresh verdict takes the place of the untrusted one.
    const rv = settleReverified(clusters, vi, verdicts, { kind, round: n, versionHash: round.versionHash });
    clusters = rv.clusters;
    saveClusters(rc, clusters);
    vi.verdicts = verdicts;
    log(rc, 'verify-ingested', { pass: 2, changes: [...res.changes, ...rv.changes], ...(rv.changes.length ? { reverified: rv.changes.length } : {}) }, n);
  } else {
    const deferred = new Set(reverify.map((x) => x.cluster));
    const map = {};
    for (const cid of vi.verify) if (!deferred.has(cid)) map[cid] = verdicts[cid] || [];
    const res = applyVerdicts(clusters, map, { roundKind: 'confirm', pass: 'both', round: n, versionHash: round.versionHash, carryOverIds: vi.carryOverIds });
    clusters = res.clusters;
    saveClusters(rc, clusters);
    vi.verdicts = verdicts;
    log(rc, 'verify-ingested', { pass: 'both', changes: res.changes }, n);
    if (reverify.length) return issueSecondWave(rc, n, vi, clusters, { needSecond: [], reverify });
  }
  writeJsonAtomic(r.verifyItems, vi);
  if (vi.dispute) {
    const out = applyDisputeAnswer(rc, n, vi.dispute.disputes, vi.disputeAnswers || [null, null], loadClusters(rc), round.versionHash);
    saveClusters(rc, out.clusters);
  }
  return closeRound(rc, n);
}

/**
 * Apply the verdicts of the fresh verifiers that re-checked what an untrusted verifier confirmed.
 * vi.reverify: [{ cluster, slot }]; the fresh verdict of slot k comes from pass 2 + k. A working
 * round has one verdict per item (slot 1); a confirm round has two (the untrusted slot is replaced,
 * the other keeps its verdict). A refuted blocker that would need a second opinion is left
 * unverified: nobody trusted has confirmed it and nobody has refuted it twice.
 */
function settleReverified(clusters, vi, verdicts, { kind, round, versionHash }) {
  const rv = vi.reverify || [];
  const changes = [];
  const ids = [...new Set(rv.map((x) => x.cluster))];
  let out = clusters;
  const unsettled = [];
  for (const cid of ids) {
    const slots = new Set(rv.filter((x) => x.cluster === cid).map((x) => x.slot));
    const mine = verdicts[cid] || [];
    const slotVerdict = (slot) => {
      if (slots.has(slot)) {
        const repl = mine.find((e) => e.pass === 2 + slot);
        return { ...(repl || { verdict: 'unverifiable', severity: null, evidence: 'no verdict for this item', quoteNow: null, quoteNowGrounded: false, job: null }), pass: slot };
      }
      const keep = mine.find((e) => e.pass === slot && !e.untrusted);
      return keep ? { ...keep, pass: slot } : null;
    };
    const vs = kind === 'confirm' ? [slotVerdict(1), slotVerdict(2)].filter(Boolean) : [slotVerdict(1)];
    const carry = (vi.carryOverIds || []).includes(cid);
    const res = applyVerdicts(out, { [cid]: vs }, { roundKind: kind === 'confirm' ? 'confirm' : 'working', pass: kind === 'confirm' ? 'both' : 1, round, versionHash, carryOverIds: carry ? [cid] : [] });
    out = res.clusters;
    changes.push(...res.changes);
    unsettled.push(...res.needSecond);
  }
  if (unsettled.length) out = settleUnverified(out, unsettled, { round, versionHash, why: 'the first verifier was not trusted and the fresh one refuted; no second opinion' });
  return { clusters: out, changes };
}

// ---------------------------------------------------------------- 11.7 gate + close

function clusterSnapshot(clusters) {
  return clusters.map((c) => ({
    id: c.id,
    origin: c.origin,
    status: c.status,
    severity: c.severity ?? null,
    claimedSeverity: c.claimedSeverity ?? null,
    waived: c.status === 'waived' || !!c.waived,
    lenses: [...new Set((c.members || []).map((m) => m.lens).filter(Boolean))].sort(),
  }));
}

/** Assemble the gate input from round files (audit rebuilds its lens facts with lensFacts, r3-f17). */
export function gateInputFor(rc, n) {
  const round = readRound(rc, n);
  const lensesJson = loadLenses(rc);
  const facts = lensFacts(rc, n);
  const clusters = clusterSnapshot(loadClusters(rc));
  const disputes = loadDisputes(rc).disputes.filter((d) => d.status === 'pending');
  const t = tokenSummary(rc);
  const dets = readJsonIf(rp(rc, n).detections, { detections: [] }).detections;
  const pc = pairCounts(dets);
  return {
    round: n,
    kind: round.kind,
    versionHash: round.versionHash,
    candidate: rc.state.candidate,
    ownerStop: ownerStopPending(rc, n),
    lenses: lensesJson.lenses.map((l) => l.id),
    lensFacts: facts,
    clusters,
    pendingDisputes: disputes.length,
    history: historyBefore(rc, n),
    bestRule: 'reviewed',
    plateauRule: 'reviewed',
    lastContinueRound: lastContinueRound(rc),
    confirmsDone: rc.state.confirmsDone || 0,
    roundsDone: workingRoundsCount(rc, n) + (round.kind === 'confirm' ? 0 : 1),
    tokensSpent: t.spent,
    nextEstimate: t.nextEstimate,
    limits: {
      maxRounds: rc.run.limits.maxRounds,
      maxConfirms: rc.run.limits.maxConfirms,
      maxPanelTokens: rc.run.limits.maxPanelTokens,
      plateauRounds: rc.run.limits.plateauRounds,
      maxLensReruns: rc.run.limits.maxLensReruns,
    },
    panelCatch: { pairsCaught: pc.caught, pairsTotal: pc.total },
  };
}

async function appendMeasurementRows(rc, n) {
  try {
    const m = await import('../measure/mledger.mjs');
    const round = readRound(rc, n);
    const key = readJsonIf(rp(rc, n).canaries, null);
    const dets = readJsonIf(rp(rc, n).detections, { detections: [] }).detections;
    const clusters = loadClusters(rc).filter((c) => (c.evidence || []).some((e) => e.round === n));
    const verdicts = clusters.map((c) => m.verdictRowFromCluster(c, { round: n, roundKind: round.kind }));
    const jobModels = {};
    for (const j of loadJobs(rc, n)) if (j.role === 'reviewer') jobModels[j.job] = j.model ?? null;
    const lensesJson = loadLenses(rc);
    let materialChars = null;
    try {
      materialChars = positionIndex(rp(rc, n).snapshot, rc.run.material?.readingOrder || []).totalChars;
    } catch {
      materialChars = null;
    }
    m.appendRunRows(rc.dataPaths, {
      run: rc.run,
      round: n,
      roundKind: round.kind,
      instrumentId: rc.frozen?.instrumentId ?? null,
      lensSetId: rc.frozen?.lensSetId ?? rc.frozen?.sha256?.lenses ?? null,
      lenses: lensesJson.lenses,
      key,
      detections: dets,
      verdicts,
      templateSha: rc.frozen?.sha256?.templates?.['reviewer.md'] ?? null,
      materialChars,
      jobModels,
      seeded: !!round.seeded,
      decoys: decoyLedgerRows(rc, n, { jobModels: verifierModels(rc, n) }),
      controls: controlLedgerRows(rc, n, { jobModels: verifierModels(rc, n) }),
    });
  } catch (e) {
    rc.warnings.push(`measurement ledger: rows of round ${n} not written (${e.message})`);
  }
}

function verifierModels(rc, n) {
  const out = {};
  for (const j of loadJobs(rc, n)) if (j.role === 'verifier') out[j.job] = j.model ?? null;
  return out;
}

function cleanupRound(rc, n) {
  // The decoys are sealed until a round ends, whichever way it ends.
  revealDecoys(rc, n);
  const round = readRound(rc, n);
  const left = [];
  if (round?.copyDir) {
    const res = safeRemove(round.copyDir);
    if (!res.removed) left.push(...res.leftovers);
  }
  const jobs = loadJobs(rc, n);
  for (const j of jobs) {
    if (j.dir && exists(j.dir)) {
      const res = safeRemove(j.dir);
      if (!res.removed) left.push(...res.leftovers);
    }
  }
  safeRemove(seedPath(rc, n));
  safeRemove(copyListingPath(rc, n));
  saveRound(rc, n, { closedAt: now(), copyRemoved: left.length === 0, leftovers: left });
  return left;
}

export async function closeRound(rc, n) {
  const r = rp(rc, n);
  const input = gateInputFor(rc, n);
  const gate = decide(input);
  writeJsonAtomic(path.join(r.dir, 'gate-input.json'), { schemaVersion: 1, ...input });
  writeJsonAtomic(r.gate, gate);
  if (input.ownerStop) markStopsApplied(rc);

  let best = rc.state.best;
  if (gate.best && (!best || best.round !== gate.best.round)) {
    best = gate.best;
    writeJsonAtomic(rc.paths.best, { schemaVersion: 1, ...best, snapshot: path.join(rp(rc, best.round).snapshot) });
    log(rc, 'best', best, n);
  }
  revealDecoys(rc, n);
  await appendMeasurementRows(rc, n);
  const leftovers = cleanupRound(rc, n);
  const clusters = loadClusters(rc);
  const round = readRound(rc, n);
  const todoText = renderTodo({
    decision: gate.decision,
    gate,
    clusters,
    extra: {
      precheck: readJsonIf(r.precheck, { results: [] }).results,
      incidental: round.incidental || [],
      notVerified: notVerifiedOf(rc, n),
      sourcesUnavailable: sourceAvailability(rc, n),
      unlistedRecent: readJsonIf(r.manifest, { unlistedRecent: [] }).unlistedRecent || [],
      runDir: rc.runDir,
    },
  });
  writeTextAtomic(r.todo, todoText);
  log(rc, 'gate', { decision: gate.decision, gateSha256: hashJson(gate), inputSha256: hashJson({ schemaVersion: 1, ...input }), reasons: gate.reasons.slice(0, 20) }, n);

  const patch = { lastDecision: gate.decision, best, pendingJobs: [], confirmsDone: gate.limits.confirmsDone };
  const closeData = { decision: gate.decision, leftovers };
  if (gate.decision === 'CONFIRM') patch.candidate = { round: n, versionHash: gate.versionHash };
  else if (input.kind === 'confirm' && gate.decision !== 'DONE') patch.candidate = null;

  if (gate.decision === 'FIX' || gate.decision === 'CONFIRM') {
    move(rc, 'round-continue', patch, 'round-close', closeData, n);
    const open = gate.open.blocker + gate.open.major;
    return todoResult(rc, {
      decision: gate.decision,
      todoPath: r.todo,
      items:
        gate.decision === 'CONFIRM'
          ? ['The material is clean in this round. Change nothing.']
          : open > 0
            ? [`${open} open serious problem(s) (blockers ${gate.open.blocker}, majors ${gate.open.major}); fix what todo.md lists.`]
            : ['No open serious problems, but the round did not count as clean (a lens could not be checked or its answer was not valid). Change nothing; run step to repeat the round.'],
      summary: gate.decision === 'CONFIRM' ? 'clean working round' : open > 0 ? 'fix the open problems' : 'repeat the round',
      next: gate.decision === 'CONFIRM' ? 'run step to start the confirm round (change nothing in the material)' : open > 0 ? 'fix the material as todo.md says, then step' : 'run step (change nothing in the material)',
    });
  }
  if (gate.decision === 'DONE') {
    move(rc, 'stop', { ...patch, stoppedReason: null }, 'round-close', closeData, n);
    return todoResult(rc, {
      decision: 'DONE',
      todoPath: r.todo,
      items: ['Two clean rounds in a row on the same version. Change nothing; run done to bind the result to the live files.'],
      summary: 'done (pending the live-file check)',
      next: 'run done',
    });
  }
  // STOP_*
  move(rc, 'stop', { ...patch, stoppedReason: gate.reasons.join('; ') || gate.decision }, 'round-close', closeData, n);
  await appendRunEndRow(rc);
  const rep = await writeReport(rc);
  return stopResultFrom(rc, gate.decision, rep);
}

/**
 * sourceAvailability(rc, n) -> [{ sourceId, state: "unavailable" | "partial", attempts, ok, unavailable, lenses, excerpt }]
 * Over the kept reviewer answers of round n: a source with documented "unavailable" attempts. "unavailable"
 * means not one attempt worked; "partial" means some did.
 */
export function sourceAvailability(rc, n) {
  const by = new Map();
  for (const j of loadJobs(rc, n).filter((x) => x.role === 'reviewer')) {
    const ing = readIngest(rc, n, j.job);
    if (!ing || !ing.kept) continue;
    for (const a of ing.sourceAttempts || []) {
      const e = by.get(a.sourceId) || { sourceId: a.sourceId, attempts: 0, ok: 0, unavailable: 0, lenses: [], excerpt: '' };
      e.attempts += a.attempts;
      e.ok += a.ok;
      e.unavailable += a.unavailable;
      if (a.unavailable > 0 && !e.lenses.includes(ing.lens)) e.lenses.push(ing.lens);
      if (!e.excerpt && a.excerpt) e.excerpt = a.excerpt;
      by.set(a.sourceId, e);
    }
  }
  // The code's own check of every source at the start of the round (sources-check.json): if it read the source
  // fine while a reviewer wrote that the source was unavailable, the claim is flagged `suspicious` -
  // whether every attempt failed or only some (one invented "unavailable" entry among real ones must not
  // escape the flag, night 06-07.10.2026). Nothing more happens
  // (the reviewer's words stay the record), but nobody reads an unchecked source as a blocked one without a look.
  const precheck = new Map((readJsonIf(rp(rc, n).sourcesCheck, null)?.results || []).map((x) => [x.id, x]));
  return [...by.values()]
    .filter((e) => e.unavailable > 0)
    .map((e) => {
      const state = e.ok === 0 ? 'unavailable' : 'partial';
      const pre = precheck.get(e.sourceId);
      return { ...e, state, ...(pre && pre.ok === true ? { precheckOk: true, suspicious: true } : {}) };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId, 'en', { numeric: true }));
}

function notVerifiedOf(rc, n) {
  const out = [];
  for (const j of loadJobs(rc, n).filter((x) => x.role === 'reviewer')) {
    const ing = readIngest(rc, n, j.job);
    for (const v of ing?.notVerified || []) out.push(v);
  }
  return out;
}

/** INVALID_ROUND (copy edited during review): counts as a round; state READY; exit 20. */
async function invalidRound(rc, n, reasons, { tamper = null } = {}) {
  const r = rp(rc, n);
  const round = readRound(rc, n);
  // Reveal the key anyway (evidence), if it is still sealed.
  if (!round.revealed && round.commitment) {
    try {
      assertSampleSeal(rc, n);
      const key = revealKey(rc.dataPaths, rc.runId, n, round.commitment);
      writeJsonAtomic(r.canaries, key);
      saveRound(rc, n, { revealed: true });
      const moved = unstage(rc, n);
      log(rc, 'canary-reveal', { commitment: round.commitment, sha256: hashJson(key), canaries: key.canaries.length, invalidRound: true, unstaged: moved.length }, n);
    } catch (e) {
      if (e instanceof IntegrityError) throw e;
    }
  }
  const t = tokenSummary(rc);
  const history = historyBefore(rc, n);
  const g = preGateRecord({
    round: n,
    kind: round.kind,
    versionHash: round.versionHash,
    decision: 'INVALID_ROUND',
    reasons,
    history: [...history, { round: n, kind: round.kind, valid: false, reviewed: false, versionHash: round.versionHash, openBlockers: 0, openMajors: 0, distinctOpen: 0 }],
    limits: rc.run.limits,
    best: rc.state.best,
    confirmsDone: rc.state.confirmsDone,
    roundsDone: workingRoundsCount(rc, n) + (round.kind === 'confirm' ? 0 : 1),
    tokensSpent: t.spent,
    nextEstimate: t.nextEstimate,
  });
  writeJsonAtomic(r.gate, g);
  // Which files changed, how, when and who was running (SPEC 14.13): the full record in the round
  // folder, a short one in the ledger, plain Russian in the to-do (and in the report, from the record).
  let todoProblems = reasons;
  if (tamper) {
    writeJsonAtomic(r.copyTamper, tamper);
    log(rc, 'copy-tampered', ledgerData(tamper), n);
    const rep = await import('../report/report-ru.mjs');
    todoProblems = [...reasons, ...tamperLinesRu(tamper, rep.loadPhrases(), rep.fill, { filesPath: r.copyTamper })];
  }
  const leftovers = cleanupRound(rc, n);
  writeTextAtomic(r.todo, renderTodo({ decision: 'INVALID_ROUND', gate: g, problems: todoProblems, clusters: loadClusters(rc), extra: { runDir: rc.runDir } }));
  log(rc, 'gate', { decision: 'INVALID_ROUND', gateSha256: hashJson(g), reasons }, n);
  move(rc, 'round-continue', { lastDecision: 'INVALID_ROUND', pendingJobs: [] }, 'round-close', { decision: 'INVALID_ROUND', leftovers }, n);
  return todoResult(rc, { decision: 'INVALID_ROUND', todoPath: r.todo, items: reasons, summary: 'the round did not count as a clean review', next: 'do not touch review copies; run step to repeat the round' });
}

/** A round that cannot reach the reviewers (planter/validator lost twice): stop inconclusive. */
async function closeWithoutReview(rc, n, decision, reasons, why) {
  const r = rp(rc, n);
  cleanupRound(rc, n);
  unstage(rc, n);
  const g = preGateRecord({ round: n, kind: rc.state.roundKind, versionHash: readRound(rc, n)?.versionHash ?? null, decision, reasons, history: historyBefore(rc, n), limits: rc.run.limits, best: rc.state.best, confirmsDone: rc.state.confirmsDone, roundsDone: workingRoundsCount(rc, n) });
  writeJsonAtomic(r.gate, { ...g, reasons: [...reasons, `reason: ${why}`] });
  saveRound(rc, n, { blocked: true });
  writeTextAtomic(r.todo, renderTodo({ decision, gate: g, problems: reasons, clusters: loadClusters(rc), extra: { runDir: rc.runDir } }));
  return stopRun(rc, decision, [...reasons, `reason: ${why}`], { round: n });
}

export { isOpenCluster, STOP_DECISIONS };
