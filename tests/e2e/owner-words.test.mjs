// The owner's words (night 06-07.10.2026): every owner decision records the question it answers,
// and one quote reused for a decision of another kind is flagged in the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withEnv, fixRun, freshRun, cli, readJsonFile } from '../fixtures/engine/helpers.mjs';

const QUOTE = 'Я включил тебе ультракод режима, давай просто быстро всё делай, не жалей токенов.';
const Q1 = 'Нужно поднять число кругов до двенадцати. Можно?';

test('every owner decision needs --question; a narrowing amend too; the report flags one quote used for two kinds', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    // a decision without the question is refused, a long quote or not
    const no = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxRounds=12', '--owner-quote', QUOTE]);
    assert.equal(no.exitCode, 4, no.text);
    assert.match(no.payload.error.message, /--question/);
    assert.equal(readJsonFile(path.join(r.runDir, 'run.json')).limits?.maxRounds === 12, false, 'nothing was changed');
    // the question must be a real question, not the answer again
    const same = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxRounds=12', '--owner-quote', QUOTE, '--question', QUOTE]);
    assert.equal(same.exitCode, 4, same.text);
    const ok = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxRounds=12', '--owner-quote', QUOTE, '--question', Q1]);
    assert.equal(ok.exitCode, 0, ok.text);

    // a narrowing amend of the sources: no question -> refused; with it -> recorded as another kind of decision
    const src = readJsonFile(path.join(r.runDir, 'sources.json'));
    src.sources[0].notes = 'Changed after round 1.';
    const f = path.join(env.workspace, 'sources-narrow.json');
    fs.writeFileSync(f, JSON.stringify(src));
    const a0 = await cli(['amend', r.runDir, '--what', 'sources', '--file', f, '--reason', 'new notes', '--owner-quote', QUOTE]);
    assert.equal(a0.exitCode, 4, a0.text);
    assert.match(a0.payload.error.message, /--question/);
    const a1 = await cli(['amend', r.runDir, '--what', 'sources', '--file', f, '--reason', 'new notes', '--owner-quote', QUOTE, '--question', 'Можно ли поменять заметки первоисточника?']);
    assert.equal(a1.exitCode, 0, a1.text);
    const od = readJsonFile(path.join(r.runDir, 'owner-decisions.json')).decisions;
    assert.deepEqual(od.map((d) => [d.id, d.kind, d.question]), [['O1', 'raise-limit', Q1], ['O2', 'amend', 'Можно ли поменять заметки первоисточника?']]);

    // an amend that narrows nothing needs no quote and no question
    const wide = readJsonFile(path.join(r.runDir, 'sources.json'));
    const f2 = path.join(env.workspace, 'sources-same.json');
    fs.writeFileSync(f2, JSON.stringify(wide));
    const a2 = await cli(['amend', r.runDir, '--what', 'sources', '--file', f2, '--reason', 'nothing changes']);
    assert.equal(a2.exitCode, 0, a2.text);

    await cli(['report', r.runDir]);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Одна и та же цитата использована для разных решений: O1 \(Вы подняли лимит\), O2 \(Вы разрешили изменить настройки проверки: первоисточники\)/);
    assert.match(md, new RegExp(`На вопрос: .*${Q1.slice(0, 20)}`));
    const sum = await cli(['report', r.runDir, '--summary']);
    assert.match(sum.text, /Одна и та же цитата для разных решений: 1/);
  });
});

test('the other owner commands also refuse a quote without its question (waive, continue, abort, templates)', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const stop = await cli(['owner', r.runDir, '--kind', 'stop', '--owner-quote', 'стоп, покажи что осталось', '--question', 'Остановить проверку сейчас?']);
    assert.equal(stop.exitCode, 30, stop.text);
    for (const argv of [
      ['waive', r.runDir, '--cluster', 'C-01-03', '--owner-quote', 'дату в седьмом посте оставь, это другая акция'],
      ['owner', r.runDir, '--kind', 'continue', '--owner-quote', 'продолжай без седьмого поста'],
      ['abort', r.runDir, '--reason', 'owner stops', '--owner-quote', 'бросай этот запуск, план меняется'],
      ['templates', 'approve', '--owner-quote', 'да, эти шаблоны одобряю'],
    ]) {
      const x = await cli(argv);
      assert.equal(x.exitCode, 4, `${argv[0]}: ${x.text}`);
      assert.match(x.payload.error.message, /--question/, argv[0]);
    }
    assert.equal(readJsonFile(path.join(r.runDir, 'owner-decisions.json')).decisions.length, 1, 'only the stop was recorded');
  });
});

test('abort without words: only a run still in setup with nothing open (what SKILL.md and never.md say); the texts match the code', async () => {
  await withEnv(async (env) => {
    // setup stage, no round has run, nothing open: allowed
    const fresh = await freshRun(env);
    const ok = await cli(['abort', fresh.runDir, '--reason', 'a source file appeared after init']);
    assert.equal(ok.exitCode, 0, ok.text);
  });
  await withEnv(async (env) => {
    // after a round with serious problems open: refused, and the text of the refusal says why
    const r = await fixRun(env);
    const no = await cli(['abort', r.runDir, '--reason', 'owner changed the plan']);
    assert.equal(no.exitCode, 4, no.text);
    assert.match(no.payload.error.message, /only the owner may end it/);
  });
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const skill = fs.readFileSync(path.join(root, 'skill', 'gauntlet', 'SKILL.md'), 'utf8');
  const never = fs.readFileSync(path.join(root, 'skill', 'gauntlet', 'reference', 'never.md'), 'utf8');
  const flat = (t) => t.replace(/\s+/g, ' ');
  // both texts name the same condition the code checks, and neither promises a wordless abort elsewhere
  for (const [name, t] of [['SKILL.md', skill], ['never.md', never]]) {
    assert.match(flat(t), /no round has run/, name);
    assert.match(flat(t), /(stopped on a plateau, a limit or an inconclusive panel)/, name);
    assert.match(flat(t), /unverified or contested/, name);
  }
  assert.doesNotMatch(flat(skill), /start a new run once the file exists\. If a source file only appears/);
  // the dispatcher rule is in both texts, with the exact label the dispatcher uses
  for (const [name, t] of [['SKILL.md', skill], ['never.md', never]]) {
    assert.ok(t.includes('[Dispatcher, not the owner]'), name);
    assert.match(flat(t), /never record (its|their) text as the owner's words/, name);
  }
  // the night's lessons are in the never-list
  for (const re of [/paid service/, /permissions. deny/, /rewrite the material's values/, /reuse one quote of the owner's for a different decision/, /point a primary source at something you change yourself/]) {
    assert.match(flat(never), re, String(re));
  }
});

test('restore-best, step --owner-quote and init --supersede also refuse a quote without its question', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const rb = await cli(['restore-best', r.runDir, '--to', path.join(env.workspace, 'restore-target'), '--owner-quote', 'верни лучшую версию, она была лучше']);
    assert.equal(rb.exitCode, 4, rb.text);
    assert.match(rb.payload.error.message, /--question/);
    const ab = await cli(['abort', r.runDir, '--reason', 'owner stops']);
    assert.equal(ab.exitCode, 4, ab.text);
    // the refusal says what to add, with the question named
    assert.match(ab.payload.error.message, /--owner-quote "<the owner's words>" --question "<the exact question you asked the owner>"/);
  });
});

test('a limit or a model opt-in written by hand into run.json needs its question, whatever the length of the quote', async () => {
  await withEnv(async (env) => {
    const fresh = await freshRun(env);
    const p = path.join(fresh.runDir, 'run.json');
    const run = readJsonFile(p);
    run.limits = { ...(run.limits || {}), maxRounds: 12 };
    run.limitsOptIn = { approvedBy: 'owner', quote: 'Я включил тебе ультракод режима, не жалей токенов.', date: '2026-10-07' };
    fs.writeFileSync(p, JSON.stringify(run));
    const no = await cli(['step', fresh.runDir]);
    assert.equal(no.exitCode, 4, no.text);
    assert.match(no.payload.error.message, /\/limitsOptIn\/question is required/);
    run.limitsOptIn.question = Q1;
    fs.writeFileSync(p, JSON.stringify(run));
    const ok = await cli(['step', fresh.runDir]);
    assert.notEqual(ok.exitCode, 4, ok.text);
  });
});

test('the texts say the same as the code: every command example carries --question, the dispatcher rule is exact, no message calls the question optional', () => {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
  const flat = (t) => t.replace(/\s+/g, ' ');
  // a command example is a code span or line that shows the option with a placeholder after it
  const example = /--owner-quote (?:"<|<)/;
  for (const file of [['README.md'], ['docs', 'reference.md'], ['skill', 'gauntlet', 'SKILL.md'], ['docs', 'runbook.md']]) {
    const text = read(...file);
    for (const line of text.split('\n')) {
      if (!example.test(line)) continue;
      // the placeholder form is documented once per command: on the same line or the continuation line
      const at = text.indexOf(line);
      const window = text.slice(at, at + line.length + 120).split('\n').slice(0, 2).join(' ');
      assert.ok(/--question/.test(window), `${file.join('/')}: an example with --owner-quote and no --question: ${line.trim().slice(0, 140)}`);
    }
  }
  // no stale wording in the code or the docs: the question is not for short answers only
  for (const file of [['lib', 'engine', 'setup.mjs'], ['lib', 'core', 'owner.mjs'], ['skill', 'gauntlet', 'SKILL.md'], ['docs', 'SPEC.md'], ['docs', 'runbook.md']]) {
    const t = flat(read(...file));
    assert.doesNotMatch(t, /when the owner's answer is short/, file.join('/'));
    assert.doesNotMatch(t, /`question` is required when the owner's answer is short/, file.join('/'));
    assert.doesNotMatch(t, /only a quote shorter than 10 characters/, file.join('/'));
  }
  // the dispatcher rule of the regulation, in both texts
  for (const file of [['skill', 'gauntlet', 'SKILL.md'], ['skill', 'gauntlet', 'reference', 'never.md']]) {
    const t = flat(read(...file));
    assert.match(t, /answers only operational questions/, file.join('/'));
    assert.match(t, /never supplies owner words/, file.join('/'));
    assert.match(t, /(notifies the owner and waits)/, file.join('/'));
  }
});
