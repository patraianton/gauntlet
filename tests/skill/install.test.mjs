// P6 tests: install/install.mjs (SPEC 18.3, 21.1 P6). Every test runs against a temporary
// GAUNTLET_INSTALL_ROOT; the real user home is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, removeIncludeText, INCLUDE_LINE, INCLUDE_HEADING } from '../../install/install.mjs';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REPO_FWD = REPO.split(path.sep).join('/');
const STAMP = '20260115';
const SKILL_FILES = ['SKILL.md', 'reference/agent-mode.md', 'reference/never.md', 'reference/workflow-mode.md'];
const BOM = '﻿';

function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** A fake user home shaped like a real user's: main ~/.claude, extra Claude homes with junctioned skills. */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-install-'));
  const w = (rel, content) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('.claude/skills/other-skill/SKILL.md', '---\nname: other\n---\n');
  w('.claude/rules/other.md', '# other rule\n');
  w('.claude/CLAUDE.md', '# Main\r\n@~/.claude/rules/other.md\r\n');
  w('.claude/settings.json', '{"env":{}}\n');
  // 1-a: skills is a junction to the main skills; LF CLAUDE.md
  w('claude-homes/1-a/CLAUDE.md', '# Home A\n\n@~/.claude/rules/other.md\n');
  w('claude-homes/1-a/settings.json', '{}\n');
  linkDir(path.join(root, '.claude', 'skills'), path.join(root, 'claude-homes', '1-a', 'skills'));
  // 2-b: separate real skills folder; CLAUDE.md with BOM and no trailing newline
  w('claude-homes/2-b/skills/mine/SKILL.md', 'x\n');
  w('claude-homes/2-b/CLAUDE.md', `${BOM}# Home B\n@~/.claude/rules/other.md`);
  // 3-c: junction, no CLAUDE.md
  w('claude-homes/3-c/settings.json', '{}\n');
  linkDir(path.join(root, '.claude', 'skills'), path.join(root, 'claude-homes', '3-c', 'skills'));
  // 4-d: include already present
  w('claude-homes/4-d/CLAUDE.md', `# Home D\n${INCLUDE_LINE}\n`);
  // not homes
  w('claude-homes/secrets/key.txt', 'secret\n');
  w('claude-homes/CLAUDE.md', '# accounts root file, not a home\n');
  return root;
}

/** rel -> content hash (files) or link target (links). Does not follow links. */
function tree(root) {
  const out = {};
  const visit = (rel) => {
    const abs = path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const p = path.join(root, r);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `LINK:${path.resolve(path.dirname(p), fs.readlinkSync(p))}`;
      else if (st.isDirectory()) { out[`${r}/`] = 'DIR'; visit(r); }
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  visit('');
  return out;
}

function run(root, argv) {
  const lines = [];
  const code = main(argv, { GAUNTLET_INSTALL_ROOT: root, GAUNTLET_CLAUDE_HOMES_DIR: 'claude-homes', GAUNTLET_INSTALL_DATE: STAMP }, (s) => lines.push(...String(s).split('\n')));
  return { code, lines, text: lines.join('\n') };
}

/** Parse "VERB    <target> — why" lines into [verb, target relative to root]. */
function actions(root, lines) {
  return lines
    .map((l) => /^([A-Z]+)\s+(.+?) — /.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], path.relative(root, m[2]).split(path.sep).join('/')]);
}

const P = (...parts) => parts.join('/');

test('dry run lists the exact actions and changes nothing', () => {
  const root = makeRoot();
  try {
    const before = tree(root);
    const r = run(root, []);
    assert.equal(r.code, 0);
    assert.deepEqual(tree(root), before, 'dry run changed files');
    assert.match(r.text, /DRY RUN/);
    const bak = (f) => `${f}.bak-${STAMP}-gauntlet`;
    const expected = [
      ['SKIP', 'claude-homes/1-a/skills'],
      ['SKIP', 'claude-homes/3-c/skills'],
      ['SKIP', 'claude-homes/4-d/skills'],
      ...SKILL_FILES.map((f) => ['WRITE', P('.claude/skills/gauntlet', f)]),
      ...SKILL_FILES.map((f) => ['WRITE', P('claude-homes/2-b/skills/gauntlet', f)]),
      ['WRITE', '.claude/rules/gauntlet.md'],
      ['BACKUP', bak('.claude/CLAUDE.md')],
      ['APPEND', '.claude/CLAUDE.md'],
      ['BACKUP', bak('claude-homes/1-a/CLAUDE.md')],
      ['APPEND', 'claude-homes/1-a/CLAUDE.md'],
      ['BACKUP', bak('claude-homes/2-b/CLAUDE.md')],
      ['APPEND', 'claude-homes/2-b/CLAUDE.md'],
      ['SKIP', 'claude-homes/3-c/CLAUDE.md'],
      ['SKIP', 'claude-homes/4-d/CLAUDE.md'],
    ];
    assert.deepEqual(actions(root, r.lines), expected);
    assert.match(r.text, /main CLAUDE|~\/\.claude: .*CRLF kept/);
    assert.match(r.text, /15 change\(s\) planned\. Re-run with --apply/);
    assert.ok(!/settings\.json/.test(r.text), 'settings.json never mentioned');
    assert.ok(!/secrets/.test(r.text), 'non-home folder ignored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--apply installs, is idempotent, then --uninstall restores byte-identical files', () => {
  const root = makeRoot();
  try {
    const before = tree(root);
    const settingsBefore = fs.readFileSync(path.join(root, '.claude', 'settings.json'));

    let r = run(root, ['--apply']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /15 change\(s\) made/);

    // skill: once in the main folder (visible through the junctions) and once in 2-b
    for (const base of ['.claude/skills/gauntlet', 'claude-homes/2-b/skills/gauntlet']) {
      for (const f of SKILL_FILES) {
        const text = fs.readFileSync(path.join(root, ...base.split('/'), ...f.split('/')), 'utf8');
        assert.ok(!text.includes('{{GAUNTLET_REPO}}'), `${base}/${f} still has a placeholder`);
        assert.ok(text.charCodeAt(0) !== 0xfeff, 'no BOM');
      }
    }
    const skill = fs.readFileSync(path.join(root, '.claude', 'skills', 'gauntlet', 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(`node "${REPO_FWD}/bin/gauntlet.mjs"`), 'repo path substituted');
    assert.match(skill, /^---\nname: gauntlet\n/);
    assert.ok(fs.existsSync(path.join(root, 'claude-homes', '1-a', 'skills', 'gauntlet', 'SKILL.md')), 'visible through the junction');

    // rule
    assert.equal(
      fs.readFileSync(path.join(root, '.claude', 'rules', 'gauntlet.md'), 'utf8'),
      fs.readFileSync(path.join(REPO, 'rules', 'gauntlet.md'), 'utf8'),
    );

    // includes: line endings and BOM preserved
    const main = fs.readFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'utf8');
    assert.equal(main, `# Main\r\n@~/.claude/rules/other.md\r\n\r\n${INCLUDE_HEADING}\r\n${INCLUDE_LINE}\r\n`);
    const a = fs.readFileSync(path.join(root, 'claude-homes', '1-a', 'CLAUDE.md'), 'utf8');
    assert.equal(a, `# Home A\n\n@~/.claude/rules/other.md\n\n${INCLUDE_HEADING}\n${INCLUDE_LINE}\n`);
    const b = fs.readFileSync(path.join(root, 'claude-homes', '2-b', 'CLAUDE.md'));
    assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
    assert.ok(b.toString('utf8').endsWith(`@~/.claude/rules/other.md\n${INCLUDE_HEADING}\n${INCLUDE_LINE}\n`));
    assert.ok(!fs.existsSync(path.join(root, 'claude-homes', '3-c', 'CLAUDE.md')), 'no CLAUDE.md created in an extra home');
    assert.equal(fs.readFileSync(path.join(root, 'claude-homes', '4-d', 'CLAUDE.md'), 'utf8'), `# Home D\n${INCLUDE_LINE}\n`);

    // backups
    assert.equal(
      fs.readFileSync(path.join(root, '.claude', `CLAUDE.md.bak-${STAMP}-gauntlet`), 'utf8'),
      '# Main\r\n@~/.claude/rules/other.md\r\n',
    );
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), settingsBefore, 'settings.json untouched');

    // idempotent
    const afterFirst = tree(root);
    r = run(root, ['--apply']);
    assert.equal(r.code, 0);
    assert.match(r.text, /0 change\(s\) made/);
    assert.deepEqual(tree(root), afterFirst);

    // uninstall dry run changes nothing
    r = run(root, ['--uninstall', '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.text, /DRY RUN/);
    assert.deepEqual(tree(root), afterFirst);

    // uninstall
    // uninstall without --apply is a dry run too
    r = run(root, ['--uninstall']);
    assert.equal(r.code, 0);
    assert.match(r.text, /DRY RUN/);
    assert.deepEqual(tree(root), afterFirst);

    // uninstall
    r = run(root, ['--uninstall', '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(tree(root), before, 'uninstall restores the exact original tree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing different file is backed up once per day and restored on uninstall', () => {
  const root = makeRoot();
  try {
    const old = path.join(root, '.claude', 'skills', 'gauntlet', 'SKILL.md');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, '---\nname: gauntlet\n---\nold hand-made draft\n');
    const before = tree(root);
    let r = run(root, ['--apply']);
    assert.equal(r.code, 0);
    const bak = `${old}.bak-${STAMP}-gauntlet`;
    assert.equal(fs.readFileSync(bak, 'utf8'), '---\nname: gauntlet\n---\nold hand-made draft\n');
    // a second, different install the same day keeps the first backup
    fs.writeFileSync(old, 'edited after install\n');
    r = run(root, ['--apply']);
    assert.match(r.text, /backup of today exists; kept/);
    assert.equal(fs.readFileSync(bak, 'utf8'), '---\nname: gauntlet\n---\nold hand-made draft\n');
    r = run(root, ['--uninstall', '--apply']);
    assert.equal(r.code, 0);
    assert.deepEqual(tree(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--home limits the skill copy and the include to one home', () => {
  const root = makeRoot();
  try {
    let r = run(root, ['--home', path.join(root, 'claude-homes', '2-b')]);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(actions(root, r.lines), [
      ...SKILL_FILES.map((f) => ['WRITE', P('claude-homes/2-b/skills/gauntlet', f)]),
      ['WRITE', 'claude-homes/2-b/rules/gauntlet.md'],
      ['BACKUP', `claude-homes/2-b/CLAUDE.md.bak-${STAMP}-gauntlet`],
      ['APPEND', 'claude-homes/2-b/CLAUDE.md'],
    ]);
    assert.ok(r.text.includes('@~/claude-homes/2-b/rules/gauntlet.md'), 'the include points at the home\'s own rule');
    assert.ok(!r.lines.some((l) => /\.claude[\\/]rules/.test(l)), '~/.claude is not touched');

    // applied and reversed: only that home changes
    const before2 = tree(root);
    r = run(root, ['--home', path.join(root, 'claude-homes', '2-b'), '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.readFileSync(path.join(root, 'claude-homes', '2-b', 'CLAUDE.md'), 'utf8').endsWith(`${INCLUDE_HEADING}\n@~/claude-homes/2-b/rules/gauntlet.md\n`));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'rules', 'gauntlet.md')));
    r = run(root, ['--home', path.join(root, 'claude-homes', '2-b'), '--uninstall', '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(tree(root), before2);

    // r2-f15: a junctioned home cannot keep ~/.claude untouched: refused, nothing planned
    r = run(root, ['--home', path.join(root, 'claude-homes', '1-a')]);
    assert.equal(r.code, 4, r.text);
    assert.match(r.text, /link to .*would land in ~\/\.claude/);

    r = run(root, ['--home', path.join(root, 'nowhere')]);
    assert.equal(r.code, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the main CLAUDE.md is created when absent and deleted again on uninstall', () => {
  const root = makeRoot();
  try {
    fs.rmSync(path.join(root, '.claude', 'CLAUDE.md'));
    const before = tree(root);
    let r = run(root, ['--apply']);
    assert.equal(r.code, 0, r.text);
    assert.equal(fs.readFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'utf8'), `${INCLUDE_HEADING}\n${INCLUDE_LINE}\n`);
    r = run(root, ['--uninstall', '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(tree(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bad arguments are usage errors (exit 4)', () => {
  const root = makeRoot();
  try {
    for (const argv of [['--bogus'], ['--apply', '--dry-run'], ['--home']]) {
      const before = tree(root);
      const r = run(root, argv);
      assert.equal(r.code, 4, argv.join(' '));
      assert.deepEqual(tree(root), before);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeIncludeText handles an include moved by hand', () => {
  const moved = `# X\n\n${INCLUDE_HEADING}\n${INCLUDE_LINE}\n\n# Y\nmore\n`;
  assert.equal(removeIncludeText(moved), '# X\n\n# Y\nmore\n');
  assert.equal(removeIncludeText(`# Z\n${INCLUDE_LINE}\n`), undefined, 'a hand-written include is not ours');
  assert.equal(removeIncludeText(`${INCLUDE_HEADING}\n${INCLUDE_LINE}\n`), null);
});

test('the CLI entry runs as a script and defaults to a dry run', () => {
  const root = makeRoot();
  try {
    const before = tree(root);
    const r = spawnSync(process.execPath, [path.join(REPO, 'install', 'install.mjs')], {
      env: { ...process.env, GAUNTLET_INSTALL_ROOT: root, GAUNTLET_INSTALL_DATE: STAMP },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN \(nothing is changed\)/);
    assert.deepEqual(tree(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the global rule and the skill description carry no loop internals (every subagent reads them)', () => {
  const rule = fs.readFileSync(path.join(REPO, 'rules', 'gauntlet.md'), 'utf8');
  const skill = fs.readFileSync(path.join(REPO, 'skill', 'gauntlet', 'SKILL.md'), 'utf8');
  const description = (/^description:\s*(.+)$/m.exec(skill) || [])[1] || '';
  assert.ok(description.length > 20);
  const INTERNALS = [/canar/i, /plant/i, /подлож/i, /sealed/i, /gauntlet-data/i, /confirm/i, /recall/i, /ledger/i, /\bkey\b/i, /attention/i, /threshold/i, /9[.,]5/, /blind/i, /слеп/i];
  for (const [name, text] of [['rules/gauntlet.md', rule], ['SKILL.md description', description]]) {
    for (const re of INTERNALS) assert.ok(!re.test(text), `${name} mentions ${re}`);
  }
});

test('r2-f25: an upgrade replaces the earlier gauntlet copy; uninstall removes it instead of restoring it', () => {
  const root = makeRoot();
  try {
    const before = tree(root);
    let r = run(root, ['--apply']);
    assert.equal(r.code, 0, r.text);
    // simulate an older installed version (it carries the gauntlet signature)
    const skill = path.join(root, '.claude', 'skills', 'gauntlet', 'SKILL.md');
    fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('# /gauntlet', '# /gauntlet (older)'));
    const lines = [];
    const code = main(['--apply'], { GAUNTLET_INSTALL_ROOT: root, GAUNTLET_CLAUDE_HOMES_DIR: 'claude-homes', GAUNTLET_INSTALL_DATE: '20260116' }, (x) => lines.push(...String(x).split('\n')));
    assert.equal(code, 0);
    assert.ok(lines.some((l) => /replace an earlier gauntlet copy/.test(l)), lines.join('\n'));
    assert.ok(!fs.existsSync(`${skill}.bak-20260116-gauntlet`), 'no backup of our own older copy');
    // an older install (before this fix) left a backup of our own copy: uninstall deletes it
    fs.writeFileSync(`${skill}.bak-20261005-gauntlet`, fs.readFileSync(skill));
    r = run(root, ['--uninstall', '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(tree(root), before, 'nothing of gauntlet is left');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--home also accepts a Claude config folder outside GAUNTLET_CLAUDE_HOMES_DIR when it looks like one', () => {
  const root = makeRoot();
  try {
    const other = path.join(root, 'elsewhere', 'cfg');
    fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
    const lines = [];
    const code = main(['--home', other, '--apply'], { GAUNTLET_INSTALL_ROOT: root, GAUNTLET_INSTALL_DATE: STAMP }, (x) => lines.push(String(x)));
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(fs.existsSync(path.join(other, 'rules', 'gauntlet.md')));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'rules', 'gauntlet.md')), 'the main home is untouched');
    const bad = main(['--home', path.join(root, 'elsewhere'), '--apply'], { GAUNTLET_INSTALL_ROOT: root, GAUNTLET_INSTALL_DATE: STAMP }, () => {});
    assert.equal(bad, 4, 'a folder that does not look like a Claude config home is refused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
