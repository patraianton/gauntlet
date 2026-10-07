#!/usr/bin/env node
// gauntlet installer (SPEC section 18.3). Run by hand only.
//
//   node install/install.mjs                     dry run (default): print every action, change nothing
//   node install/install.mjs --apply             perform the install
//   node install/install.mjs --uninstall         dry run of the reversal: print it, change nothing
//   node install/install.mjs --uninstall --apply reverse the install (restores backups, removes our files)
//   node install/install.mjs --home <dir> ...    limit the install to one Claude Code config home: its
//                                                 skill copy, its own rules/gauntlet.md and its CLAUDE.md include
//
// Every mode is a dry run unless --apply is given (install and uninstall alike).
//
// What it touches, and nothing else:
//   - <home>/.claude/skills/gauntlet/**        (plus each extra Claude config home whose skills folder
//                                                 is a separate real folder, not a link to the main one)
//   - <home>/.claude/rules/gauntlet.md         (with --home <extra home>: that home's
//                                                 rules/gauntlet.md instead, so ~/.claude stays untouched)
//   - the @ include line appended to <home>/.claude/CLAUDE.md and to the CLAUDE.md of each extra home
//     that lacks it (with --home: that home only, and the line points at that home's own rule file)
// Extra homes (multi-account setups that use CLAUDE_CONFIG_DIR) are the subfolders of the folder named
// by the env var GAUNTLET_CLAUDE_HOMES_DIR (absolute, or relative to the user home); none by default.
// Never settings.json, permissions, hooks, .claude-backups or any other file.
// Before any write of an existing file: <file>.bak-YYYYMMDD-gauntlet (once per day, never overwritten).
// Environment: GAUNTLET_INSTALL_ROOT replaces the user home (tests). GAUNTLET_INSTALL_DATE=YYYYMMDD
// fixes the backup date (tests). GAUNTLET_CLAUDE_HOMES_DIR: see above.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INCLUDE_LINE = '@~/.claude/rules/gauntlet.md';
export const INCLUDE_HEADING = '# Gauntlet (honest review loop)';
// Any include line this installer writes: the main home's rule, or an extra home's own rule.
const INCLUDE_RE = /^@\S+\/rules\/gauntlet\.md$/;
const blockLf = (line) => `\n${INCLUDE_HEADING}\n${line}\n`;
const createdLf = (line) => `${INCLUDE_HEADING}\n${line}\n`;
const BACKUP_SUFFIX = '-gauntlet';
const PLACEHOLDER = /\{\{GAUNTLET_REPO\}\}/g;
// Every file this installer writes carries this line (it is in the repository files themselves).
// A file or a backup with it is an earlier gauntlet copy, not the user's: an upgrade replaces it
// without a backup, and uninstall deletes it instead of "restoring" it (r2-f25).
export const OWN_SIGNATURE = '<!-- gauntlet: installed copy of a repository file;';
const isOwn = (p) => {
  try { return fs.readFileSync(p, 'utf8').includes(OWN_SIGNATURE); } catch { return false; }
};

const IS_WIN = process.platform === 'win32';

function samePath(a, b) {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function todayStamp(env) {
  if (env.GAUNTLET_INSTALL_DATE && /^\d{8}$/.test(env.GAUNTLET_INSTALL_DATE)) return env.GAUNTLET_INSTALL_DATE;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
}

function backupPathFor(file, stamp) {
  return `${file}.bak-${stamp}${BACKUP_SUFFIX}`;
}

/** All gauntlet backups of a file, newest first. */
function backupsOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-(\\d{8})${BACKUP_SUFFIX}$`);
  return names
    .map((n) => ({ n, m: re.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => (a.m[1] < b.m[1] ? 1 : a.m[1] > b.m[1] ? -1 : 0))
    .map((x) => path.join(dir, x.n));
}

function walkFiles(root) {
  const out = [];
  const visit = (rel) => {
    const abs = path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) visit(r);
      else if (ent.isFile()) out.push(r);
    }
  };
  visit('');
  return out.sort();
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseArgs(argv) {
  const opts = { apply: false, uninstall: false, dryRun: false, home: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--home') {
      if (i + 1 >= argv.length) throw new Error('--home needs a folder');
      opts.home = argv[++i];
    } else if (a.startsWith('--home=')) opts.home = a.slice('--home='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.apply && opts.dryRun) throw new Error('--apply and --dry-run exclude each other');
  return opts;
}

const HELP = `gauntlet installer
  node install/install.mjs                       dry run: print the plan, change nothing
  node install/install.mjs --apply               install the skill, the rule and the @ include
  node install/install.mjs --uninstall           dry run of the reversal: print it, change nothing
  node install/install.mjs --uninstall --apply   reverse the install
  --home <dir>                                   limit everything to one Claude config home (~/.claude or
                                                 an extra home, see GAUNTLET_CLAUDE_HOMES_DIR); an extra home gets
                                                 its own rules/gauntlet.md and ~/.claude is not touched;
                                                 refused when that home's skills folder links to ~/.claude/skills
Never touches settings.json, permissions, hooks or .claude-backups.`;

const looksLikeHome = (dir) => ['skills', 'CLAUDE.md', 'settings.json', '.claude.json'].some((f) => exists(path.join(dir, f)));

/** Discover the main home and the extra Claude config homes (env GAUNTLET_CLAUDE_HOMES_DIR) under root. */
export function discoverHomes(root, env = process.env) {
  const mainDir = path.join(root, '.claude');
  const homes = [{ name: '~/.claude', dir: mainDir, skills: path.join(mainDir, 'skills'), claudeMd: path.join(mainDir, 'CLAUDE.md'), main: true }];
  const accRel = String(env.GAUNTLET_CLAUDE_HOMES_DIR ?? '').trim();
  const acc = accRel ? path.resolve(root, accRel.replace(/^~(?=$|[\\/])/, root)) : null;
  if (acc && isDir(acc)) {
    const names = fs.readdirSync(acc, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    for (const n of names) {
      const dir = path.join(acc, n);
      if (!isDir(dir)) continue;
      if (!looksLikeHome(dir)) continue;
      homes.push({ name: `${path.join(acc, n)}`, dir, skills: path.join(dir, 'skills'), claudeMd: path.join(dir, 'CLAUDE.md'), main: false });
    }
  }
  return homes;
}

/**
 * Build the plan. Returns { actions: [{ verb, target, why, run? }], notes: [string] }.
 * Actions without `run` are informational (SKIP / KEEP).
 */
export function buildPlan({ root, repoDir, mode, home, stamp, env = process.env }) {
  const actions = [];
  const notes = [];
  const add = (verb, target, why, run) => actions.push({ verb, target, why, run });
  const repoFwd = path.resolve(repoDir).split(path.sep).join('/');

  let homes = discoverHomes(root, env);
  const mainHome = homes[0];
  if (home) {
    const want = realOrSelf(path.resolve(home.replace(/^~(?=$|[\\/])/, root)));
    let hit = homes.find((h) => samePath(realOrSelf(h.dir), want));
    // a Claude config folder that is not under GAUNTLET_CLAUDE_HOMES_DIR is accepted when it looks like one
    if (!hit && isDir(want) && looksLikeHome(want)) {
      hit = { name: want, dir: want, skills: path.join(want, 'skills'), claudeMd: path.join(want, 'CLAUDE.md'), main: false };
    }
    if (!hit) throw new Error(`--home ${home}: not a known Claude home under ${root}`);
    homes = [hit];
  }

  // ---- skill targets (dedupe by realpath) ---------------------------------------------------
  const mainSkillsReal = realOrSelf(mainHome.skills);
  const skillTargets = [];
  const seen = [];
  const consider = (h) => {
    if (h.main) {
      if (!seen.some((s) => samePath(s, mainSkillsReal))) {
        seen.push(mainSkillsReal);
        skillTargets.push({ dir: mainHome.skills, via: h.name });
      }
      return;
    }
    if (!exists(h.skills)) {
      add('SKIP', h.skills, `${h.name} has no skills folder`);
      return;
    }
    const real = realOrSelf(h.skills);
    const st = fs.lstatSync(h.skills);
    if (samePath(real, mainSkillsReal)) {
      if (home) {
        // --home promises that ~/.claude is not touched; a skills folder linked to the main one
        // would put the skill into ~/.claude/skills anyway (r2-f15).
        throw new Error(`--home ${h.name}: its skills folder is a link to ${mainHome.skills}, so the skill would land in ~/.claude; install without --home, or give that home a separate skills folder`);
      }
      if (!seen.some((s) => samePath(s, real))) {
        seen.push(real);
        skillTargets.push({ dir: mainHome.skills, via: h.name });
      }
      add('SKIP', h.skills, `${h.name}: skills is a link to ${mainHome.skills}; covered by the main copy`);
      return;
    }
    if (seen.some((s) => samePath(s, real))) {
      add('SKIP', h.skills, `${h.name}: skills resolves to ${real}, already covered`);
      return;
    }
    if (!isDir(h.skills)) {
      add('SKIP', h.skills, `${h.name}: skills is not a folder`);
      return;
    }
    seen.push(real);
    skillTargets.push({ dir: h.skills, via: h.name, separate: st.isSymbolicLink() ? 'link' : 'real' });
  };
  for (const h of homes) consider(h);

  const skillSrc = path.join(repoDir, 'skill', 'gauntlet');
  const skillFiles = walkFiles(skillSrc);
  const rendered = (rel) => fs.readFileSync(path.join(skillSrc, ...rel.split('/')), 'utf8').replace(PLACEHOLDER, repoFwd);

  const ruleSrc = path.join(repoDir, 'rules', 'gauntlet.md');
  const ruleText = fs.readFileSync(ruleSrc, 'utf8');
  // With --home <account home> the rule lives in that home and its include points there; the main
  // home (~/.claude) is not touched at all.
  const ruleHome = home && !homes[0].main ? homes[0] : mainHome;
  const ruleDst = path.join(ruleHome.dir, 'rules', 'gauntlet.md');
  const relHome = path.relative(root, ruleHome.dir).split(path.sep).join('/');
  const includeLine = ruleHome.main ? INCLUDE_LINE : relHome.startsWith('..') || path.isAbsolute(relHome) ? `@${ruleHome.dir.split(path.sep).join('/')}/rules/gauntlet.md` : `@~/${relHome}/rules/gauntlet.md`;

  const fileItems = [];
  for (const t of skillTargets) {
    for (const rel of skillFiles) {
      fileItems.push({ dst: path.join(t.dir, 'gauntlet', ...rel.split('/')), text: rendered(rel), what: `skill file ${rel} (${t.via})` });
    }
  }
  fileItems.push({ dst: ruleDst, text: ruleText, what: 'global rule file' });

  if (mode === 'install') {
    for (const it of fileItems) planInstallFile(it, stamp, add);
    for (const h of homes) planInclude(h, stamp, add, includeLine);
  } else {
    for (const h of homes) planRemoveInclude(h, add);
    for (const it of fileItems) planUninstallFile(it, add);
    const ruleDir = path.dirname(ruleDst);
    if (isDir(ruleDir)) add('RMDIR', ruleDir, 'remove the rules folder if it is left empty (anything in it is kept)', () => { if (isDir(ruleDir) && fs.readdirSync(ruleDir).length === 0) fs.rmdirSync(ruleDir); });
    for (const t of skillTargets) {
      const dir = path.join(t.dir, 'gauntlet');
      if (isDir(dir)) add('RMDIR', dir, 'remove the skill folder if empty (anything left in it is kept)', () => removeEmptyDirs(dir));
    }
  }
  if (skillTargets.length === 0) notes.push('no skill target (the chosen home has no skills folder)');
  return { actions, notes };
}

function planInstallFile({ dst, text, what }, stamp, add) {
  if (exists(dst)) {
    const cur = fs.readFileSync(dst, 'utf8');
    if (cur === text) {
      add('SKIP', dst, `${what}: up to date`);
      return;
    }
    if (cur.includes(OWN_SIGNATURE)) {
      add('WRITE', dst, `${what} (replace an earlier gauntlet copy)`, () => writeText(dst, text));
      return;
    }
    const bak = backupPathFor(dst, stamp);
    if (exists(bak)) add('SKIP', bak, 'backup of today exists; kept');
    else add('BACKUP', bak, `copy of the current ${what}`, () => fs.copyFileSync(dst, bak, fs.constants.COPYFILE_EXCL));
    add('WRITE', dst, `${what} (replace)`, () => writeText(dst, text));
  } else {
    add('WRITE', dst, `${what} (new)`, () => { fs.mkdirSync(path.dirname(dst), { recursive: true }); writeText(dst, text); });
  }
}

function hasInclude(text) {
  return stripBom(text).split(/\r?\n/).some((l) => INCLUDE_RE.test(l.trim()));
}

function planInclude(h, stamp, add, includeLine = INCLUDE_LINE) {
  const f = h.claudeMd;
  if (!exists(f)) {
    if (h.main) {
      add('CREATE', f, `CLAUDE.md of ${h.name} with the @ include`, () => { fs.mkdirSync(path.dirname(f), { recursive: true }); writeText(f, createdLf(includeLine)); });
    } else {
      add('SKIP', f, `${h.name} has no CLAUDE.md`);
    }
    return;
  }
  const buf = fs.readFileSync(f);
  const text = buf.toString('utf8');
  if (hasInclude(text)) {
    add('SKIP', f, `${h.name}: include already present`);
    return;
  }
  const crlf = text.includes('\r\n');
  const block = crlf ? blockLf(includeLine).replace(/\n/g, '\r\n') : blockLf(includeLine);
  const bak = backupPathFor(f, stamp);
  if (exists(bak)) add('SKIP', bak, 'backup of today exists; kept');
  else add('BACKUP', bak, `copy of CLAUDE.md of ${h.name}`, () => fs.copyFileSync(f, bak, fs.constants.COPYFILE_EXCL));
  add('APPEND', f, `${h.name}: "${INCLUDE_HEADING}" + "${includeLine}" (${crlf ? 'CRLF' : 'LF'} kept)`, () => {
    const now = fs.readFileSync(f);
    writeBuf(f, Buffer.concat([now, Buffer.from(block, 'utf8')]));
  });
}

function planRemoveInclude(h, add) {
  const f = h.claudeMd;
  if (!exists(f)) return;
  const text = fs.readFileSync(f, 'utf8');
  if (!hasInclude(text)) {
    add('SKIP', f, `${h.name}: no include`);
    return;
  }
  const restored = removeIncludeText(text);
  if (restored === undefined) {
    add('SKIP', f, `${h.name}: the include line is not under the installer's heading; not added by the installer, left in place`);
    return;
  }
  if (restored === null) {
    add('DELETE', f, `${h.name}: CLAUDE.md held only the include (created by the installer)`, () => fs.unlinkSync(f));
    return;
  }
  add('EDIT', f, `${h.name}: remove the @ include block`, () => {
    writeBuf(f, Buffer.from(restored, 'utf8'));
    for (const b of backupsOf(f)) {
      if (fs.readFileSync(b, 'utf8') === restored) fs.unlinkSync(b);
    }
  });
}

/**
 * Returns the text without our block (heading line directly followed by the include line), null when
 * nothing but the block is left, or undefined when no such block exists (an include written by hand is
 * not ours to remove).
 */
export function removeIncludeText(text) {
  const bodyNoBom = stripBom(text);
  const line = stripBom(text).split(/\r?\n/).map((l) => l.trim()).find((l) => INCLUDE_RE.test(l)) ?? INCLUDE_LINE;
  if (bodyNoBom === createdLf(line) || bodyNoBom === createdLf(line).replace(/\n/g, '\r\n')) return null;
  for (const block of [blockLf(line).replace(/\n/g, '\r\n'), blockLf(line)]) {
    if (text.endsWith(block)) return text.slice(0, text.length - block.length);
  }
  // Moved by hand: drop each heading + include pair and one blank line above it.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (INCLUDE_RE.test(lines[i].trim()) && out.length && out[out.length - 1].trim() === INCLUDE_HEADING) {
      out.pop();
      if (out.length && out[out.length - 1].trim() === '' && i + 1 < lines.length) out.pop();
      removed = true;
      continue;
    }
    out.push(lines[i]);
  }
  return removed ? out.join(eol) : undefined;
}

function planUninstallFile({ dst, what }, add) {
  if (!exists(dst)) return;
  const all = backupsOf(dst);
  // Backups of an earlier gauntlet copy are ours: deleted, never restored.
  for (const b of all.filter(isOwn)) add('DELETE', b, `${what}: backup of an earlier gauntlet copy`, () => fs.unlinkSync(b));
  const baks = all.filter((b) => !isOwn(b));
  if (baks.length) {
    add('RESTORE', dst, `${what}: from ${path.basename(baks[0])}`, () => {
      fs.copyFileSync(baks[0], dst);
      fs.unlinkSync(baks[0]);
    });
  } else {
    add('DELETE', dst, what, () => fs.unlinkSync(dst));
  }
}

function removeEmptyDirs(dir) {
  if (!isDir(dir)) return;
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) removeEmptyDirs(path.join(dir, ent.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function writeText(p, text) {
  writeBuf(p, Buffer.from(text, 'utf8'));
}

/** Atomic write: temp file + rename. Bytes are written as given (UTF-8, no BOM added). */
function writeBuf(p, buf) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
}

export function main(argv = process.argv.slice(2), env = process.env, out = (s) => process.stdout.write(`${s}\n`)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    out(`error: ${e.message}`);
    out(HELP);
    return 4;
  }
  if (opts.help) {
    out(HELP);
    return 0;
  }
  const root = env.GAUNTLET_INSTALL_ROOT ? path.resolve(env.GAUNTLET_INSTALL_ROOT) : os.homedir();
  const repoDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const mode = opts.uninstall ? 'uninstall' : 'install';
  // Install and uninstall alike: nothing changes without --apply.
  const perform = opts.apply;
  let plan;
  try {
    plan = buildPlan({ root, repoDir, mode, home: opts.home, stamp: todayStamp(env), env });
  } catch (e) {
    out(`error: ${e.message}`);
    return 4;
  }
  out(`gauntlet ${mode} — ${perform ? 'APPLY' : 'DRY RUN (nothing is changed)'}`);
  out(`root: ${root}`);
  out(`repo: ${repoDir}`);
  let changed = 0;
  for (const a of plan.actions) {
    out(`${a.verb.padEnd(7)} ${a.target} — ${a.why}`);
    if (perform && a.run) {
      a.run();
      changed++;
    }
  }
  for (const n of plan.notes) out(`note: ${n}`);
  const pending = plan.actions.filter((a) => a.run).length;
  if (!perform) out(`${pending} change(s) planned. Re-run with --apply to perform.`);
  else out(`${changed} change(s) made.`);
  return 0;
}

const realNorm = (p) => {
  const r = fs.realpathSync(p);
  return IS_WIN ? r.toLowerCase() : r;
};
let invokedDirectly = false;
try {
  // Real paths: a call through a junction or symlink still runs (r2-f23).
  invokedDirectly = Boolean(process.argv[1]) && realNorm(path.resolve(process.argv[1])) === realNorm(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) {
  process.exitCode = main();
}
