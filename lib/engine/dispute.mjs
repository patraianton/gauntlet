// Executor disputes (SPEC 9.14, 10.2 `dispute`, 12.6).
//
// The executor can never change a status or class. A dispute is a request, with evidence, that two
// fresh dispute verifiers weigh independently in the next round. A cluster is closed only when BOTH
// answer `withdrawn`, and lowered only when both lower it (to the higher of their two classes);
// any `upheld` keeps it as it is, like the two-verifier rule for refuting a blocker (D15). A dispute
// without evidence, or with a quote that code cannot find in the live material, is refused (exit 4).
// The argument, the evidence command's arguments and its output are prompt-linted ("deliberate",
// "already fixed", "out of scope", ... are refused) because all of them are shown to an agent.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { readText, writeJsonAtomic, exists } from '../core/fsx.mjs';
import { runAllowed } from '../core/proc.mjs';
import { now } from '../core/clock.mjs';
import { loadPatterns, lintValues, normalizeQuote } from '../material/lint.mjs';
import { log, readJsonIf } from './state.mjs';
import { OPEN_SET } from './verify.mjs';

export const ARGUMENT_MAX = 1500;
export const EVIDENCE_TIMEOUT_S = 60;
export const OUTPUT_MAX = 6000;

export function loadDisputes(rc) {
  return readJsonIf(rc.paths.disputes, { schemaVersion: 1, disputes: [] });
}

export function saveDisputes(rc, d) {
  writeJsonAtomic(rc.paths.disputes, { schemaVersion: 1, disputes: d.disputes });
}

export function pendingDisputes(rc) {
  return loadDisputes(rc).disputes.filter((d) => d.status === 'pending');
}

/** Live material file for a material-relative path "<as>/<rest>", or null. */
export function liveFile(run, rel) {
  const r = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  const [as, ...rest] = r.split('/');
  const root = (run.material?.roots || []).find((x) => x.as === as);
  if (!root || rest.length === 0 || rest.includes('..')) return null;
  return path.join(root.path, ...rest);
}

/**
 * addDispute(rc, { cluster, argument, evidenceCmd?, evidenceArgs?, evidenceQuote? }) -> dispute
 * evidenceQuote: "<rel>::<quote>".
 */
export function addDispute(rc, opts) {
  const { cluster, argument } = opts;
  if (!cluster) throw new UsageError('--cluster is required');
  if (!argument || !String(argument).trim()) throw new UsageError('--argument is required');
  if (String(argument).length > ARGUMENT_MAX) throw new UsageError(`--argument is longer than ${ARGUMENT_MAX} characters`);
  const clusters = readJsonIf(rc.paths.clusters, { clusters: [] }).clusters || [];
  const c = clusters.find((x) => x.id === cluster);
  if (!c) throw new UsageError(`no cluster ${cluster}`);
  if (!OPEN_SET.includes(c.status)) throw new UsageError(`cluster ${cluster} is ${c.status}; only open, unverified or contested clusters can be disputed`);
  const hits = lintValues({ argument }, loadPatterns('prompt'));
  if (hits.length) {
    throw new UsageError(
      'the argument contains words that may not reach a checker (' + hits.map((h) => `"${h.text}"`).join(', ') + '). Argue with evidence, not with intent or scope.',
    );
  }
  let evidence;
  if (opts.evidenceCmd) {
    const args = opts.evidenceArgs || [];
    const argHits = lintValues({ args }, loadPatterns('prompt', { controlOnly: true }));
    if (argHits.length) throw new UsageError('the evidence command carries words that may not reach a checker (' + argHits.map((h) => `"${h.text}"`).join(', ') + ').');
    const res = runAllowed({ cmd: opts.evidenceCmd, args, cwd: rc.run.projectDir && exists(rc.run.projectDir) ? rc.run.projectDir : undefined, timeoutS: EVIDENCE_TIMEOUT_S, allow: rc.run.allowExecutables });
    const output = `exit ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}\n${String(res.stdout || '').slice(0, OUTPUT_MAX)}${res.stderr ? `\n[stderr]\n${String(res.stderr).slice(0, 1000)}` : ''}`;
    // The output goes into the dispute verifier's prompt: the same words are refused there as in the
    // argument (a "node -e" that prints "this is deliberate" is not evidence).
    const outHits = lintValues({ output }, loadPatterns('prompt', { controlOnly: true }));
    if (outHits.length) throw new UsageError('the evidence output carries words that may not reach a checker (' + outHits.map((h) => `"${h.text}"`).join(', ') + '). Use evidence that shows data, not intent or scope.');
    evidence = { kind: 'command', cmd: opts.evidenceCmd, args, output };
  } else if (opts.evidenceQuote) {
    const s = String(opts.evidenceQuote);
    const i = s.indexOf('::');
    if (i <= 0) throw new UsageError('--evidence-quote must be <file>::<quote>, the file as listed in the material (e.g. content/page.md)');
    const rel = s.slice(0, i).trim();
    const quote = s.slice(i + 2);
    const abs = liveFile(rc.run, rel);
    if (!abs || !exists(abs)) throw new UsageError(`the evidence file ${rel} is not part of the material`);
    const text = normalizeQuote(readText(abs));
    const q = normalizeQuote(quote);
    const quoteFound = q.length >= 4 && text.includes(q);
    if (!quoteFound) throw new UsageError(`the quoted evidence was not found in ${rel}; copy it exactly`);
    evidence = { kind: 'quote', file: rel, quote, quoteFound: true };
  } else {
    throw new UsageError('a dispute needs evidence: --evidence-cmd <exe> [--evidence-arg <a>]... or --evidence-quote <file>::<quote>');
  }
  const d = loadDisputes(rc);
  const id = `D${d.disputes.length + 1}`;
  const entry = { id, cluster, createdRound: rc.state.round ?? null, createdAt: now(), argument: String(argument), evidence, status: 'pending' };
  d.disputes.push(entry);
  saveDisputes(rc, d);
  log(rc, 'dispute-add', { id, cluster, evidenceKind: evidence.kind }, rc.state.round ?? null);
  return entry;
}

/** DISPUTES value for the dispute-verifier template. */
export function renderDisputes(disputes, clusters, copyDir) {
  return disputes
    .map((d) => {
      const c = clusters.find((x) => x.id === d.cluster) || {};
      const lines = [
        `### ${d.id}`,
        `- File: ${c.file ? `${c.file} (${path.join(copyDir, ...String(c.file).split('/'))})` : 'the whole work'}`,
        `- Place: ${c.locator || '(not given)'}`,
        c.quote ? `- Text: ${JSON.stringify(c.quote)}` : `- Missing: ${c.missingWhat || c.problem || ''}`,
        `- Problem: ${String(c.problem || '').slice(0, 600)}`,
        `- Class: ${c.severity || c.claimedSeverity || 'unknown'}`,
        `- Author's argument: ${d.argument}`,
      ];
      if (d.evidence?.kind === 'command') {
        lines.push(`- Evidence: the command \`${[d.evidence.cmd, ...(d.evidence.args || [])].join(' ')}\` printed:`);
        lines.push('```');
        lines.push(String(d.evidence.output || '').slice(0, 4000));
        lines.push('```');
      } else if (d.evidence?.kind === 'quote') {
        lines.push(`- Evidence: quote from ${d.evidence.file}: ${JSON.stringify(d.evidence.quote)}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/** The disputes job = all pending disputes (D1..Dm by their run ids). */
export function buildDisputeJob(rc) {
  return pendingDisputes(rc);
}

const RANK = { cosmetic: 1, major: 2, blocker: 3 };

/**
 * Combine the two dispute verifiers' answers on one dispute (the outcome least favourable to the
 * executor wins). -> { outcome, severity, why } or null when either answer is missing.
 */
export function combineDisputeAnswers(a, b) {
  if (!a || !b) return null;
  if (a.outcome === 'upheld' || b.outcome === 'upheld') return { outcome: 'upheld', severity: null, why: [a.why, b.why].filter(Boolean).join(' | ') };
  if (a.outcome === 'withdrawn' && b.outcome === 'withdrawn') return { outcome: 'withdrawn', severity: null, why: [a.why, b.why].filter(Boolean).join(' | ') };
  // at least one reclassified, none upheld: the higher class of the reclassifications
  const sev = [a, b].filter((x) => x.outcome === 'reclassified' && x.severity).map((x) => x.severity).sort((x, y) => RANK[y] - RANK[x])[0] || null;
  if (!sev) return { outcome: 'upheld', severity: null, why: 'no class given' };
  return { outcome: 'reclassified', severity: sev, why: [a.why, b.why].filter(Boolean).join(' | ') };
}

/**
 * applyDisputeAnswer(rc, round, disputeIds, answerLists, clusters, versionHash) -> { clusters, disputes }
 * answerLists: the items of the two dispute verifiers ([items1|null, items2|null]); an older single
 * list counts as one verifier only and can never close or lower a cluster on its own.
 * A missing answer leaves the dispute pending (it goes to the next round's dispute verifiers).
 */
export function applyDisputeAnswer(rc, round, disputeIds, answerLists, clusters, versionHash) {
  const d = loadDisputes(rc);
  let out = [...clusters];
  const lists = Array.isArray(answerLists) && (answerLists.length === 0 || Array.isArray(answerLists[0]) || answerLists[0] === null) ? answerLists : [answerLists, null];
  for (const id of disputeIds || []) {
    const disp = d.disputes.find((x) => x.id === id);
    if (!disp || disp.status !== 'pending') continue;
    const a = combineDisputeAnswers((lists[0] || []).find((x) => x.item === id), (lists[1] || []).find((x) => x.item === id));
    if (!a) continue;
    disp.status = a.outcome;
    disp.resolvedRound = round;
    disp.why = a.why ?? null;
    out = out.map((c) => {
      if (c.id !== disp.cluster) return c;
      if (!OPEN_SET.includes(c.status)) return c;
      if (a.outcome === 'withdrawn') {
        return { ...c, status: 'closed', verifiedOn: versionHash, history: [...(c.history || []), { round, from: c.status, to: 'closed', why: `dispute ${id} withdrawn by both dispute verifiers` }] };
      }
      if (a.outcome === 'reclassified' && a.severity) {
        const to = a.severity === 'cosmetic' ? 'cosmetic' : 'open';
        return { ...c, status: to, severity: a.severity, verifiedOn: versionHash, history: [...(c.history || []), { round, from: c.status, to, why: `dispute ${id} reclassified to ${a.severity}` }] };
      }
      return { ...c, history: [...(c.history || []), { round, from: c.status, to: c.status, why: `dispute ${id} upheld` }] };
    });
    log(rc, 'dispute-ingested', { id, cluster: disp.cluster, outcome: a.outcome, severity: a.severity ?? null }, round);
  }
  saveDisputes(rc, d);
  return { clusters: out, disputes: d.disputes };
}


