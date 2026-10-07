// `gauntlet report <run> [--summary] [--comment <file>]` (SPEC 10.2, 16).
//
// Re-renders REPORT.ru.md and its copy <reportDir>/gauntlet-<runId>.ru.md from run
// files, logs a `report` event with the report's hash, and prints the summary lines.
// The audit is always run again first (never read from an old AUDIT.json): its result is in
// section 13 and in the summary, and the same audit result feeds both, so they cannot disagree.
// --summary prints the summary lines only and writes nothing (the audit runs without recording);
// when the report on disk is older than the last events of the run, the summary says so.
// --comment <file> stores the executor's own words as REPORT-COMMENT.md in the run
// folder; they are printed under «Комментарий исполнителя», never elsewhere.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { readText, writeTextAtomic, readJson } from '../core/fsx.mjs';
import { sha256Hex } from '../core/hash.mjs';
import { dataPaths } from '../core/datahome.mjs';
import { runPaths, recordEvent, verifyRunIntegrity, runIdOf, withLock } from '../core/runstore.mjs';
import { audit } from '../engine/audit.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { buildReport, summaryLines, COMMENT_MAX_CHARS } from './report-ru.mjs';
import { lintReportText } from './report-lint.mjs';
import { benchResult, loadBenchRule } from './bench.mjs';

function parse(argv) {
  const out = { runDir: null, summary: false, comment: null, bench: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--summary') out.summary = true;
    else if (a === '--bench') {
      out.bench = argv[++i];
      if (!out.bench) throw new UsageError('--bench needs the pass-rule file (bench/*.pass.json)');
    } else if (a === '--comment') {
      out.comment = argv[++i];
      if (!out.comment) throw new UsageError('--comment needs a file');
    } else if (a.startsWith('--comment=')) out.comment = a.slice('--comment='.length);
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (!out.runDir) out.runDir = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!out.runDir) throw new UsageError('usage: report <run> [--summary] [--comment <file>] [--bench <pass-rule file>]');
  return out;
}

/** Path of the owner's copy of the report, or null when the run has no reportDir. */
export function reportCopyPath(runDir) {
  const P = runPaths(runDir);
  let run = {};
  try {
    run = readJson(P.runJson);
  } catch {
    run = {};
  }
  if (!run.reportDir) return null;
  return path.join(run.reportDir, `gauntlet-${run.runId ?? runIdOf(runDir)}.ru.md`);
}

/** Render, write and log the report; returns { reportPath, copyPath, sha256, summaryRu }. */
export function writeReport(runDir, { dp, audit = null } = {}) {
  const P = runPaths(runDir);
  const md = buildReport(runDir, { dataPaths: dp, audit });
  writeTextAtomic(P.report, md);
  const copyPath = reportCopyPath(runDir);
  if (copyPath) writeTextAtomic(copyPath, md);
  const sha256 = sha256Hex(md);
  // The numbers come from the audit that was run for this very report (read afresh from the run files), so the
  // next audit compares the report with the same figures the report was built from.
  const numbers = audit?.reportNumbers ?? null;
  recordEvent(runDir, 'report', { sha256, path: P.report, copy: copyPath, ...(numbers ? { numbers } : {}) }, null, { dataPaths: dp });
  return { reportPath: P.report, copyPath, sha256, summaryRu: summaryLines(runDir, { audit, dataPaths: dp }) };
}

export async function run(argv = [], ctx = {}) {
  const args = [...argv];
  if (args[0] === 'report') args.shift();
  const o = parse(args);
  const runDir = normalizeInput(o.runDir);
  const P = runPaths(runDir);
  if (!fs.existsSync(P.runJson)) throw new UsageError(`not a run folder (no run.json): ${runDir}`);
  const dp = dataPaths(ctx.dataHome);
  verifyRunIntegrity(runDir, { dataPaths: dp });

  if (o.bench) {
    // The bench verdict is computed here, never judged by the window (r2-f29).
    const b = benchResult(runDir, loadBenchRule(normalizeInput(o.bench)));
    return { exitCode: 0, payload: { bench: { pass: b.pass, round: b.round, rows: b.rows, falseOpen: b.falseOpen, pairs: b.pairs }, linesRu: b.lines }, text: b.lines.join('\n') + '\nNEXT: show these lines to the owner as printed' };
  }

  if (o.summary) {
    const a = audit(runDir, ctx, { automatic: true, record: false });
    const lines = summaryLines(runDir, { audit: a, dataPaths: dp });
    return { exitCode: 0, payload: { summaryRu: lines, reportPath: P.report }, text: lines.join('\n') + '\nNEXT: show these lines and the report path to the owner' };
  }

  if (o.comment) {
    const text = readText(normalizeInput(o.comment));
    if (!text.trim()) throw new UsageError('--comment file is empty');
    // The executor's own words reach the owner's report: the same words are refused there as in the
    // generated text («панель поставила 9,5», a bare "x,y из 10"), quotes included, and the length is capped.
    if (text.length > COMMENT_MAX_CHARS) throw new UsageError(`--comment is longer than ${COMMENT_MAX_CHARS} characters`);
    const hits = lintReportText(text, { includeQuotes: true });
    if (hits.length) throw new UsageError('--comment carries words the owner report never shows (a score or a panel verdict): ' + hits.map((h) => `line ${h.line}: "${h.text}"`).join('; '));
    writeTextAtomic(path.join(P.dir, 'REPORT-COMMENT.md'), text);
  }
  const r = await withLock(runDir, async () => {
    const a = audit(runDir, ctx, { automatic: true, rebuildingReport: true });
    return writeReport(runDir, { dp, audit: a });
  });
  const text = [...r.summaryRu, `Report written: ${r.reportPath}${r.copyPath ? ` (copy: ${r.copyPath})` : ''}`, 'NEXT: show the lines above and the report path to the owner'].join('\n');
  return { exitCode: 0, payload: { reportPath: r.reportPath, copyPath: r.copyPath, sha256: r.sha256, summaryRu: r.summaryRu }, text };
}
