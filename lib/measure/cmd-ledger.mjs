// `gauntlet ledger <stats | import-legacy | add-escape | verify-chain>` (SPEC 10.2, 14.7-14.9).

import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { writeJsonAtomic, writeTextAtomic } from '../core/fsx.mjs';
import { verifyChained } from '../core/chain.mjs';
import { dataPaths, chainedFiles } from '../core/datahome.mjs';
import { computeStats, renderStatsMd } from './recall.mjs';
import { importLegacy, DEFAULT_LEGACY_FILE } from './legacy.mjs';
import { appendEscape, ESCAPE_FOUND_BY } from './mledger.mjs';
import { formatEn } from './stats.mjs';
import { REPO_DIR } from '../core/config.mjs';

const USAGE = [
  'ledger stats [--md] [--instrument <id>] [--artifact-type <t>]',
  'ledger import-legacy [--file <path>]   (default: bench/legacy-2026-10.json)',
  `ledger add-escape --run <runId> --description <text> --severity blocker|major --lens <id|none> --owner-quote <the owner's words> --question <the exact question you asked the owner> [--found-by ${ESCAPE_FOUND_BY.join('|')}]`,
  'ledger verify-chain',
].join('\n  ');

/** Minimal option parser: --flag, --key value; repeated keys keep the last value. */
export function parseOptions(argv, { flags = [], values = [] } = {}) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (flags.includes(name)) {
      opts[name] = true;
      continue;
    }
    if (values.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      opts[name] = v;
      continue;
    }
    throw new UsageError(`unknown option --${name}`);
  }
  return { opts, rest };
}

function pathsFor(ctx) {
  return dataPaths(ctx?.dataHome);
}

function statsText(stats) {
  const lines = [];
  const ids = Object.keys(stats.instruments);
  if (!ids.length) lines.push('No measured runs yet: insufficient data (0 of 25).');
  for (const id of ids) {
    const b = stats.instruments[id];
    lines.push(`Instrument ${id}: runs ${b.runs}, canaries ${b.canaries}`);
    lines.push(`  own-lens recall: ${b.ownLensHeadline ?? formatEn(b.ownLens)}`);
    lines.push(`  panel recall:    ${formatEn(b.panel.all)}`);
    lines.push(`  omission recall: ${b.omission ? formatEn(b.omission) : 'no data'}`);
    lines.push(`  decoys rejected: ${formatEn(b.decoyRejection)}`);
    lines.push(`  true controls dismissed: ${formatEn(b.controlDismissed)}`);
  }
  if (stats.legacy.length) lines.push(`Legacy (contaminated) runs: ${stats.legacy.length}, shown only in STATS.md.`);
  return lines.join('\n');
}

export async function run(argv = [], ctx = {}) {
  const args = [...argv];
  if (args[0] === 'ledger') args.shift();
  const sub = args.shift();
  const dp = pathsFor(ctx);

  if (sub === 'stats') {
    const { opts } = parseOptions(args, { flags: ['md'], values: ['instrument', 'artifact-type'] });
    const stats = computeStats(dp, { instrumentId: opts.instrument ?? null, artifactType: opts['artifact-type'] ?? null });
    const md = renderStatsMd(stats);
    writeTextAtomic(dp.statsMd, md);
    writeJsonAtomic(dp.statsJson, stats);
    const text = (opts.md ? md : statsText(stats)) + `\nNEXT: read ${dp.statsMd}`;
    return { exitCode: 0, payload: { statsMd: dp.statsMd, statsJson: dp.statsJson, instruments: Object.keys(stats.instruments), legacy: stats.legacy.length }, text };
  }

  if (sub === 'import-legacy') {
    const { opts } = parseOptions(args, { values: ['file'] });
    const file = opts.file ? path.resolve(opts.file) : DEFAULT_LEGACY_FILE;
    const r = importLegacy(dp, file);
    return {
      exitCode: 0,
      payload: { file, ...r },
      text: `Imported legacy rows from ${file}: added ${r.added}, already present ${r.skipped}. All rows are marked contaminated.\nNEXT: node "${path.join(REPO_DIR, 'bin', 'gauntlet.mjs')}" ledger stats`,
    };
  }

  if (sub === 'add-escape') {
    const { opts } = parseOptions(args, { values: ['run', 'description', 'severity', 'lens', 'found-by', 'owner-quote', 'question'] });
    if (!opts.lens) throw new UsageError('add-escape: --lens <id|none> is required');
    // An escape enters the cross-run ledger only on the owner's recorded words (r2-f19).
    // The owner's words as said, even one word, together with the exact question they answer (appendEscape checks both).
    const line = appendEscape(dp, {
      runId: opts.run,
      description: opts.description,
      severity: opts.severity,
      lens: opts.lens,
      foundBy: opts['found-by'] ?? 'owner',
      ownerQuote: opts['owner-quote'],
      question: opts.question,
    });
    return {
      exitCode: 0,
      payload: { seq: line.seq, runId: line.runId, severity: line.severity, lens: line.lens, foundBy: line.foundBy },
      text: `Escape recorded for run ${line.runId} (${line.severity}).\nNEXT: nothing`,
    };
  }

  if (sub === 'verify-chain') {
    const results = chainedFiles(dp).map((file) => ({ file, ...verifyChained(file) }));
    const bad = results.filter((r) => !r.ok);
    const text =
      results.map((r) => `${r.ok ? 'ok    ' : 'BROKEN'} ${r.file} (${r.count} lines${r.ok ? '' : `, first broken line ${r.firstBrokenSeq}`})`).join('\n') +
      `\nNEXT: ${bad.length ? 'stop; a chained file was edited or truncated (TAMPER)' : 'nothing'}`;
    return { exitCode: bad.length ? 3 : 0, payload: { ok: bad.length === 0, files: results }, text };
  }

  throw new UsageError(`usage:\n  ${USAGE}`);
}
