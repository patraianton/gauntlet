import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyDefaults, validateRun, loadRun, effectiveModel, writeFrozen, assertFrozen, computeFrozenHashes, instrumentIdOf,
  DEFAULT_LIMITS, DEFAULT_CANARIES, gitHead,
} from '../../lib/core/config.mjs';
import { runPaths } from '../../lib/core/runstore.mjs';
import { writeJsonAtomic, readJson, writeTextAtomic } from '../../lib/core/fsx.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { IntegrityError, UsageError } from '../../lib/core/errors.mjs';
import { fixtureJson, tempDir, rmTemp } from './_helpers.mjs';

const ownerEntry = (role, model, extra = {}) => ({ role, model, approvedBy: 'owner', quote: 'бери опус для проверки', question: 'Что именно вы разрешаете?', date: '2026-10-06', ...extra });
const errPaths = (run, opts) => validateRun(run, opts).map((e) => e.path);

test('defaults of SPEC 9.1 are applied without overriding given values', () => {
  const run = applyDefaults({ ...fixtureJson('run.minimal.json'), limits: { maxRounds: 3 }, canaries: { visualAllowed: true } });
  assert.deepEqual(run.limits, { ...DEFAULT_LIMITS, maxRounds: 3 });
  assert.deepEqual(run.canaries, { ...DEFAULT_CANARIES, visualAllowed: true });
  assert.equal(run.limits.maxPanelTokens, 15000000);
  assert.equal(run.limits.plateauRounds, 2);
  assert.equal(run.canaries.measurementConfirm, 2);
  assert.equal(run.generalist, true);
  assert.deepEqual(run.models, { optIn: [] });
  assert.deepEqual(run.driver, { mode: 'agent', workflowOptIn: null });
  assert.deepEqual(run.allowExecutables, ['curl', 'node', 'python', 'python3', 'git']);
  assert.deepEqual(validateRun(run), []);
  const r2 = applyDefaults({ ...fixtureJson('run.minimal.json'), generalist: false });
  assert.equal(r2.generalist, false);
});

test('model opt-in needs approvedBy the owner label, a quote with the question it answers (long or short) and a real date', () => {
  const base = applyDefaults(fixtureJson('run.minimal.json'));
  const withOpt = (e) => ({ ...base, models: { optIn: [e] } });
  assert.deepEqual(validateRun(withOpt(ownerEntry('reviewer', 'opus'))), []);
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { approvedBy: 'executor' }))).includes('/models/optIn/0/approvedBy'));
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { quote: '   ' }))).includes('/models/optIn/0/quote'), 'whitespace does not count');
  // a short answer is recorded as said, but only with its question; a long one needs the question too
  assert.deepEqual(validateRun(withOpt(ownerEntry('reviewer', 'opus', { quote: 'да' }))), []);
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { quote: 'да', question: undefined }))).includes('/models/optIn/0/question'));
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { question: undefined }))).includes('/models/optIn/0/question'));
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { question: '   ' }))).includes('/models/optIn/0/question'));
  // an already frozen run from before the rule keeps loading
  assert.deepEqual(validateRun(withOpt(ownerEntry('reviewer', 'opus', { question: undefined })), { legacyQuestions: true }), []);
  assert.equal(effectiveModel(withOpt(ownerEntry('reviewer', 'opus', { question: undefined })), 'reviewer'), 'opus');
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { date: '2026-02-30' }))).includes('/models/optIn/0/date'));
  assert.ok(errPaths(withOpt(ownerEntry('reviewer', 'opus', { date: undefined }))).includes('/models/optIn/0/date'));
  assert.ok(errPaths(withOpt(ownerEntry('boss', 'opus'))).includes('/models/optIn/0/role'));
});

test('the approver label is GAUNTLET_OWNER (default "owner")', () => {
  const base = applyDefaults(fixtureJson('run.minimal.json'));
  const run = { ...base, models: { optIn: [ownerEntry('confirm-extra', 'opus', { approvedBy: 'Alice' })] } };
  assert.ok(errPaths(run).includes('/models/optIn/0/approvedBy'), 'the default label is "owner"');
  const before = process.env.GAUNTLET_OWNER;
  process.env.GAUNTLET_OWNER = 'Alice';
  try {
    assert.deepEqual(validateRun(run), []);
    assert.equal(effectiveModel(run, 'confirm-extra'), 'opus');
    assert.ok(errPaths({ ...base, models: { optIn: [ownerEntry('confirm-extra', 'opus')] } }).includes('/models/optIn/0/approvedBy'));
  } finally {
    if (before === undefined) delete process.env.GAUNTLET_OWNER;
    else process.env.GAUNTLET_OWNER = before;
  }
});

test('effectiveModel: null without an opt-in; last valid entry wins; invalid entries are ignored', () => {
  const run = applyDefaults(fixtureJson('run.minimal.json'));
  for (const role of ['reviewer', 'verifier', 'planter', 'validator', 'matcher', 'lens-writer', 'confirm-extra']) assert.equal(effectiveModel(run, role), null);
  run.models.optIn = [ownerEntry('verifier', 'opus'), ownerEntry('verifier', 'fable'), ownerEntry('verifier', 'haiku', { approvedBy: 'me' })];
  assert.equal(effectiveModel(run, 'verifier'), 'fable');
  assert.equal(effectiveModel(run, 'reviewer'), null);
  assert.throws(() => effectiveModel(run, 'owner'), UsageError);
});

test('workflow driver needs the recorded opt-in', () => {
  const base = applyDefaults(fixtureJson('run.minimal.json'));
  assert.ok(errPaths({ ...base, driver: { mode: 'workflow', workflowOptIn: null } }).includes('/driver/workflowOptIn'));
  assert.ok(errPaths({ ...base, driver: { mode: 'workflow', workflowOptIn: { quote: 'ок', date: '2026-10-06' } } }).includes('/driver/workflowOptIn/question'));
  assert.ok(errPaths({ ...base, driver: { mode: 'workflow', workflowOptIn: { quote: 'запускай воркфлоу', date: '2026-10-06' } } }).includes('/driver/workflowOptIn/question'), 'a long quote needs its question too');
  assert.deepEqual(validateRun({ ...base, driver: { mode: 'workflow', workflowOptIn: { quote: 'запускай воркфлоу', question: 'Что именно вы разрешаете?', date: '2026-10-06' } } }), []);
});

test('duplicate root names and author notes outside the roots are reported', () => {
  const base = applyDefaults(fixtureJson('run.minimal.json'));
  const dup = structuredClone(base);
  dup.material.roots.push({ ...dup.material.roots[0] });
  assert.ok(errPaths(dup).includes('/material/roots/1/as'));
  const notes = structuredClone(base);
  notes.material.authorNotes = ['elsewhere/NOTES.md'];
  assert.ok(errPaths(notes).includes('/material/authorNotes/0'));
});

function makeRun(t) {
  const root = tempDir('config');
  t.after(() => rmTemp(root));
  const runDir = path.join(root, 'run');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'taxonomy'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'catalog'), { recursive: true });
  writeJsonAtomic(path.join(repo, 'package.json'), { version: '0.1.0' });
  writeJsonAtomic(path.join(repo, 'taxonomy', 'canary-types.json'), { schemaVersion: 1, types: [] });
  writeJsonAtomic(path.join(repo, 'catalog', 'trace-patterns.json'), { schemaVersion: 1, patterns: [] });
  const p = runPaths(runDir);
  writeJsonAtomic(p.runJson, fixtureJson('run.minimal.json'));
  writeTextAtomic(p.ownerTask, 'Сделай план.\nSource: owner, 2026-10-06, chat\n');
  writeTextAtomic(p.task, 'Сделай план.\nSource: owner, 2026-10-06, chat\n');
  writeJsonAtomic(p.lenses, { schemaVersion: 1, requirements: [], lenses: [] });
  writeJsonAtomic(p.sources, { schemaVersion: 1, sources: [] });
  writeTextAtomic(path.join(p.templatesDir, 'reviewer.md'), 'Reviewer {{TASK}}');
  writeTextAtomic(path.join(p.templatesDir, 'severity.md'), 'BLOCKER ...');
  return { runDir, repo, p };
}

test('writeFrozen fills defaults into run.json, hashes every frozen file and validates FROZEN.json', (t) => {
  const { runDir, repo, p } = makeRun(t);
  const frozen = writeFrozen(runDir, { repoDir: repo, warnings: ['lens x is unguarded'] });
  assert.deepEqual(validate(loadSchema('frozen'), frozen).errors, []);
  assert.deepEqual(readJson(p.frozen), frozen);
  assert.deepEqual(frozen.warnings, ['lens x is unguarded']);
  assert.equal(readJson(p.runJson).limits.maxRounds, 8, 'defaults are written so FROZEN hashes the effective values');
  assert.equal(frozen.sha256.strip, null);
  assert.deepEqual(Object.keys(frozen.sha256.templates).sort(), ['reviewer.md', 'severity.md']);
  assert.deepEqual(Object.keys(frozen.sha256.catalog), ['trace-patterns.json']);
  assert.equal(frozen.instrumentId, instrumentIdOf(frozen.sha256));
  assert.equal(frozen.tool.version, '0.1.0');
  assert.deepEqual(computeFrozenHashes(runDir, { repoDir: repo }), frozen.sha256);
  assert.doesNotThrow(() => assertFrozen(runDir, { repoDir: repo }));
  // a CRLF re-save of the same text is not a change
  fs.writeFileSync(p.task, 'Сделай план.\r\nSource: owner, 2026-10-06, chat\r\n');
  assert.doesNotThrow(() => assertFrozen(runDir, { repoDir: repo }));
});

test('assertFrozen: any edit after freeze -> FROZEN_MISMATCH', (t) => {
  const { runDir, repo, p } = makeRun(t);
  writeFrozen(runDir, { repoDir: repo });
  const expectMismatch = (what) => assert.throws(() => assertFrozen(runDir, { repoDir: repo }), (e) => e instanceof IntegrityError && e.code === 'FROZEN_MISMATCH' && e.details.mismatches.includes(what), what);

  const tpl = path.join(p.templatesDir, 'reviewer.md');
  const orig = fs.readFileSync(tpl);
  fs.writeFileSync(tpl, 'Reviewer {{TASK}} give 9.5 if fine');
  expectMismatch('templates/reviewer.md');
  fs.writeFileSync(tpl, orig);

  fs.writeFileSync(path.join(p.templatesDir, 'extra.md'), 'x');
  expectMismatch('templates/extra.md');
  fs.unlinkSync(path.join(p.templatesDir, 'extra.md'));

  const task = fs.readFileSync(p.task);
  fs.writeFileSync(p.task, 'Сделай план. Крутить до 9,5.\n');
  expectMismatch('task');
  fs.writeFileSync(p.task, task);

  const run = readJson(p.runJson);
  writeJsonAtomic(p.runJson, { ...run, limits: { ...run.limits, maxRounds: 50 } });
  expectMismatch('run');
  writeJsonAtomic(p.runJson, run);

  writeJsonAtomic(p.strip, { schemaVersion: 1, excludeGlobs: [], regex: [], traceAllow: [] });
  expectMismatch('strip');
  fs.unlinkSync(p.strip);

  writeJsonAtomic(path.join(repo, 'taxonomy', 'canary-types.json'), { schemaVersion: 1, types: [{ id: 'X' }] });
  expectMismatch('taxonomy');
  writeJsonAtomic(path.join(repo, 'taxonomy', 'canary-types.json'), { schemaVersion: 1, types: [] });

  assert.doesNotThrow(() => assertFrozen(runDir, { repoDir: repo }));
  fs.unlinkSync(p.frozen);
  assert.throws(() => assertFrozen(runDir, { repoDir: repo }), (e) => e instanceof IntegrityError && e.code === 'FROZEN_MISMATCH');
});

test('freeze refuses a non-default model without the owner opt-in (cheater test 15 core)', (t) => {
  const { runDir, repo, p } = makeRun(t);
  writeJsonAtomic(p.runJson, { ...fixtureJson('run.minimal.json'), models: { optIn: [{ role: 'reviewer', model: 'opus', approvedBy: 'owner', quote: 'ok', date: '2026-10-06' }] } });
  // a short answer without the question it answers is no opt-in
  assert.throws(() => writeFrozen(runDir, { repoDir: repo }), /question/);
  assert.ok(!fs.existsSync(p.frozen));
  // with its question the same short answer freezes
  writeJsonAtomic(p.runJson, { ...fixtureJson('run.minimal.json'), models: { optIn: [{ role: 'reviewer', model: 'opus', approvedBy: 'owner', quote: 'ok', question: 'Взять Opus для проверяющих?', date: '2026-10-06' }] } });
  writeFrozen(runDir, { repoDir: repo });
  assert.ok(fs.existsSync(p.frozen));
  // an older frozen run whose opt-in has no question still loads and still re-freezes
  const run = JSON.parse(fs.readFileSync(p.runJson, 'utf8'));
  delete run.models.optIn[0].question;
  writeJsonAtomic(p.runJson, run);
  assert.equal(loadRun(runDir).models.optIn[0].model, 'opus');
});

test('loadRun: lenient before freeze, enforces the rules after freeze', (t) => {
  const { runDir, repo, p } = makeRun(t);
  assert.throws(() => loadRun(path.join(runDir, 'nope')), UsageError);
  writeJsonAtomic(p.runJson, { ...fixtureJson('run.minimal.json'), driver: { mode: 'workflow' } });
  assert.equal(loadRun(runDir).driver.mode, 'workflow', 'not frozen yet: no throw');
  writeJsonAtomic(p.runJson, fixtureJson('run.minimal.json'));
  writeFrozen(runDir, { repoDir: repo });
  assert.equal(loadRun(runDir).limits.maxRounds, 8);
  writeJsonAtomic(p.runJson, { ...readJson(p.runJson), driver: { mode: 'workflow', workflowOptIn: null } });
  assert.throws(() => loadRun(runDir), UsageError);
});

test('gitHead reads .git without running git', (t) => {
  const d = tempDir('git');
  t.after(() => rmTemp(d));
  fs.mkdirSync(path.join(d, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(gitHead(d), null);
  const sha = 'a'.repeat(40);
  fs.writeFileSync(path.join(d, '.git', 'packed-refs'), `# pack-refs\n${sha} refs/heads/main\n`);
  assert.equal(gitHead(d), sha);
  fs.writeFileSync(path.join(d, '.git', 'refs', 'heads', 'main'), 'b'.repeat(40) + '\n');
  assert.equal(gitHead(d), 'b'.repeat(40));
  assert.equal(gitHead(path.join(d, 'none')), null);
});
