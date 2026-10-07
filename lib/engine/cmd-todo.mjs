// `todo <run>` and the executor's to-do renderer (SPEC 13.6).
//
// The to-do is English and built from gate.json + clusters.json only. It contains NO scores, no
// bands, no canary information, no per-reviewer counts and no lens attribution: the executor
// learns what to fix, never how the panel is measured.

import path from 'node:path';
import { REPO_DIR } from '../core/config.mjs';
import { readText, exists } from '../core/fsx.mjs';
import { openRun, roundNumbers } from './state.mjs';

const SERIOUS = ['blocker', 'major'];

// Words that would leak how the check is measured; reviewer/verifier text is redacted with them.
const LEAK_RE = /\b(canar(?:y|ies)|planted|attention[- ]check|score[sd]?|rating|band)\b|подлож\p{L}*|оценк\p{L}*/giu;

function clean(s, max = 600) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().replace(LEAK_RE, '[…]');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function where(c) {
  return c.file ? `${c.file}${c.locator ? ` — ${c.locator}` : ''}` : c.locator || 'the whole work';
}

function clusterBlock(c) {
  const lines = [`### ${c.id} — ${c.severity || c.claimedSeverity || 'unclassified'}`, `- Where: ${clean(where(c), 300)}`];
  if (c.quote) lines.push(`- Text: "${clean(c.quote, 400)}"`);
  else if (c.missingWhat) lines.push(`- Missing: ${clean(c.missingWhat, 400)}`);
  lines.push(`- Problem: ${clean(c.problem)}`);
  if (c.fix) lines.push(`- Suggested fix: ${clean(c.fix)}`);
  const ev = (c.evidence || []).filter((e) => e.verdict === 'confirmed').slice(-1)[0];
  if (ev && ev.evidence) lines.push(`- Checker's evidence: ${clean(ev.evidence)}`);
  return lines.join('\n');
}

const DECISION_TEXT = {
  FIX: 'Fix the open problems below, then run step. Fix only what is listed; do not edit anything else.',
  CONFIRM: 'The material is clean in this round. Change NOTHING. Run step to start the confirm round on the same version.',
  DONE: 'Two clean rounds in a row on the same version. Change nothing; run done.',
  STOP_PLATEAU: 'Stopped: the number of open problems stopped going down. The owner decides how to continue.',
  STOP_LIMIT: 'Stopped: a limit (rounds, confirm rounds or tokens) was reached. The owner decides.',
  STOP_INCONCLUSIVE: 'Stopped: the check could not reach a reliable result. The owner decides.',
  STOP_OWNER: 'Stopped on the owner\'s word.',
  INVALID_ROUND: 'This round did not count: the review copy changed while it was being read. Do not touch review copies; run step to repeat the round.',
  BLOCKED_PRECHECK: 'Not a round: mechanical checks failed before any agent ran. Fix them, then run step.',
  BLOCKED_TRACE: 'Not a round: the review copy carries review traces or a strip rule failed. Remove a real leftover of a review by hand; NEVER rewrite, reword or hide material values to pass the scan (and never split words to evade it): if a flagged text is an ordinary word or value of the work, ask the owner the question at the end of the list below and add a traceAllow entry only on the owner\'s word. Then run step.',
};

/**
 * renderTodo({ decision, gate, clusters, problems?, extra? }) -> markdown (English)
 * extra: { precheck, incidental, notVerified, sourcesUnavailable, unlistedRecent, runDir }
 */
export function renderTodo({ decision, gate, clusters = [], problems = [], extra = {} }) {
  const lines = [];
  lines.push(`# To-do — round ${gate?.round ?? '?'}`);
  lines.push('');
  lines.push(`Decision: ${decision}`);
  lines.push('');
  lines.push(DECISION_TEXT[decision] || '');
  if (problems.length) {
    lines.push('');
    lines.push('## What blocks the round');
    lines.push('');
    for (const p of problems) lines.push(`- ${clean(p, 800)}`);
  }
  const live = clusters.filter((c) => !c.waived && c.status !== 'waived');
  const open = live.filter((c) => c.status === 'open' && SERIOUS.includes(c.severity));
  const questions = live.filter((c) => (c.status === 'unverified' || c.status === 'contested') && SERIOUS.includes(c.severity));
  const reqs = open.filter((c) => c.origin === 'requirement');
  const openFindings = open.filter((c) => c.origin !== 'requirement');
  const cosmetic = live.filter((c) => c.status === 'cosmetic' || ((c.status === 'open' || c.status === 'unverified' || c.status === 'contested') && c.severity === 'cosmetic'));

  if (openFindings.length) {
    lines.push('');
    lines.push('## Open problems (verified)');
    lines.push('');
    for (const c of openFindings) {
      lines.push(clusterBlock(c));
      lines.push('');
    }
  }
  if (reqs.length) {
    lines.push('');
    lines.push('## Requirements of the task that are not met (verified)');
    lines.push('');
    for (const c of reqs) {
      lines.push(clusterBlock(c));
      lines.push('');
    }
  }
  if (questions.length) {
    lines.push('');
    lines.push('## Questions: unverified or contested problems');
    lines.push('');
    lines.push('Fix them, or answer with evidence (dispute), or take them to the owner. They stay open until a checker or the owner settles them.');
    lines.push('');
    for (const c of questions) {
      lines.push(clusterBlock(c) + `\n- Status: ${c.status}`);
      lines.push('');
    }
  }
  const mech = (extra.precheck || []).filter((m) => !m.ok && m.severity === 'cosmetic');
  if (mech.length) {
    lines.push('');
    lines.push('## Mechanical checks (cosmetic) that failed');
    lines.push('');
    for (const m of mech) lines.push(`- ${m.id}: ${clean(m.what)} ${clean((m.details || []).slice(0, 3).join(' | '))}`);
  }
  if ((extra.incidental || []).length) {
    lines.push('');
    lines.push('## Noticed while preparing the round, not verified');
    lines.push('');
    for (const i of extra.incidental) lines.push(`- ${clean(i.file)} ${clean(i.locator)}: ${clean(i.note)}`);
  }
  if ((extra.sourcesUnavailable || []).length) {
    lines.push('');
    lines.push('## Primary sources the reviewers could not reach');
    lines.push('');
    lines.push('Reviewers tried these sources and documented the attempts. A claim that only such a source could settle is neither a finding nor a pass: it stays unverified. The lens itself stays valid.');
    lines.push('');
    for (const u of extra.sourcesUnavailable) {
      lines.push(`- Source ${u.sourceId} was ${u.state === 'unavailable' ? 'unavailable' : 'only partly available'} to reviewers in round ${gate?.round ?? '?'} (${u.unavailable} of ${u.attempts} documented attempt(s) failed): ${clean(u.excerpt, 200)}${u.suspicious ? ' Note: the check at the start of the round read this source without trouble, so look at why the reviewers could not.' : ''}`);
    }
  }
  if ((extra.notVerified || []).length) {
    lines.push('');
    lines.push('## Could not be confirmed — not findings');
    lines.push('');
    for (const v of extra.notVerified.slice(0, 50)) lines.push(`- ${clean(v.claim)} (looked: ${clean(v.whereLooked, 200)})`);
  }
  if (cosmetic.length) {
    lines.push('');
    lines.push('## Cosmetic (optional)');
    lines.push('');
    for (const c of cosmetic) lines.push(`- ${c.id}: ${clean(where(c), 200)} — ${clean(c.problem, 300)}`);
  }
  if ((extra.unlistedRecent || []).length) {
    lines.push('');
    lines.push('## Warning: recently changed files outside the material');
    lines.push('');
    lines.push('These files changed in the last 24 hours inside a material folder but are excluded by the globs, so nobody reviewed them:');
    for (const f of extra.unlistedRecent.slice(0, 50)) lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('## Commands');
  lines.push('');
  const run = extra.runDir ? `"${extra.runDir}"` : '<run>';
  // The CLI is not on PATH (the installer does no npm link): print the full command.
  const PL = `node "${path.join(REPO_DIR, 'bin', 'gauntlet.mjs')}"`;
  if (decision === 'FIX' || decision === 'STOP_PLATEAU' || decision === 'STOP_LIMIT' || decision === 'STOP_INCONCLUSIVE') {
    lines.push(`- Dispute a problem with evidence: ${PL} dispute ${run} --cluster <id> --argument "<why>" --evidence-cmd <exe> --evidence-arg <arg> (or --evidence-quote <file>::<quote>)`);
  }
  lines.push(`- Continue: ${PL} step ${run}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** The latest to-do file of the run: the last round with todo.md. */
export function latestTodo(rc) {
  for (const n of [...roundNumbers(rc)].reverse()) {
    const p = rc.paths.roundDir(n).todo;
    if (exists(p)) return p;
  }
  return null;
}

export async function run(argv, ctx) {
  const runDir = argv.find((a) => !a.startsWith('--'));
  const rc = openRun(runDir, ctx, { command: 'todo' });
  const p = latestTodo(rc);
  if (!p) {
    return { exitCode: 0, state: rc.state.state, payload: { todoPath: null }, text: 'No to-do yet.\nNEXT: run step' };
  }
  const text = readText(p);
  return { exitCode: 0, state: rc.state.state, payload: { todoPath: p, todo: text }, text: text + `\nNEXT: act on the to-do, then run step (${path.basename(path.dirname(p))})` };
}
