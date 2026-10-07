// Bug 11 through the whole engine: a reviewer finding that quotes the planted text, which the matcher
// does not recognise, must not become a real problem, must count as a catch, and the disagreement
// between the program and the matcher is written in the round, the ledger and the Russian report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../../lib/engine/audit.mjs';
import { withEnv, fixRun, cli, roundDir, readJsonFile, ledgerOf, clustersOf } from '../fixtures/engine/helpers.mjs';

// The reviewer's own words carry no changed number or word, so code alone does not decide and the matcher is asked.
const bland = (rec, ans) =>
  rec.role === 'reviewer'
    ? { ...ans, findings: (ans.findings || []).map((f) => ({ ...f, problem: 'This line reads strangely and a careful reader may stumble on it.', fix: 'Reword the line.', seen: undefined, missingWhat: undefined })) }
    : ans;
// A matcher that does not recognise anything.
const blind = (alsoReal) => (rec, ans) => (rec.role === 'matcher' ? { ...ans, pairs: ans.pairs.map((p) => ({ ...p, score: 1, alsoReal })) } : ans);
const chain = (...fns) => (rec, ans) => fns.reduce((a, fn) => fn(rec, a), ans);

const planted = (key) => key.canaries.filter((c) => c.after && !String(c.after).startsWith('sha256:'));
const leaked = (r, key) => planted(key).filter((c) => clustersOf(r.runDir).some((x) => String(x.quote || '').includes(c.after.slice(0, 20)))).map((c) => c.canary);

test('a matcher that recognises nothing: the planted text still never becomes a real problem, recall counts it, the report says so', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: chain(bland, blind(false)) });
    const rd = roundDir(r.runDir, 1);
    const key = readJsonFile(path.join(rd, 'canaries.json'));
    const det = readJsonFile(path.join(rd, 'detections.json')).detections;
    const round = readJsonFile(path.join(rd, 'round.json'));

    // nothing the reviewers quoted from the planted text is in the real problems
    assert.deepEqual(leaked(r, key), [], 'no planted sentence among the clusters');
    const todo = fs.readFileSync(path.join(rd, 'todo.md'), 'utf8');
    for (const c of planted(key)) assert.ok(!todo.includes(c.after), `the to-do of the window does not carry the planted text of ${c.canary}`);

    // recall: the catches are counted, and marked as the code's own
    const viaCode = det.filter((d) => d.crossCheck);
    assert.ok(viaCode.length >= 2, `code catches recorded: ${viaCode.length}`);
    for (const d of viaCode) {
      assert.equal(d.stage, 'code');
      assert.ok(['caught', 'seen_underclassified'].includes(d.outcome));
    }
    assert.ok(det.some((d) => d.crossCheck && d.outcome === 'caught'));

    // the disagreement is in the round and in the ledger
    assert.ok(round.crossCheck.hits.length >= viaCode.length);
    assert.ok(round.crossCheck.hits.every((h) => h.matcher === 'low' && h.matcherScore === 1));
    const match = ledgerOf(r.runDir).filter((l) => l.type === 'match' && l.round === 1 && l.data.codeVsMatcher);
    assert.ok(match.length >= 1, 'the match event carries the disagreement');
    assert.ok(match.flatMap((m) => m.data.codeVsMatcher.hits).length >= viaCode.length);
    for (const id of round.crossCheck.hits.map((h) => h.id)) assert.ok(round.matchedFindings.includes(id), `${id} was removed from the real problems`);

    // the integrity audit replays the gate and the ledger and still passes
    const a = audit(r.runDir, {}, { record: false });
    assert.deepEqual(a.checks.filter((c) => !c.ok), []);
    assert.ok(a.checks.some((c) => c.id === 'gate'));

    // the owner reads it in plain Russian
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Программа сама сверила замечания с текстом подложенных ошибок\. Замечаний, где проверяющий процитировал именно подложенное место, а помощник, сопоставляющий замечания с подложенными ошибками, их не признал: \d+\./);
    assert.match(md, /засчитаны как найденные подложенные ошибки и в список проблем не попали: `[a-z0-9]+#\d+ \(ошибка C\d+\)`/);

    // the planted text never reached a reviewer (the matcher and the verifiers legitimately see it)
    const reviewerJobs = readJsonFile(path.join(rd, 'jobs.json')).jobs.filter((j) => j.role === 'reviewer').map((j) => j.job);
    assert.ok(reviewerJobs.length >= 4);
    const prompts = reviewerJobs.map((j) => fs.readFileSync(path.join(rd, 'prompts', `${j}.md`), 'utf8')).join('\n');
    for (const c of planted(key)) assert.ok(!prompts.includes(c.after), `the prompts do not carry the planted text of ${c.canary}`);
  });
});

test('when the matcher itself says "a different real problem on that line", the finding stays real and the disagreement is shown', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: chain(bland, blind(true)) });
    const rd = roundDir(r.runDir, 1);
    const round = readJsonFile(path.join(rd, 'round.json'));
    assert.ok(round.crossCheck.keptReal.length >= 1, 'recorded');
    assert.deepEqual(round.crossCheck.hits, []);
    for (const k of round.crossCheck.keptReal) assert.ok(!round.matchedFindings.includes(k.id), 'kept among the real problems, as the matcher decided');
    const det = readJsonFile(path.join(rd, 'detections.json')).detections;
    assert.ok(det.every((d) => !d.crossCheck), 'recall is not raised where the matcher kept the finding real');
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Программа и помощник, сопоставляющий замечания, разошлись в оценке замечаний: \d+\./);
    assert.match(md, /Они оставлены среди настоящих проблем, как решил помощник/);
  });
});

test('a normal round (matcher agrees) writes no disagreement anywhere', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: bland });
    const rd = roundDir(r.runDir, 1);
    assert.equal(readJsonFile(path.join(rd, 'round.json')).crossCheck, undefined);
    assert.ok(ledgerOf(r.runDir).filter((l) => l.type === 'match').every((m) => m.data.codeVsMatcher === undefined));
    const rep = await cli(['report', r.runDir]);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.doesNotMatch(md, /Программа сама сверила замечания/);
  });
});
