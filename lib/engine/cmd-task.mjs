// `task set <run> --from <file> [--cut <n,n-m,...>] [--source "<who, date, where>"] [--owner-quote <text> --question <text>]` (SPEC 9.2, D18).
//
// OWNER-TASK.md = the owner's words verbatim (BOM stripped, LF) + a final "Source: ..." line; it is
// never rendered to any agent. TASK.md = the same lines minus the cut line numbers. TASK.md must
// pass the prompt lint for loop-control constructs only (thresholds, "until the panel says",
// "deliberate", ...; product words such as «оценка стоимости» stay). A hit lists the offending lines
// so the executor can cut pure loop-control lines. A cut line that is not loop control (the lint
// does not flag it on its own) is an owner requirement: cutting it needs --owner-quote. Allowed until freeze.

import fs from 'node:fs';
import { ownerWords } from '../core/owner.mjs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { readText, writeTextAtomic, exists } from '../core/fsx.mjs';
import { sha256Hex } from '../core/hash.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { loadPatterns, lintText } from '../material/lint.mjs';
import { parseArgv, openRun, log, commitState, textLines } from './state.mjs';
import { setupJobs } from './ingest.mjs';
import { safeRemove } from '../core/fsx.mjs';

/** "3,5-7" -> Set {3,5,6,7} (1-based). */
export function parseCut(s, max) {
  const out = new Set();
  if (!s) return out;
  for (const part of String(s).split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(t);
    if (!m) throw new UsageError(`bad --cut entry "${t}" (use numbers like 3,5-7)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > max) throw new UsageError(`--cut ${t} is outside lines 1..${max}`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}

/** Words of 3+ letters a loop-control clause may keep besides its matched spans ("Keep going ... gives"). */
export const CONTROL_CLAUSE_MAX_WORDS = 4;

/**
 * Is a whole owner line pure loop control (r3-f5)? The line is split into clauses at , ; : . ! ? that
 * end a word (so "9,5" stays whole) and at spaced dashes; every clause that carries words must carry a
 * loop-control hit, and after the matched spans are removed it may keep at most
 * CONTROL_CLAUSE_MAX_WORDS words of three or more letters. A line that also states a requirement
 * ("The plan must include a budget table, iterate until the panel gives 9.5") is therefore NOT
 * control: cutting it needs the owner's words.
 */
export function isControlLine(line, control) {
  if (String(line).trim() === '') return true;
  const words = (x) => (x.match(/\p{L}{3,}/gu) || []).length;
  const clauses = String(line)
    .split(/[,;:.!?]+(?=\s|$)|\s[—–-]\s/u)
    .map((c) => c.trim())
    .filter((c) => /\p{L}/u.test(c));
  let anyHit = false;
  for (const c of clauses) {
    const hits = lintText(`${c}\n`, control);
    if (!hits.length) {
      if (words(c) >= 2) return false;
      continue;
    }
    anyHit = true;
    let rest = c;
    for (const h of hits) rest = rest.split(h.text).join(' ');
    if (words(rest) > CONTROL_CLAUSE_MAX_WORDS) return false;
  }
  return anyHit;
}

/** Build both texts and lint TASK.md. -> { ownerText, taskText, cut: [{ line, text }], hits } */
export function buildTask(text, { cut, source }) {
  const lines = textLines(String(text).replace(/^﻿/, ''));
  const cutSet = parseCut(cut, lines.length);
  const kept = [];
  const cutLines = [];
  const control = loadPatterns('prompt', { controlOnly: true });
  lines.forEach((l, i) => {
    // A cut line is "control" only when the whole line is loop control (isControlLine). Any other
    // non-empty cut removes an owner requirement, mixed lines included: it needs the owner's words
    // (run() refuses it without --owner-quote) and the report says so.
    if (cutSet.has(i + 1)) cutLines.push({ line: i + 1, text: l, control: isControlLine(l, control) });
    else kept.push(l);
  });
  const ownerText = [...lines, `Source: ${source || 'not given'}`].join('\n') + '\n';
  const taskText = kept.join('\n') + '\n';
  // The owner's words are checked for loop-control constructs only: product words such as
  // «оценка стоимости» or "average price" stay in the task (they are requirements, not loop control).
  const hits = lintText(taskText, loadPatterns('prompt', { controlOnly: true }));
  // Map TASK.md line numbers back to owner line numbers for the message.
  const keptNumbers = lines.map((_, i) => i + 1).filter((n) => !cutSet.has(n));
  const mapped = hits.map((h) => ({ ...h, ownerLine: keptNumbers[h.line - 1] ?? null }));
  return { ownerText, taskText, cut: cutLines, hits: mapped };
}

export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  if (sub !== 'set') throw new UsageError('usage: task set <run> --from <file> [--cut <list>] [--source <text>] [--owner-quote <text> --question <text>]');
  const { positional, opts } = parseArgv(rest, { options: ['from', 'cut', 'source', 'owner-quote', 'question'] });
  // The question is required below, where the words are actually recorded (cut lines that state a requirement).
  const words = ownerWords(opts.ownerQuote, opts.question, { required: false, questionRequired: false });
  const quote = words?.quote ?? null;
  const runDir = positional[0];
  if (!opts.from) throw new UsageError('--from <file> is required');
  return withLock(normalizeInput(runDir), async () => {
    const rc = openRun(runDir, ctx, { states: ['NEW', 'AWAIT_LENS_WRITER'], command: 'task set' });
    const file = normalizeInput(opts.from);
    if (!exists(file)) throw new UsageError(`no such file: ${file}`);
    const built = buildTask(readText(file), { cut: opts.cut, source: opts.source });
    if (built.hits.length) {
      const list = built.hits.map((h) => `line ${h.ownerLine}: "${h.text}" (${h.patternId})`).join('\n  ');
      throw new UsageError(
        `TASK.md would carry loop-control text that no reviewer may see (a threshold, "until the panel says", "do not flag", ...):\n  ${list}\nIf a line only controls the loop, cut it with --cut (it stays in OWNER-TASK.md and the report lists it). If it also states a requirement, do not cut it: ask the owner to say it again without the loop-control part.`,
        { hits: built.hits },
      );
    }
    const requirementCuts = built.cut.filter((c) => !c.control);
    if (requirementCuts.length && !quote) {
      throw new UsageError(
        `only loop-control lines may be cut without the owner's words; these cut lines state no loop control (they are requirements):\n  ${requirementCuts.map((c) => `line ${c.line}: ${c.text}`).join('\n  ')}\nKeep them, or cut them with --owner-quote "<the owner's words>" --question "<the exact question you asked him>" (the report shows the lines, the words and the question).`,
        { cut: requirementCuts },
      );
    }
    if (requirementCuts.length) ownerWords(opts.ownerQuote, opts.question);
    writeTextAtomic(rc.paths.ownerTask, built.ownerText);
    writeTextAtomic(rc.paths.task, built.taskText);
    const data = {
      ownerTaskSha256: sha256Hex(fs.readFileSync(rc.paths.ownerTask)),
      taskSha256: sha256Hex(fs.readFileSync(rc.paths.task)),
      cut: built.cut,
      source: opts.source || null,
      ownerQuote: requirementCuts.length ? quote : null,
      ownerQuestion: requirementCuts.length ? words?.question ?? null : null,
    };
    if (rc.state.state === 'AWAIT_LENS_WRITER') {
      // The lens writer was briefed with the old task: withdraw it.
      for (const j of setupJobs(rc)) if (j.dir) safeRemove(j.dir);
      commitState(rc, { state: 'NEW', pendingJobs: [] }, 'task-set', data);
    } else {
      log(rc, 'task-set', data);
    }
    const text = [
      `OWNER-TASK.md and TASK.md written (${built.cut.length} line(s) cut).`,
      ...built.cut.map((c) => `  cut line ${c.line}: ${c.text}`),
      '',
      'NEXT: write sources.json, strip.json, mechanical.json, then run step',
    ].join('\n');
    return { exitCode: 0, state: rc.state.state, payload: { state: rc.state.state, cut: built.cut, taskPath: rc.paths.task }, text };
  });
}


