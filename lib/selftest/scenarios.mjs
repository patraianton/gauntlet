// Selftest harness and the offline scenario of SPEC 21.3 (no LLM).
//
// Harness: a temp data home (GAUNTLET_DATA), GAUNTLET_TEST=1 and a fixed GAUNTLET_SEED, a
// workspace <dataHome>/selftest/<rand>/ with a copy of fixtures/selftest/material, and the CLI run
// in-process (bin/gauntlet.mjs main) with --json. Fake agents answer every printed call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { repoTemplates, addApproval } from '../engine/cmd-templates.mjs';
import { dataPaths } from '../core/datahome.mjs';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_DIR = path.join(REPO_DIR, 'fixtures', 'selftest');

/**
 * Cuts the path of the program itself out of a text, whatever way it is written: either slash, doubled
 * slashes, any letter case (the to-do prints the call that records a fix, and the folder name of the
 * program may contain a word the forbidden-word check would trip on).
 */
export function cutProgramPath(text, dir) {
  const parts = String(dir).split(/[\\/]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return String(text);
  const lead = /^[\\/]/.test(String(dir)) ? '[\\\\/]+' : '';
  return String(text).replace(new RegExp(lead + parts.join('[\\\\/]+'), 'giu'), '<program>');
}
export const DEFAULT_SEED = '5e1f7e57c0ffee00d15ea5edba5eba11';

const NEUTRAL = 'abcdefghjkmnpqrstuvwxyz23456789';
function rand8() {
  const b = randomBytes(8);
  let s = '';
  for (const x of b) s += NEUTRAL[x % NEUTRAL.length];
  return s;
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(a, b);
    else fs.copyFileSync(a, b);
  }
}

/**
 * Create the temp environment. Sets process.env (restored by env.restore()).
 * -> { root, dataHome, workspace, restore() }
 */
export function makeEnv({ seed = DEFAULT_SEED, root = null } = {}) {
  const saved = { GAUNTLET_DATA: process.env.GAUNTLET_DATA, GAUNTLET_TEST: process.env.GAUNTLET_TEST, GAUNTLET_SEED: process.env.GAUNTLET_SEED };
  const base = root || path.join(os.tmpdir(), `plst-${rand8()}`);
  const dataHome = path.join(base, 'data');
  fs.mkdirSync(dataHome, { recursive: true });
  process.env.GAUNTLET_DATA = dataHome;
  process.env.GAUNTLET_TEST = '1';
  process.env.GAUNTLET_SEED = seed;
  // a test data home approves the repository's current templates (in a real data home only the
  // owner does, with templates approve --owner-quote, r3-f6)
  const cur = repoTemplates(REPO_DIR);
  addApproval(dataPaths(dataHome), { manifestSha256: cur.manifestSha256, version: cur.version, quote: 'selftest data home', date: '2026-10-06', ts: '2026-10-06T00:00:00.000Z' });
  const workspace = path.join(dataHome, 'selftest', rand8());
  fs.mkdirSync(workspace, { recursive: true });
  return {
    root: base,
    dataHome,
    workspace,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export function loadScript() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'script.json'), 'utf8'));
}

/** Run one CLI command in-process with --json. -> envelope (plus .text) */
export async function cli(argv) {
  const { main } = await import('../../bin/gauntlet.mjs');
  const r = await main([...argv, '--json']);
  const env = r.envelope;
  env.text = r.result?.text ?? '';
  return env;
}

/** A project workspace: material copy, sources folder, project dir. */
export function makeProject(env, name = 'proj') {
  const dir = path.join(env.workspace, name);
  copyDirSync(path.join(FIXTURE_DIR, 'material'), path.join(dir, 'material'));
  // Another project in the same test data home is another work: its Markdown files get a marker, so
  // the content-overlap check of init (r3-f8) does not take it for a copy of the first one.
  if (name !== 'proj') {
    for (const f of fs.readdirSync(path.join(dir, 'material'))) {
      if (f.endsWith('.md')) fs.appendFileSync(path.join(dir, 'material', f), `
<!-- ${name} -->
`);
    }
  }
  copyDirSync(path.join(FIXTURE_DIR, 'sources'), path.join(dir, 'sources'));
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  return { dir, material: path.join(dir, 'material'), sources: path.join(dir, 'sources'), projectDir: path.join(dir, 'workspace') };
}

/** init + task set + settings files. -> { runDir, project } */
export async function newRun(env, { name = 'proj', script = loadScript(), project = null, mutateMaterial = null } = {}) {
  const pr = project || makeProject(env, name);
  if (mutateMaterial) mutateMaterial(pr);
  const init = await cli([
    'init',
    '--project', `selftest-${name}`,
    '--artifact-type', 'marketing-plan',
    '--root', `${pr.material}=content`,
    '--notes', 'content/AUTHOR-NOTES.md',
    '--project-dir', pr.projectDir,
  ]);
  if (init.exitCode !== 0) throw new Error(`init failed: ${init.text}`);
  const runDir = init.payload.runDir;
  // settings the executor writes before the first step
  const runJsonPath = path.join(runDir, 'run.json');
  const run = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
  run.material.readingOrder = script.readingOrder;
  fs.writeFileSync(runJsonPath, JSON.stringify(run, null, 2) + '\n');
  const sources = fs.readFileSync(path.join(FIXTURE_DIR, 'sources.json'), 'utf8').replaceAll('{{SOURCES_DIR}}', pr.sources.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(runDir, 'sources.json'), sources);
  fs.copyFileSync(path.join(FIXTURE_DIR, 'strip.json'), path.join(runDir, 'strip.json'));
  fs.copyFileSync(path.join(FIXTURE_DIR, 'mechanical.json'), path.join(runDir, 'mechanical.json'));
  const task = await cli(['task', 'set', runDir, '--from', path.join(FIXTURE_DIR, 'task.md'), '--cut', script.cutLines, '--source', script.source]);
  if (task.exitCode !== 0) throw new Error(`task set failed: ${task.text}`);
  return { runDir, project: pr, init, task };
}

/**
 * Run `step` and answer every exit-10 call with fake agents until the step returns something else.
 * -> { last, spawns: [envelope], decisions: [] }
 */
export async function drive(runDir, { script = loadScript(), mutate = null, skip = null, maxSpawns = 40, stepArgs = [] } = {}) {
  const { answerJobs } = await import('./fake-agents.mjs');
  const spawns = [];
  let extra = [...stepArgs];
  let last = null;
  for (let i = 0; i < maxSpawns; i++) {
    last = await cli(['step', runDir, ...extra]);
    if (last.exitCode !== 10) return { last, spawns };
    spawns.push(last);
    const written = answerJobs(last.payload.jobs, { runDir, script, mutate, skip });
    const usage = written.filter((w) => w.written).map((w) => `${w.job}=12345`);
    const codes = written.filter((w) => w.written && w.code).map((w) => `${w.job}=${w.code}`);
    extra = [...(usage.length ? ['--usage', usage.join(',')] : []), ...(codes.length ? ['--answer-hash', codes.join(',')] : [])];
  }
  return { last, spawns, exhausted: true };
}

/** Apply fixtures/selftest/fix-1.patch.json to the live material. */
export function applyFix(project, file = path.join(FIXTURE_DIR, 'fix-1.patch.json')) {
  const patch = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of patch.replacements) {
    const p = path.join(project.material, r.file);
    const text = fs.readFileSync(p, 'utf8');
    if (!text.includes(r.before)) throw new Error(`fix patch: "${r.before}" not found in ${r.file}`);
    const next = r.all ? text.split(r.before).join(r.after) : text.replace(r.before, r.after);
    fs.writeFileSync(p, next);
  }
}

export function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

export function roundDir(runDir, n) {
  return path.join(runDir, 'rounds', String(n).padStart(2, '0'));
}

export function ledgerOf(runDir) {
  const p = path.join(runDir, 'ledger.jsonl');
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Words that must never appear in todo.md (13.6): scores, bands, canary words. */
export const TODO_FORBIDDEN = [/\bscore/i, /\bband\b/i, /canar/i, /planted/i, /подлож/i, /справочно/i, /оценк/i, /attention/i];

/**
 * The full offline scenario (SPEC 21.3). -> { results: [{ name, ok, details }], env, runDir }
 * Each assertion is recorded; the function never throws on a failed assertion.
 */
export async function runScenario({ keep = false, log = () => {} } = {}) {
  const results = [];
  const check = (name, ok, details = '') => {
    results.push({ name, ok: !!ok, details: String(details).slice(0, 500) });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${details && !ok ? ` — ${String(details).slice(0, 300)}` : ''}`);
    return !!ok;
  };
  const script = loadScript();
  const env = makeEnv({ seed: script.seed || DEFAULT_SEED });
  let runDir = null;
  try {
    // 1. init, task set --cut, lens writer, freeze
    const r = await newRun(env, { script });
    runDir = r.runDir;
    check('init creates the run', fs.existsSync(path.join(runDir, 'run.json')));
    const task = fs.readFileSync(path.join(runDir, 'TASK.md'), 'utf8');
    const owner = fs.readFileSync(path.join(runDir, 'OWNER-TASK.md'), 'utf8');
    check('task set cuts the loop-control line', !/9,5/.test(task) && /9,5/.test(owner), task);
    const setup = await drive(runDir, { script });
    check('setup: lens writer spawned once', setup.spawns.length === 1 && setup.spawns[0].payload.jobs[0].role === 'lens-writer', JSON.stringify(setup.spawns.map((s) => s.payload.jobs.map((j) => j.role))));
    check('setup: frozen, exit 20', setup.last.exitCode === 20 && fs.existsSync(path.join(runDir, 'FROZEN.json')) && setup.last.state === 'READY', setup.last.text);
    check('setup summary written in Russian', /План проверки/.test(fs.readFileSync(path.join(runDir, 'SETUP-SUMMARY.ru.md'), 'utf8')));

    // 2. round 1
    const r1 = await drive(runDir, { script });
    const g1 = readJsonFile(path.join(roundDir(runDir, 1), 'gate.json'));
    const led = ledgerOf(runDir);
    const reruns = led.filter((l) => l.type === 'rerun' && l.round === 1);
    check('round 1: a lens missed its attention check and was re-run (RERUN_LENS)', reruns.length === 1 && reruns[0].data.decision === 'RERUN_LENS' && reruns[0].data.lenses.includes('language'), JSON.stringify(reruns.map((x) => x.data)));
    check('round 1: decision FIX, exit 20', r1.last.exitCode === 20 && g1.decision === 'FIX', `${r1.last.exitCode} ${g1.decision} ${r1.last.text}`);
    const clusters1 = readJsonFile(path.join(runDir, 'clusters.json')).clusters;
    const open1 = clusters1.filter((c) => ['open', 'unverified', 'contested'].includes(c.status) && ['blocker', 'major'].includes(c.severity));
    check('round 1: 3 open clusters (sum, contradiction, missing call to action)', open1.length === 3 && g1.open.blocker + g1.open.major === 3, JSON.stringify(open1.map((c) => [c.id, c.status, c.severity, c.quote])));
    const dropped = clusters1.filter((c) => c.status === 'dropped');
    check('round 1: the finding with an invented quote was refuted and dropped', dropped.length >= 1 && dropped.some((c) => /70%/.test(c.quote || '')), JSON.stringify(dropped.map((c) => c.quote)));
    const todo1 = fs.readFileSync(path.join(roundDir(runDir, 1), 'todo.md'), 'utf8');
    // The to-do prints the path of the program itself (the call that records a fix); a folder name in that path is not
    // program wording, so it is cut out before the words are checked.
    const todoWords = cutProgramPath(todo1, REPO_DIR);
    const leaks = TODO_FORBIDDEN.filter((re) => re.test(todoWords)).map(String);
    check('round 1: todo.md has no score, band or canary words', leaks.length === 0, leaks.join(', '));
    check('round 1: review copy and job folders deleted', !fs.existsSync(readJsonFile(path.join(roundDir(runDir, 1), 'round.json')).copyDir));
    // decoys: false findings mixed into the verifier batches (SPEC 14.11)
    const dkeyPath = path.join(roundDir(runDir, 1), 'decoys.json');
    const dkey = fs.existsSync(dkeyPath) ? readJsonFile(dkeyPath) : null;
    const dmix = fs.existsSync(path.join(roundDir(runDir, 1), 'decoy-mix.json')) ? readJsonFile(path.join(roundDir(runDir, 1), 'decoy-mix.json')) : { items: [] };
    const dres = fs.existsSync(path.join(roundDir(runDir, 1), 'decoy-results.json')) ? readJsonFile(path.join(roundDir(runDir, 1), 'decoy-results.json')).results : [];
    check('round 1: false findings were mixed into the verifier batches and revealed at close', !!dkey && dkey.decoys.length >= 2 && dmix.items.length >= 2 && dres.length === dmix.items.length, JSON.stringify({ decoys: dkey && dkey.decoys.length, mixed: dmix.items.length, results: dres.length }));
    check('round 1: the verifiers refused every false finding', dres.length > 0 && dres.every((x) => x.outcome === 'rejected'), JSON.stringify(dres.map((x) => x.outcome)));
    check('round 1: no false finding became a cluster or reached to-do.md', !!dkey && dmix.items.every((x) => !clusters1.some((c) => c.id === x.cluster)) && dkey.decoys.every((d) => !todo1.includes(d.claim) && !clusters1.some((c) => c.problem === d.claim)));

    // true controls: real planted defects that the reviewers found, mixed into the verifier batches (SPEC 14.12)
    const ckeyPath = path.join(roundDir(runDir, 1), 'controls.json');
    const ckey = fs.existsSync(ckeyPath) ? readJsonFile(ckeyPath) : null;
    const cmix = fs.existsSync(path.join(roundDir(runDir, 1), 'control-mix.json')) ? readJsonFile(path.join(roundDir(runDir, 1), 'control-mix.json')) : { items: [] };
    const cres = fs.existsSync(path.join(roundDir(runDir, 1), 'control-results.json')) ? readJsonFile(path.join(roundDir(runDir, 1), 'control-results.json')).results : [];
    check('round 1: real planted defects were mixed into the verifier batches and revealed at close', !!ckey && ckey.controls.length >= 1 && cmix.items.length >= 1 && cres.length === cmix.items.length, JSON.stringify({ controls: ckey && ckey.controls.length, mixed: cmix.items.length, results: cres.length }));
    check('round 1: the verifiers confirmed every real planted defect at its class', cres.length > 0 && cres.every((x) => x.outcome === 'kept'), JSON.stringify(cres.map((x) => x.outcome)));
    check('round 1: no true control became a cluster or reached to-do.md', !!ckey && cmix.items.every((x) => !clusters1.some((c) => c.id === x.cluster)) && ckey.controls.every((k) => !todo1.includes(k.claim) && !clusters1.some((c) => c.problem === k.claim)));

    // 3. unchanged material
    const same = await cli(['step', runDir]);
    check('step without changes refuses: material unchanged (exit 20)', same.exitCode === 20 && /unchanged/i.test(same.text), same.text);

    // 4. fix, round 2
    applyFix(r.project);
    const r2 = await drive(runDir, { script });
    const g2 = readJsonFile(path.join(roundDir(runDir, 2), 'gate.json'));
    const clusters2 = readJsonFile(path.join(runDir, 'clusters.json')).clusters;
    const closed = clusters2.filter((c) => c.status === 'closed');
    check('round 2: carry-overs refuted twice -> closed', closed.length === 3 && closed.every((c) => c.evidence.filter((e) => e.round === 2).length === 2), JSON.stringify(clusters2.map((c) => [c.id, c.status])));
    check('round 2: clean -> CONFIRM', g2.decision === 'CONFIRM' && r2.last.exitCode === 20, `${g2.decision} ${r2.last.text}`);

    // 5. round 3 (confirm) -> DONE; done; report; audit
    const r3 = await drive(runDir, { script });
    const g3 = readJsonFile(path.join(roundDir(runDir, 3), 'gate.json'));
    const round3 = readJsonFile(path.join(roundDir(runDir, 3), 'round.json'));
    check('round 3 is the confirm round on the same version', g3.kind === 'confirm' && round3.versionHash === readJsonFile(path.join(roundDir(runDir, 2), 'round.json')).versionHash);
    const vi3 = readJsonFile(path.join(roundDir(runDir, 3), 'verify-items.json'));
    const perCluster = {};
    for (const it of vi3.items) perCluster[it.cluster] = (perCluster[it.cluster] || 0) + 1;
    check('round 3: double verification (every item in two batches)', Object.keys(perCluster).length > 0 && Object.values(perCluster).every((n) => n === 2), JSON.stringify(perCluster));
    const slots3 = readJsonFile(path.join(roundDir(runDir, 3), 'slots.json')).slots;
    check('round 3: at least one omission slot', slots3.some((s) => /^OMIT/.test(s.type)), JSON.stringify(slots3.map((s) => s.type)));
    check('round 3: clean -> DONE', g3.decision === 'DONE' && r3.last.exitCode === 20, `${g3.decision} ${r3.last.text}`);
    const done = await cli(['done', runDir]);
    check('done: exit 30 and DONE.json written', done.exitCode === 30 && fs.existsSync(path.join(runDir, 'DONE.json')), done.text);
    const report = fs.readFileSync(path.join(runDir, 'REPORT.ru.md'), 'utf8');
    check('report says «Готово»', /Готово/.test(report));
    check('report says how many false findings the verifiers refused', /Перепроверка отклонила \d+ из \d+ заведомо ложных замечаний/.test(report), report.slice(0, 200));
    check('report says how many real planted problems the verifiers wrongly dismissed', /Ошибочно отвергнуто: 0\. Признано менее серьёзными, чем они есть: 0\./.test(report), report.slice(0, 200));
    check('report shows the reference band («справочно»)', /справочно/i.test(report));
    const aud = await cli(['audit', runDir]);
    check('audit passes', aud.exitCode === 0, aud.text);
    const st = await cli(['status', runDir]);
    check('status: DONE, no unreviewed changes', st.payload.state === 'DONE' && st.payload.unreviewedChanges.length === 0, st.text);

    // 6. cheats on the finished run
    const pagePath = path.join(r.project.material, 'page.md');
    const pageText = fs.readFileSync(pagePath, 'utf8');
    fs.writeFileSync(pagePath, pageText + '\nДобавлено после проверки.\n');
    const st2 = await cli(['status', runDir]);
    check('cheat: live file edited after DONE -> status shows UNREVIEWED CHANGES', st2.payload.unreviewedChanges.length > 0 && /UNREVIEWED CHANGES/.test(st2.text), st2.text);
    const done2 = await cli(['done', runDir]);
    check('cheat: done reports "edited after review"', done2.exitCode === 30 && Array.isArray(done2.payload.editedAfterReview) && done2.payload.editedAfterReview.length > 0, done2.text);
    const sum2 = await cli(['report', runDir, '--summary']);
    check('cheat: after the edit the summary no longer says «Готово»', sum2.exitCode === 0 && !/^Готово/.test(sum2.payload.summaryRu[0]), sum2.text);
    fs.writeFileSync(pagePath, pageText);
    const ansDir = path.join(roundDir(runDir, 1), 'answers');
    const ansFile = path.join(ansDir, fs.readdirSync(ansDir)[0]);
    const ansText = fs.readFileSync(ansFile, 'utf8');
    fs.writeFileSync(ansFile, ansText.replace('"findings"', '"findings" ').replace(/\s*$/, '\n '));
    const aud2 = await cli(['audit', runDir]);
    check('cheat: an answer edited after ingest -> audit fails (exit 3)', aud2.exitCode === 3 && aud2.payload.checks.some((c) => c.id === 'answers' && !c.ok), aud2.text);
    fs.writeFileSync(ansFile, ansText);

    const fresh = await newRun(env, {
      name: 'trace',
      script,
      mutateMaterial: (pr) => {
        const p = path.join(pr.material, 'page.md');
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('## Сроки', '## Сроки (круг 3)'));
      },
    });
    const pre = await cli(['step', fresh.runDir]);
    check('cheat: «круг 3» in the material before freeze -> the strip preview refuses setup (exit 20, state NEW)', pre.exitCode === 20 && pre.state === 'NEW' && /круг 3/.test(pre.text), pre.text);

    const late = await newRun(env, { name: 'trace2', script });
    await drive(late.runDir, { script });
    const lp = path.join(late.project.material, 'page.md');
    fs.writeFileSync(lp, fs.readFileSync(lp, 'utf8').replace('## Сроки', '## Сроки (круг 3)'));
    const blocked = await cli(['step', late.runDir]);
    check('cheat: «круг 3» added after freeze -> BLOCKED_TRACE (exit 20, not a round)', blocked.exitCode === 20 && blocked.payload.decision === 'BLOCKED_TRACE', blocked.text);

    // 7. ledger stats
    const stats = await cli(['ledger', 'stats']);
    const statsText = `${stats.text}\n${fs.existsSync(path.join(env.dataHome, 'measurements', 'STATS.md')) ? fs.readFileSync(path.join(env.dataHome, 'measurements', 'STATS.md'), 'utf8') : ''}`;
    const canaryRows = fs.existsSync(path.join(env.dataHome, 'measurements', 'canaries.jsonl'))
      ? fs.readFileSync(path.join(env.dataHome, 'measurements', 'canaries.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    check('ledger stats shows the selftest canaries as insufficient data', stats.exitCode === 0 && canaryRows > 0 && /insufficient/i.test(statsText), `${stats.exitCode} rows=${canaryRows} ${stats.text.slice(0, 300)}`);
  } catch (e) {
    check('scenario ran without an internal error', false, e.stack || e.message);
  } finally {
    env.restore();
  }
  const ok = results.length > 0 && results.every((x) => x.ok);
  if (ok && !keep) {
    try {
      fs.rmSync(env.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return { ok, results, env, runDir };
}
