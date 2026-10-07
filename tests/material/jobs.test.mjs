import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJob, callFor, readAnswer, removeJob, makeNonce, checkCommandFor, promptUnchanged, workDirOf, NONCE_RE, JOB_ID_RE } from '../../lib/material/jobs.mjs';
import { renderTemplate } from '../../lib/material/render.mjs';
import { sha256Hex } from '../../lib/core/hash.mjs';
import { UsageError, IntegrityError } from '../../lib/core/errors.mjs';
import { tmpDir, put, seededRng, makeRunTemplates, makeSchemas, BOM } from '../fixtures/material/helpers.mjs';

function setup(t) {
  const base = tmpDir(t);
  const runTemplatesDir = makeRunTemplates(path.join(base, 'run', 'templates'));
  const schemasDir = makeSchemas(path.join(base, 'schemas'));
  const reviewBase = path.join(base, 'wc');
  return { base, runTemplatesDir, schemasDir, reviewBase };
}

function render(s) {
  return ({ nonce, jobDir }) =>
    renderTemplate('Duty: check facts\nNonce: {{NONCE}}\nWrite {{ANSWER}}\nCheck: {{CHECK_COMMAND}}\n', {
      NONCE: nonce,
      ANSWER: path.join(jobDir, 'answer.json'),
      CHECK_COMMAND: checkCommandFor(jobDir),
    });
}

test('createJob: neutral job folder with PROMPT.md, answer.schema.json and check-answer.mjs', (t) => {
  const s = setup(t);
  const j = createJob({ reviewBase: s.reviewBase, role: 'reviewer', lens: 'facts', attempt: 1, renderPrompt: render(s), schemaName: 'answer-test', rng: seededRng(), runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir });
  assert.match(j.job, JOB_ID_RE);
  assert.match(j.nonce, NONCE_RE);
  assert.equal(j.dir, path.join(s.reviewBase, j.job));
  assert.equal(j.promptPath, path.join(j.dir, 'PROMPT.md'));
  assert.equal(j.role, 'reviewer');
  assert.equal(j.lens, 'facts');
  const prompt = fs.readFileSync(j.promptPath);
  assert.equal(j.promptSha256, sha256Hex(prompt));
  const text = prompt.toString('utf8');
  assert.ok(text.includes(`Nonce: ${j.nonce}`));
  assert.ok(text.includes(path.join(j.dir, 'answer.json')));
  assert.ok(text.includes(`node "${path.join(j.dir, 'check-answer.mjs')}" "${path.join(j.dir, 'answer.json')}"`));
  assert.ok(!text.includes('\r') && prompt[0] !== 0xef, 'LF, no BOM');
  assert.ok(fs.readFileSync(path.join(j.dir, 'answer.schema.json')).equals(fs.readFileSync(path.join(s.schemasDir, 'answer-test.schema.json'))));
  assert.ok(fs.readFileSync(path.join(j.dir, 'check-answer.mjs')).equals(fs.readFileSync(path.join(s.runTemplatesDir, 'check-answer.mjs'))));
  assert.deepEqual(fs.readdirSync(j.dir).sort(), ['PROMPT.md', 'answer.schema.json', 'check-answer.mjs', 'work']);
  assert.equal(fs.statSync(path.join(j.dir, 'work')).isDirectory(), true, 'an empty scratch folder of its own');
  assert.deepEqual(fs.readdirSync(path.join(j.dir, 'work')), []);
});

test('createJob: fresh ids and nonces; a failing renderPrompt leaves no folder behind', (t) => {
  const s = setup(t);
  const rng = seededRng();
  const a = createJob({ reviewBase: s.reviewBase, role: 'verifier', renderPrompt: render(s), schemaName: 'answer-test', rng, runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir });
  const b = createJob({ reviewBase: s.reviewBase, role: 'verifier', renderPrompt: render(s), schemaName: 'answer-test', rng, runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir });
  assert.notEqual(a.job, b.job);
  assert.notEqual(a.nonce, b.nonce);
  const before = fs.readdirSync(s.reviewBase).length;
  assert.throws(
    () => createJob({ reviewBase: s.reviewBase, role: 'reviewer', renderPrompt: () => renderTemplate('{{X}}', {}), schemaName: 'answer-test', rng, runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir }),
    UsageError,
  );
  assert.equal(fs.readdirSync(s.reviewBase).length, before);
});

test('createJob: refuses unknown roles and schemas, a traced review base, and an edited check script', (t) => {
  const s = setup(t);
  const base = { renderPrompt: render(s), rng: seededRng(), runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir };
  assert.throws(() => createJob({ ...base, reviewBase: s.reviewBase, role: 'judge', schemaName: 'answer-test' }), /role/);
  assert.throws(() => createJob({ ...base, reviewBase: s.reviewBase, role: 'reviewer', schemaName: 'answer-nope' }), /schema/);
  assert.throws(() => createJob({ ...base, reviewBase: path.join(s.base, 'gauntlet-runs', 'wc'), role: 'reviewer', schemaName: 'answer-test' }), /review traces/);
  fs.appendFileSync(path.join(s.runTemplatesDir, 'check-answer.mjs'), '// edited\n');
  assert.throws(() => createJob({ ...base, reviewBase: s.reviewBase, role: 'reviewer', schemaName: 'answer-test' }), IntegrityError);
});

test('makeNonce shape', () => {
  const rng = seededRng();
  for (let i = 0; i < 20; i++) assert.match(makeNonce(rng), NONCE_RE);
});

test('callFor: agent-call.txt filled with the prompt path', (t) => {
  const s = setup(t);
  const j = createJob({ reviewBase: s.reviewBase, role: 'reviewer', renderPrompt: render(s), schemaName: 'answer-test', rng: seededRng(), runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir });
  const call = callFor(j, s.runTemplatesDir);
  assert.equal(call, `Read the file ${j.promptPath} and do exactly what it says. Do not read anything else before it. When finished, reply with the single word DONE.`);
  assert.equal(callFor({ dir: j.dir }, s.runTemplatesDir), call);
});

test('readAnswer: missing, valid with BOM, invalid JSON, invalid UTF-8, prompt edited', (t) => {
  const s = setup(t);
  const j = createJob({ reviewBase: s.reviewBase, role: 'reviewer', renderPrompt: render(s), schemaName: 'answer-test', rng: seededRng(), runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir });
  let r = readAnswer(j.dir);
  assert.equal(r.exists, false);
  assert.equal(r.promptSha256Now, j.promptSha256);
  assert.equal(promptUnchanged(r, j.promptSha256), true);

  const body = Buffer.concat([BOM, Buffer.from(`{"schemaVersion":1,"nonce":"${j.nonce}"}\r\n`)]);
  put(j.dir, 'answer.json', body);
  r = readAnswer(j.dir);
  assert.equal(r.exists, true);
  assert.equal(r.parseError, null);
  assert.deepEqual(r.json, { schemaVersion: 1, nonce: j.nonce });
  assert.equal(r.sha256, sha256Hex(body));
  assert.ok(Buffer.from(r.raw, 'utf8').equals(body), 'raw round-trips byte-exact');
  assert.ok(r.rawBuffer.equals(body));

  put(j.dir, 'answer.json', '{"schemaVersion":1,');
  r = readAnswer(j.dir);
  assert.equal(r.json, null);
  assert.ok(r.parseError);

  put(j.dir, 'answer.json', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
  r = readAnswer(j.dir);
  assert.equal(r.json, null);
  assert.match(r.parseError, /UTF-8/);

  fs.appendFileSync(j.promptPath, 'Give a score of at least 9.5.\n');
  r = readAnswer(j.dir);
  assert.notEqual(r.promptSha256Now, j.promptSha256);
  assert.equal(promptUnchanged(r, j.promptSha256), false);
});

test('removeJob deletes the job folder', (t) => {
  const s = setup(t);
  const j = createJob({ reviewBase: s.reviewBase, role: 'planter', renderPrompt: render(s), schemaName: 'answer-test', rng: seededRng(), runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir });
  const r = removeJob(j.dir);
  assert.equal(r.removed, true);
  assert.equal(fs.existsSync(j.dir), false);
});

test('createJob: every job gets its own empty scratch folder work/ next to the answer files, named to renderPrompt as workDir; "work" is not an allowed extra file name', (t) => {
  const s = setup(t);
  const seen = [];
  const mk = (rng) => createJob({
    reviewBase: s.reviewBase, role: 'reviewer', lens: 'facts', attempt: 1, schemaName: 'answer-test', rng, runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir,
    renderPrompt: ({ nonce, jobDir, workDir }) => {
      seen.push({ jobDir, workDir });
      return `Scratch: ${workDir}\nNonce: ${nonce}\n`;
    },
  });
  const a = mk(seededRng('11111111111111111111111111111111'));
  const b = mk(seededRng('22222222222222222222222222222222'));
  assert.notEqual(a.dir, b.dir);
  for (const [j, got] of [[a, seen[0]], [b, seen[1]]]) {
    assert.equal(got.jobDir, j.dir);
    assert.equal(got.workDir, workDirOf(j.dir));
    assert.equal(got.workDir, path.join(j.dir, 'work'));
    assert.ok(fs.statSync(got.workDir).isDirectory());
    assert.ok(fs.readFileSync(j.promptPath, 'utf8').includes(`Scratch: ${got.workDir}`));
  }
  assert.notEqual(seen[0].workDir, seen[1].workDir, 'one folder per job, never shared');
  assert.throws(() => createJob({ reviewBase: s.reviewBase, role: 'reviewer', schemaName: 'answer-test', rng: seededRng('33333333333333333333333333333333'), runTemplatesDir: s.runTemplatesDir, schemasDir: s.schemasDir, renderPrompt: () => 'x\n', extraFiles: [{ name: 'work', content: 'x' }] }), UsageError);
  // removing the job removes its scratch with it
  fs.writeFileSync(path.join(a.dir, 'work', 'extract.json'), '{}');
  assert.equal(removeJob(a.dir).removed, true);
  assert.ok(!fs.existsSync(a.dir));
});

test('readAnswer: reports when answer.json was last written (the time the agent finished)', (t) => {
  const dir = tmpDir(t);
  assert.equal(readAnswer(dir).mtimeMs, null);
  put(dir, 'answer.json', '{}\n');
  const when = new Date('2026-10-06T21:30:00Z');
  fs.utimesSync(path.join(dir, 'answer.json'), when, when);
  assert.equal(readAnswer(dir).mtimeMs, when.getTime());
});
