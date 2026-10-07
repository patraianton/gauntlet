// Night of 06-07.10.2026: a word of the work ("honeypot") invalidated reviewers, and data files were
// rewritten to pass the trace scan. End-to-end through the engine with the fake agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, readyRun, cli, stepUntil, isReviewerSpawn, answerJobs, loadScript, roundDir, readJsonFile, drive } from '../fixtures/engine/helpers.mjs';

const HONEY = 'The form has a hidden field honeypot that bots fill in.';

/** Reviewer answers of round 1: the first reviewer of a lens other than the generalist says `how`. */
async function victimRound(env, { how, material }) {
  const r = await readyRun(env, {
    beforeSetup: material
      ? (x) => {
          fs.appendFileSync(path.join(x.project.material, 'page.md'), `\n${material}\n`);
        }
      : undefined,
  });
  const spawn = await stepUntil(r.runDir, isReviewerSpawn);
  let victim = null;
  answerJobs(spawn.payload.jobs, {
    runDir: r.runDir,
    script: loadScript(),
    mutate: (rec, ans) => {
      if (victim || rec.role !== 'reviewer' || rec.lens === 'generalist') return ans;
      victim = rec;
      return { ...ans, inspected: (ans.inspected || []).map((x, i) => (i === 0 ? { ...x, how } : x)) };
    },
  });
  await cli(['step', r.runDir]);
  const ing = readJsonFile(path.join(roundDir(r.runDir, 1), 'ingest', `${victim.job}.json`));
  return { r, victim, ing };
}

test('a word the work itself uses ("honeypot" in the material) no longer makes a reviewer answer invalid', async () => {
  await withEnv(async (env) => {
    const { ing } = await victimRound(env, { how: 'read the form handler: the hidden honeypot field, the limits, the schema', material: HONEY });
    assert.deepEqual(ing.metaMentions, [], JSON.stringify(ing));
    assert.ok(!ing.reasons.includes('talks about the check itself'), JSON.stringify(ing.reasons));
    const mine = ing.metaIgnored.find((x) => x.name === 'answer.inspected[0].how');
    assert.ok(mine, JSON.stringify(ing.metaIgnored));
    assert.equal(mine.how, 'term-in-material');
    assert.match(mine.from, /^material:content\/page\.md$/);
  });
});

test('the same word with nothing in the material that uses it still invalidates the answer', async () => {
  await withEnv(async (env) => {
    const { ing } = await victimRound(env, { how: 'read the form handler: the hidden honeypot field, the limits, the schema' });
    assert.deepEqual(ing.metaMentions, ['M-HONEYPOT: honeypot']);
    assert.ok(ing.reasons.includes('talks about the check itself'));
    assert.equal(ing.valid, false);
    assert.deepEqual(ing.metaIgnored, []);
  });
});

test('even with the word in the material, talking about planted errors still invalidates', async () => {
  await withEnv(async (env) => {
    const { ing } = await victimRound(env, { how: 'the honeypot field is fine, but one number in the plan was deliberately inserted', material: HONEY });
    assert.ok(ing.metaMentions.some((m) => m.startsWith('M-DELIB-INSERTED-EN')), JSON.stringify(ing.metaMentions));
    assert.ok(ing.reasons.includes('talks about the check itself'));
    assert.ok(ing.metaIgnored.some((x) => x.patternId === 'M-HONEYPOT' && x.name === 'answer.inspected[0].how'), 'the honeypot mention was excused, the other one was not');
  });
});

test('the engine keeps the source outputs of the round and the ingest log counts the excused mentions', async () => {
  await withEnv(async (env) => {
    const { r } = await victimRound(env, { how: 'read the honeypot field of the form', material: HONEY });
    const dir = path.join(roundDir(r.runDir, 1), 'source-text');
    assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length > 0, 'rounds/01/source-text has the outputs');
    const led = fs.readFileSync(path.join(r.runDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(led.some((l) => l.type === 'answer-ingested' && l.data.metaIgnored >= 1), 'answer-ingested logs metaIgnored');
    await drive(r.runDir, { script: loadScript() });
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Слов, похожих на разговор о проверке/, 'the report shows the excused words');
  });
});

/** A LARGE data file (over the 2 000 rows default) whose values are ordinary words of the trade: short cells only. */
function shopsCsv(n) {
  const out = ['id,shop,rating,product,note'];
  for (let i = 1; i <= n; i++) out.push(`r${i},Shop ${i} bv,"9,5",zonnepanelen panel,round 3`);
  return out.join(String.fromCharCode(10)) + String.fromCharCode(10);
}

test('a LARGE data file with a shop rating and short product words does not block the round; a prose trace still does, with the instructions', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, { mutateMaterial: (pr) => fs.writeFileSync(path.join(pr.material, 'shops.csv'), shopsCsv(2100)) });
    const ok = await cli(['step', r.runDir]);
    assert.notEqual(ok.payload?.decision, 'BLOCKED_TRACE', ok.text);
    assert.equal(ok.exitCode, 10, ok.text);
    // finish this round quickly with the fake agents, then add a trace to prose
    await drive(r.runDir, { script: loadScript() });
    const page = path.join(r.project.material, 'page.md');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('## Сроки', '## Сроки (round 3 notes)'));
    const blocked = await cli(['step', r.runDir]);
    assert.equal(blocked.exitCode, 20, blocked.text);
    assert.equal(blocked.payload.decision, 'BLOCKED_TRACE');
    const last = fs.readdirSync(path.join(r.runDir, 'rounds')).sort().pop();
    const todo = fs.readFileSync(path.join(r.runDir, 'rounds', last, 'todo.md'), 'utf8');
    assert.match(todo, /NEVER change the material/);
    assert.match(todo, /Ask the owner exactly this/);
    assert.match(todo, /round 3 notes/);
    assert.match(todo, /ask the owner the question at the end of the list/);
  });
});

test('the setup summary and the report say which data files got the reduced trace scan', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, { mutateMaterial: (pr) => fs.writeFileSync(path.join(pr.material, 'shops.csv'), shopsCsv(2100)) });
    const summary = fs.readFileSync(path.join(r.runDir, 'SETUP-SUMMARY.ru.md'), 'utf8');
    assert.match(summary, /Файлов с данными: 2\. Маленькие[^\n]*\(1\)/);
    assert.match(summary, /Больших файлов с данными: 1\. В них короткие значения[^\n]*не применяется правил: \d+/);
    assert.match(summary, /`content\/shops\.csv`: 2100 строк, коротких значений \d+ \(не всеми правилами\), длинных 0 \(всеми\)/);
    await drive(r.runDir, { script: loadScript() });
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Больших файлов с данными: 1\. В них короткие значения[^\n]*не применялось правил: \d+/);
    assert.match(md, /`content\/shops\.csv`: 2100 строк, коротких значений \d+ \(проверены не всеми правилами\), длинных 0 \(проверены всеми\)/);
  });
});
