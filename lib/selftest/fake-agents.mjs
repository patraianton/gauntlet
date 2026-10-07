// Fake agents for the offline selftest and the engine tests (SPEC 21.3). No LLM.
//
// The harness is PRIVILEGED: it reads the run's jobs.json, slots, the sealed canary key and the
// verifier item map — files real agents never see — to write scripted answers into each job folder.
// Real agents get only the one-line call and the prompt it points to.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, readText, exists } from '../core/fsx.mjs';
import { dataPaths as defaultDataPaths } from '../core/datahome.mjs';
import { positionIndex } from '../material/manifest.mjs';
import { phasePathOf } from '../engine/stage.mjs';
import { normalizeQuote } from '../material/lint.mjs';
import { loadTaxonomy } from '../measure/taxonomy.mjs';
import { runPaths } from '../core/runstore.mjs';
import { callFor } from '../material/jobs.mjs';

function jsonIf(p, d = null) {
  try {
    return exists(p) ? readJson(p) : d;
  } catch {
    return d;
  }
}

/** Find a job record (round jobs.json or setup/lens-writer-n/job.json). */
export function findJob(runDir, job) {
  const p = runPaths(runDir);
  const st = jsonIf(p.state, {});
  if (st.round) {
    const jobs = jsonIf(p.roundDir(st.round).jobs, { jobs: [] }).jobs;
    const j = jobs.find((x) => x.job === job);
    if (j) return { ...j, round: st.round };
  }
  if (exists(p.setupDir)) {
    for (const d of fs.readdirSync(p.setupDir)) {
      const j = jsonIf(path.join(p.setupDir, d, 'job.json'), null);
      if (j && j.job === job) return { ...j, round: null };
    }
  }
  return null;
}

function pick(table, round, lens, attempt) {
  const r = table?.[String(round)] || {};
  const l = r[lens] || r['*'] || {};
  return l[String(attempt)] || l['*'] || null;
}

function fillString(s, vars) {
  return String(s).replace(/\{\{(nonce|receipt:Q\d+|canary:S\d+)\}\}/g, (m, k) => {
    if (k === 'nonce') return vars.nonce;
    if (k.startsWith('receipt:')) return String(vars.receipts[k.slice(8)] ?? '');
    if (k.startsWith('canary:')) {
      const c = (vars.key?.canaries || []).find((x) => x.slot === k.slice(7));
      return c ? String(c.after).trim() : '';
    }
    return m;
  });
}

function fillDeep(v, vars) {
  if (typeof v === 'string') return fillString(v, vars);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = fillDeep(x, vars);
    return out;
  }
  return v;
}

function lineOf(copyDir, rel, n) {
  const text = readText(path.join(copyDir, ...rel.split('/')));
  const lines = text.split(/\r?\n/);
  return lines[n - 1] ?? '';
}

function receiptAnswers(rec, copyDir) {
  const out = {};
  for (const c of rec.challenges || []) {
    if (c.kind === 'line') out[c.id] = lineOf(copyDir, c.file, c.line);
    else out[c.id] = String(c.expected);
  }
  return out;
}

function sealedKey(runDir, round, dp) {
  const runId = jsonIf(runPaths(runDir).runJson, {}).runId;
  const p = dp.sealedKey(runId, String(round).padStart(2, '0'));
  const k = jsonIf(p, null);
  if (k) return k;
  return jsonIf(runPaths(runDir).roundDir(round).canaries, null);
}

/** A finding that reports a planted error (privileged: built from the key). */
export function canaryFinding(c, taxonomy) {
  const type = taxonomy.byId(c.type);
  const before = String(c.before);
  const after = String(c.after);
  if (type?.omission) {
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    let s = 0;
    while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
    const removed = before.slice(p, before.length - s).replace(/\s+/g, ' ').trim();
    return {
      severity: 'blocker',
      kind: 'omission',
      location: { file: c.file, locator: c.locator || 'место' },
      quote: null,
      missingWhat: `Нужный фрагмент отсутствует: «${removed}»`,
      problem: `Пропал нужный фрагмент: «${removed}».`,
      fix: 'Вернуть пропавший фрагмент.',
    };
  }
  const tok = (x) => new Set((normalizeQuote(x).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
  const tb = tok(before);
  const ta = tok(after);
  const now = [...ta].filter((t) => !tb.has(t));
  const was = [...tb].filter((t) => !ta.has(t));
  return {
    severity: 'blocker',
    kind: 'fact',
    location: { file: c.file, locator: c.locator || 'место' },
    quote: after.trim(),
    problem: `Здесь стоит «${now.join(' ')}», а должно быть «${was.join(' ')}»: это расходится с остальной работой.`,
    fix: `Вернуть «${was.join(' ')}».`,
  };
}

function reviewerAnswer(rec, ctx) {
  const { runDir, script, dp } = ctx;
  const round = rec.round;
  const roundJson = jsonIf(runPaths(runDir).roundDir(round).roundJson, {});
  const copyDir = roundJson.copyDir;
  const key = sealedKey(runDir, round, dp) || { canaries: [] };
  const lenses = jsonIf(runPaths(runDir).lenses, { lenses: [], requirements: [] });
  const lens = lenses.lenses.find((l) => l.id === rec.lens) || { minimum: [] };
  const plan = pick(script.reviewers, round, rec.lens, rec.attempt) || { findings: [] };
  const taxonomy = loadTaxonomy();
  const vars = { nonce: rec.nonce, receipts: receiptAnswers(rec, copyDir), key };
  const findings = [];
  for (const f of plan.findings || []) {
    let out = null;
    if (f && f.canaryFinding) {
      const c =
        f.canaryFinding === 'own'
          ? (key.canaries || []).find((x) => x.purpose === 'attention' && x.targetLens === rec.lens)
          : (key.canaries || []).find((x) => x.slot === f.canaryFinding);
      if (c) out = canaryFinding(c, taxonomy);
    } else {
      out = fillDeep(f, vars);
    }
    if (out) findings.push({ n: findings.length + 1, ...out });
  }
  const reqMarks = plan.requirements || {};
  return {
    schemaVersion: 1,
    nonce: rec.nonce,
    // a real agent copies the message it was started with (r3-f10)
    instructionReceived: ctx.call || callFor({ dir: rec.dir }, path.join(runDir, 'templates')),
    receipt: (rec.challenges || []).map((c) => ({ id: c.id, answer: vars.receipts[c.id] })),
    inspected: (lens.minimum || []).map((m) => ({ minimumId: m.id, done: true, how: 'Открыл и прочитал всё по списку, записи по одной.' })),
    sourceChecks: [],
    requirements: (lenses.requirements || []).map((r) => ({ id: r.id, status: reqMarks[r.id] || 'present', where: 'content/plan.json, content/page.md' })),
    findings,
    notVerified: [],
    notChecked: [],
    ...(plan.extra ? fillDeep(plan.extra, vars) : {}),
  };
}

/** What a real planter reads from its job folder: the lines of the rows listed in each SAMPLE-<k>.md. */
function sampleLinesOfJob(dir) {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^SAMPLE-\d+\.md$/.test(n));
  } catch {
    names = [];
  }
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const file = /^# Rows to read in (.+)$/m.exec(text)?.[1];
    if (!file) continue;
    const lines = new Set();
    for (const m of text.matchAll(/^## (?:Row \d+|Header) \(line (\d+)\)$/gm)) lines.add(Number(m[1]));
    out.set(file.trim(), lines);
  }
  return out;
}

function planterAnswer(rec, ctx) {
  const { runDir, script } = ctx;
  const p = runPaths(runDir);
  const round = rec.round;
  const roundJson = jsonIf(p.roundDir(round).roundJson, {});
  const copyDir = roundJson.copyDir;
  const run = jsonIf(p.runJson, {});
  const slots = (jsonIf(phasePathOf({ dataPaths: ctx.dp, runId: run.runId, roundDir: p.roundDir(round).dir }, round, 'slots.json'), { slots: [] }).slots || []).filter((s) => (rec.slots || []).includes(s.slot));
  const taxonomy = loadTaxonomy();
  const pidx = positionIndex(copyDir, run.material?.readingOrder || []);
  const avoid = script.planterAvoid || [];
  const minDist = (run.canaries?.minDistanceChars ?? 400) + 50;
  const maxEdit = run.canaries?.maxEditChars ?? 240;
  const used = (roundJson.approved || []).map((a) => ({ file: a.file, index: a.index ?? 0, len: String(a.before).length }));
  const sampleLines = sampleLinesOfJob(rec.dir);
  const candidates = [];
  for (const slot of slots) {
    const type = taxonomy.byId(slot.type);
    const [lo, hi] = slot.range || [0, 1];
    let alt = 0;
    for (const f of pidx.files) {
      if (alt >= 2) break;
      if (/AUTHOR-NOTES/i.test(f.rel)) continue;
      const text = readText(path.join(copyDir, ...f.rel.split('/')));
      const lines = text.split('\n');
      let idx = 0;
      for (let li = 0; li < lines.length && alt < 2; li++) {
        const line = lines[li];
        const start = idx;
        idx += line.length + 1;
        const frac = pidx.offsetOf(f.rel, start);
        if (frac === null || frac < lo + 0.01 || frac > hi - 0.01) continue;
        if (sampleLines.has(f.rel) && !sampleLines.get(f.rel).has(li + 1)) continue;
        if (avoid.some((a) => line.includes(a))) continue;
        if (used.some((u) => u.file === f.rel && Math.abs(u.index - start) < minDist)) continue;
        let before = null;
        let after = null;
        if (type?.omission) {
          const m = /^(\s*"caption_ru": ")([^"]*?\. )([^"]{22,})(",?)$/.exec(line);
          if (f.rel.endsWith('.json') && m) {
            before = line;
            after = `${m[1]}${m[2].trimEnd()}${m[4]}`;
          } else if (f.rel.endsWith('.md') && /^- .{24,}$/.test(line) && li + 1 < lines.length && lines[li + 1].length > 3) {
            before = `${line}\n${lines[li + 1]}`;
            after = lines[li + 1];
          }
        } else {
          const m = /\d+/.exec(line);
          const unique = text.split(line).length === 2;
          if (m && unique && !/^\s*"id":/.test(line)) {
            const n = Number(m[0]);
            const repl = String(n === 0 ? 1 : n + 1);
            before = line;
            after = line.slice(0, m.index) + repl + line.slice(m.index + m[0].length);
          } else if (unique && !/^\s*"(id|price_eur|cta)":/.test(line)) {
            // A typo: swap two letters inside the first long word of the line.
            const w = /[\p{L}]{6,}/u.exec(line);
            if (w) {
              const i = w.index + 2;
              before = line;
              after = line.slice(0, i) + line[i + 1] + line[i] + line.slice(i + 2);
              if (after === before) before = null;
            }
          }
        }
        if (!before || before.length > maxEdit || after.length > maxEdit || before.trim().length < 3) continue;
        if (text.split(before).length !== 2) continue; // must occur exactly once
        alt++;
        candidates.push({
          slot: slot.slot,
          alt,
          file: f.rel,
          locator: `line ${li + 1}`,
          before,
          after,
          description: `${slot.type}: a small change in ${f.rel} line ${li + 1}.`,
          howProvable: 'Compare with the other mentions in the work and with the price list.',
          intendedSeverity: slot.severityFloor === 'blocker' ? 'blocker' : 'major',
        });
        if (alt === 1) used.push({ file: f.rel, index: start, len: before.length });
      }
    }
  }
  return { schemaVersion: 1, nonce: rec.nonce, candidates, incidental: [] };
}

function validatorAnswer(rec, ctx) {
  const p = runPaths(ctx.runDir);
  // A real validator reads the candidates in its prompt; the fake one reads the planter answer, which
  // sits in the sealed stage until the key is revealed.
  const pa = jsonIf(phasePathOf({ dataPaths: ctx.dp, runId: readJson(p.runJson).runId, roundDir: p.roundDir(rec.round).dir }, rec.round, `planter-${rec.planterAttempt || 1}/answer.json`), { candidates: [] });
  return {
    schemaVersion: 1,
    nonce: rec.nonce,
    verdicts: (pa.candidates || [])
      .filter((c) => (rec.slots || []).includes(c.slot))
      .map((c) => ({ slot: c.slot, alt: c.alt, originalCorrect: true, isDefect: true, provable: true, natural: 4, giveaway: false, severity: 'blocker', keep: true, why: 'The original is correct and the edit is provable from the rest of the work.' })),
  };
}

function matcherAnswer(rec, ctx) {
  const p = runPaths(ctx.runDir);
  const m = jsonIf(path.join(p.roundDir(rec.round).dir, `match-${rec.wave || 1}.json`), { needMatcher: [] });
  const key = sealedKey(ctx.runDir, rec.round, ctx.dp) || { canaries: [] };
  const pairs = [];
  for (const item of m.needMatcher || []) {
    const c = (key.canaries || []).find((x) => x.canary === item.canary) || {};
    const after = normalizeQuote(c.after || '');
    for (const f of item.findings || []) {
      const q = normalizeQuote(f.quote || '');
      const same = q.length >= 4 && after.length >= 4 && (after.includes(q) || q.includes(after));
      pairs.push({ canary: item.canary, finding: f.finding, score: same ? 5 : 1, alsoReal: false, why: same ? 'The finding quotes the changed text.' : 'A different place.' });
    }
  }
  return { schemaVersion: 1, nonce: rec.nonce, pairs };
}

/**
 * The decoy items of a round (privileged: the mix is sealed in the data home until the round closes):
 * Set of `${pass}:${item}`.
 */
export function decoyItemSet(runDir, round, dp) {
  const runId = jsonIf(runPaths(runDir).runJson, {}).runId;
  const rel = path.join(dp.sealedDir(runId), `${String(round).padStart(2, '0')}-decoy-stage`, 'decoy-mix.json');
  const mix = jsonIf(rel, null) || jsonIf(path.join(runPaths(runDir).roundDir(round).dir, 'decoy-mix.json'), { items: [] });
  return new Set((mix.items || []).map((x) => `${x.pass}:${x.item}`));
}

/**
 * The true-control items of a round (privileged, sealed like the decoys until the round closes):
 * Map of `${pass}:${item}` -> the planted class of the control.
 */
export function controlItemSet(runDir, round, dp) {
  const runId = jsonIf(runPaths(runDir).runJson, {}).runId;
  const nn = String(round).padStart(2, '0');
  const staged = path.join(dp.sealedDir(runId), `${nn}-decoy-stage`);
  const final = runPaths(runDir).roundDir(round).dir;
  const read = (name, d) => jsonIf(path.join(staged, name), null) || jsonIf(path.join(final, name), d);
  const mix = read('control-mix.json', { items: [] });
  const key = read('controls.json', { controls: [] });
  const planted = new Map((key.controls || []).map((k) => [k.control, k.plantedSeverity]));
  return new Map((mix.items || []).map((x) => [`${x.pass}:${x.item}`, planted.get(x.control) || 'major']));
}

function verifierAnswer(rec, ctx) {
  const p = runPaths(ctx.runDir);
  const vi = jsonIf(p.roundDir(rec.round).verifyItems, { items: [] });
  const rules = ctx.script.verifier?.[String(rec.round)] || [];
  const dflt = ctx.script.verifier?.default || { verdict: 'unverifiable', severity: null, evidence: 'Could not decide from the material.' };
  const decoys = decoyItemSet(ctx.runDir, rec.round, ctx.dp);
  // script.decoy.confirm = { passes: [1], batches: [1] }: verifier jobs that accept the false items shown to them
  const conf = ctx.script.decoy?.confirm || null;
  const lenient = !!conf && (!conf.passes || conf.passes.includes(rec.verifierPass)) && (!conf.batches || conf.batches.includes(rec.batch)) && (!conf.rounds || conf.rounds.includes(rec.round));
  const controls = controlItemSet(ctx.runDir, rec.round, ctx.dp);
  // script.control.dismiss = { passes: [1], batches: [1], rounds: [1], mode: 'refute' | 'downgrade' }: verifier jobs that
  // acquit (or play down) the real, planted defects shown to them
  const dis = ctx.script.control?.dismiss || null;
  const sloppy = !!dis && (!dis.passes || dis.passes.includes(rec.verifierPass)) && (!dis.batches || dis.batches.includes(rec.batch)) && (!dis.rounds || dis.rounds.includes(rec.round));
  const items = (rec.items || []).map((id) => {
    const it = vi.items.find((x) => x.item === id && x.pass === rec.verifierPass) || {};
    if (controls.has(`${rec.verifierPass}:${id}`)) {
      const planted = controls.get(`${rec.verifierPass}:${id}`);
      const shown = it.shown && !/^(missing|visible): /.test(it.shown) ? it.shown : undefined;
      if (sloppy && dis.mode === 'downgrade') return { item: id, verdict: 'confirmed', severity: 'cosmetic', evidence: 'Место нашёл: расхождение есть, но оно мелкое.', quoteNow: shown, whereNow: shown ? it.file || undefined : undefined };
      if (sloppy) return { item: id, verdict: 'refuted', severity: null, evidence: 'Проверил место и остальные части работы: замечание неверно, расхождения там нет.' };
      return { item: id, verdict: 'confirmed', severity: planted, evidence: 'Нашёл это место и подтверждаю замечание: так и есть.', quoteNow: shown, whereNow: shown ? it.file || undefined : undefined };
    }
    if (decoys.has(`${rec.verifierPass}:${id}`)) {
      if (lenient) return { item: id, verdict: 'confirmed', severity: 'major', evidence: 'Нашёл это место и подтверждаю замечание: так и есть.', quoteNow: it.shown && !/^(missing|visible): /.test(it.shown) ? it.shown : undefined, whereNow: it.file || undefined };
      return { item: id, verdict: 'refuted', severity: null, evidence: 'Проверил место и остальные части работы: замечание неверно, расхождения там нет.' };
    }
    const hay = `${it.shown || ''} ${it.claim || ''}`;
    const rule = rules.find((r) => hay.includes(r.match)) || dflt;
    const out = { item: id, verdict: rule.verdict, severity: rule.verdict === 'confirmed' ? rule.severity : null, evidence: rule.evidence };
    if (rule.verdict === 'confirmed' && it.shown && !/^(missing|visible): /.test(it.shown)) {
      out.quoteNow = it.shown;
      out.whereNow = it.file || '';
    }
    return out;
  });
  return { schemaVersion: 1, nonce: rec.nonce, items };
}

function decoyAnswer(rec, ctx) {
  const list = ctx.script.decoyWriter?.decoys ?? [];
  return { schemaVersion: 1, nonce: rec.nonce, decoys: list, incidental: [] };
}

function disputeAnswer(rec, ctx) {
  // script.dispute.outcomes = [first verifier, second verifier] overrides the shared outcome.
  const outcome = ctx.script.dispute?.outcomes?.[(rec.attempt || 1) - 1] || ctx.script.dispute?.outcome || 'upheld';
  return { schemaVersion: 1, nonce: rec.nonce, items: (rec.disputes || []).map((id) => ({ item: id, outcome, severity: outcome === 'reclassified' ? ctx.script.dispute?.severity || 'cosmetic' : null, why: 'Checked the place and the evidence myself.' })) };
}

function lensWriterAnswer(rec, ctx) {
  return { schemaVersion: 1, nonce: rec.nonce, ...ctx.script.lensWriter };
}

const MAKERS = {
  'lens-writer': lensWriterAnswer,
  planter: planterAnswer,
  validator: validatorAnswer,
  reviewer: reviewerAnswer,
  matcher: matcherAnswer,
  verifier: verifierAnswer,
  dispute: disputeAnswer,
  decoy: decoyAnswer,
};

/**
 * answerJobs(jobs, { runDir, script, dataPaths?, mutate?, skip? }) -> [{ job, role, written }]
 * jobs: the `jobs` array of a step exit-10 payload. mutate(rec, answer) may change or replace an
 * answer (cheater tests); skip(rec) -> true leaves a job unanswered.
 */
export function answerJobs(jobs, opts) {
  const dp = opts.dataPaths || defaultDataPaths();
  const ctx = { runDir: opts.runDir, script: opts.script, dp };
  const out = [];
  for (const j of jobs || []) {
    const rec = findJob(opts.runDir, j.job);
    if (!rec) throw new Error(`fake agents: job ${j.job} not found in the run`);
    if (opts.skip && opts.skip(rec)) {
      out.push({ job: j.job, role: rec.role, written: false });
      continue;
    }
    let answer = MAKERS[rec.role](rec, { ...ctx, call: j.call ?? null });
    if (opts.mutate) answer = opts.mutate(rec, answer) ?? answer;
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2) + '\n';
    fs.writeFileSync(path.join(rec.dir, 'answer.json'), text);
    // The answer code a real agent copies from check-answer.mjs ("DONE <code>").
    const code = createHash('sha256').update(fs.readFileSync(path.join(rec.dir, 'answer.json'))).digest('hex').slice(0, 16);
    out.push({ job: j.job, role: rec.role, lens: rec.lens ?? null, attempt: rec.attempt, written: true, code });
  }
  return out;
}
