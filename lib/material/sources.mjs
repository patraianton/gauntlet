// Primary-source recipes (SPEC 9.4, failure point 7).
//
// checkSources runs every `command` source through the allowlisted process runner (no shell,
// 30 s timeout, stdout capped at 1 MiB) and checks every `file` source by existence and size.
// A recipe whose path or any argument points at an author-notes file (or at a folder that
// contains one) is refused: numbers are checked against primary sources, never against the
// executor's own notes. The same holds, without any declaration by the executor, for every file
// a recipe reads that lies inside the material roots, the run folder or the project working
// folder (a facts file written next to the work is author notes whatever it is called), and for
// every file written after the run started (opts.startedAtMs; checked at setup and amend).

import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../core/hash.mjs';
import { runAllowed } from '../core/proc.mjs';
import { readRaw, writeRaw, ensureDir, exists } from '../core/fsx.mjs';

export const SOURCE_TIMEOUT_S = 30;
export const SOURCE_MAX_BYTES = 1024 * 1024;
export const SAMPLE_CHARS = 300;

const WIN = process.platform === 'win32';

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normPath(p) {
  let s = path.resolve(String(p)).replace(/\\/g, '/');
  if (WIN) s = s.toLowerCase();
  return s.replace(/\/+$/, '');
}

function normText(s) {
  const t = String(s).replace(/\\\\/g, '/').replace(/\\/g, '/');
  return WIN ? t.toLowerCase() : t;
}

/** Bare executable name allowed? (case-insensitive, .exe/.cmd/.bat ignored; no path separators). */
export function isAllowedCmd(cmd, allow) {
  if (typeof cmd !== 'string' || cmd === '' || /[\\/]/.test(cmd)) return false;
  const base = cmd.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  return (allow ?? []).some((a) => String(a).toLowerCase() === base);
}

/**
 * Why a recipe touches an author-notes file, or null.
 * Checks the source path and every argument (and the part after '=' in --x=y arguments):
 *   - is a path (absolute or with a separator, not a URL) that resolves to a notes file, or to a
 *     folder that contains one;
 *   - contains a notes file's absolute path (any slash style, case-insensitive on Windows);
 *   - contains a notes file's name (e.g. AUTHOR-NOTES.md inside a node -e script).
 */
export function touchesNotes(source, notesAbs) {
  if (!notesAbs || notesAbs.length === 0) return null;
  const notes = notesAbs.map((n) => ({ abs: normPath(n), name: normText(path.basename(n)) }));
  const tokens = [];
  if (source.path) tokens.push(String(source.path));
  if (source.cmd) tokens.push(String(source.cmd));
  for (const a of source.args ?? []) {
    tokens.push(String(a));
    const eq = String(a).indexOf('=');
    if (eq > 0) tokens.push(String(a).slice(eq + 1));
  }
  for (const t of tokens) {
    const tt = normText(t);
    for (const n of notes) {
      if (tt.includes(n.abs)) return `argument "${t}" names the author notes ${n.abs}`;
      if (n.name && tt.includes(n.name)) return `argument "${t}" names the author-notes file ${n.name}`;
      // folder check only for arguments that look like paths (absolute, or with a separator)
      if (t.length > 0 && t.length < 4096 && !/[\r\n]/.test(t) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && (path.isAbsolute(t) || /[\\/]/.test(t))) {
        const r = normPath(t);
        if (r === n.abs || n.abs.startsWith(r + '/')) return `argument "${t}" resolves to the author notes or a folder containing them`;
      }
    }
  }
  return null;
}

function getDotted(value, dotted) {
  let cur = value;
  if (dotted === '' || dotted === undefined) return cur;
  for (const part of String(dotted).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && part === 'length') cur = cur.length;
    else if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
    else return undefined;
  }
  return cur;
}

/** Check an `expect` rule against output text. -> null when satisfied, else the reason. */
export function checkExpect(expect, text) {
  const e = expect ?? 'nonempty';
  if (e === 'nonempty') return String(text).trim().length > 0 ? null : 'output is empty';
  if (e.startsWith('contains:')) {
    const needle = e.slice('contains:'.length);
    return String(text).includes(needle) ? null : `output does not contain "${needle}"`;
  }
  if (e.startsWith('json:')) {
    const m = /^json:([^<>=]*?)(>=|<=|=|>|<)(-?\d+(?:\.\d+)?)$/.exec(e);
    if (!m) return `bad expect rule "${e}"`;
    let data;
    try {
      data = JSON.parse(stripBom(String(text)));
    } catch (err) {
      return `output is not JSON: ${err.message}`;
    }
    let v = getDotted(data, m[1]);
    if (Array.isArray(v)) v = v.length;
    if (typeof v !== 'number' || !Number.isFinite(v)) return `json value at "${m[1]}" is not a number`;
    const want = Number(m[3]);
    const ok = { '>': v > want, '>=': v >= want, '=': v === want, '<': v < want, '<=': v <= want }[m[2]];
    return ok ? null : `json value at "${m[1]}" is ${v}, expected ${m[2]} ${want}`;
  }
  return `unknown expect rule "${e}"`;
}

function result(id, fields) {
  return { id, ok: false, exitCode: null, bytes: 0, sha256: null, sample: '', error: null, files: [], ...fields };
}

/**
 * Attach the raw bytes of a source's output to its result as a NON-enumerable `raw` property: it is
 * never written to JSON or a ledger by accident, but the round start can keep it in the run folder
 * (rounds/NN/source-text/<id>.txt) so that ingest can tell a reviewer quoting a primary source from a
 * reviewer talking about the check (meta mentions).
 */
function withRaw(res, buf) {
  Object.defineProperty(res, 'raw', { value: buf, enumerable: false });
  return res;
}

/** sha256 of each file a recipe reads (file source path, files named in a command's arguments). */
function fileHashes(paths) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ path: p, sha256: sha256Hex(readRaw(p)) });
    } catch {
      out.push({ path: p, sha256: null });
    }
  }
  return out;
}

/**
 * Why a file the recipe reads cannot be a primary source, or null.
 * forbiddenRoots: [{ path, what }] — material roots, the run folder, the project working folder.
 * startedAtMs: files modified after this moment were written during the run.
 */
export function ownFileProblem(abs, { forbiddenRoots = [], startedAtMs = null } = {}) {
  const a = normPath(abs);
  for (const r of forbiddenRoots) {
    const rp = normPath(r.path);
    if (a === rp || a.startsWith(rp + '/')) return `${abs} lies inside ${r.what} (${r.path}); a file there is the author's own material or notes, not a primary source`;
  }
  if (startedAtMs != null) {
    try {
      const m = fs.statSync(abs).mtimeMs;
      if (m > startedAtMs) return `${abs} was written after the run started; a file made during the run cannot be a primary source`;
    } catch {
      /* missing files are reported elsewhere */
    }
  }
  return null;
}

/** Files named by a command recipe's arguments that exist on disk (absolute, or relative to the cwd). */
function argFiles(source) {
  const out = [];
  const cands = [];
  for (const a of source.args ?? []) {
    const s = String(a);
    cands.push(s);
    const eq = s.indexOf('=');
    if (eq > 0) cands.push(s.slice(eq + 1));
  }
  for (const c of cands) {
    if (!c || c.length > 1024 || /[\r\n]/.test(c) || /^[a-z][a-z0-9+.-]*:\/\//i.test(c) || c.startsWith('-')) continue;
    if (!path.isAbsolute(c) && !/[\\/]/.test(c) && !/\.[A-Za-z0-9]{1,5}$/.test(c)) continue;
    const abs = path.resolve(c);
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch {
      /* not a file */
    }
  }
  return out;
}

function checkFileSource(src, notesAbs, own) {
  const touch = touchesNotes(src, notesAbs);
  if (touch) return result(src.id, { error: `refused: ${touch}` });
  if (typeof src.path === 'string' && path.isAbsolute(src.path)) {
    const why = ownFileProblem(src.path, own);
    if (why) return result(src.id, { error: `refused: ${why}` });
  }
  if (typeof src.path !== 'string' || !path.isAbsolute(src.path)) return result(src.id, { error: 'file source needs an absolute path' });
  let st;
  try {
    st = fs.statSync(src.path);
  } catch {
    return result(src.id, { error: `file not found: ${src.path}` });
  }
  if (!st.isFile()) return result(src.id, { error: `not a file: ${src.path}` });
  const buf = readRaw(src.path);
  const text = stripBom(buf.toString('utf8'));
  const base = { exitCode: null, bytes: st.size, sha256: sha256Hex(buf), sample: text.slice(0, SAMPLE_CHARS), files: [{ path: src.path, sha256: sha256Hex(buf) }] };
  if (st.size === 0) return result(src.id, { ...base, error: 'file is empty' });
  const why = src.expect ? checkExpect(src.expect, text) : null;
  return withRaw(result(src.id, { ...base, ok: why === null, error: why }), buf);
}

// Interpreter flags that run code given on the command line: the code can read any file
// (a facts file inside the project folder included) without naming it as an argument.
const INLINE_CODE_FLAGS = Object.freeze({
  node: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '-'],
  python: ['-c', '-'],
  python3: ['-c', '-'],
  py: ['-c', '-'],
});

/** Why a command recipe is not a primary source by its shape alone, or null (r2-f3). */
export function recipeShapeProblem(source, forbiddenRoots = []) {
  const base = String(source.cmd ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  const args = (source.args ?? []).map(String);
  const flags = INLINE_CODE_FLAGS[base];
  if (flags) {
    for (const a of args) {
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (flags.includes(name) || (/^-[a-z]+$/i.test(a) && base !== 'node' && a.includes('c'))) {
        return `${source.cmd} ${a} runs code written into the recipe; such code can print any file or constant, so it is not a primary source (use a URL, a file outside the author's folders, or a script file outside them)`;
      }
    }
  }
  for (const a of args) {
    const pieces = [a];
    const eq = a.indexOf('=');
    if (eq > 0) pieces.push(a.slice(eq + 1));
    for (const p of pieces) {
      if (/^file:/i.test(p.trim())) return `argument ${p} is a file: URL; a local file is a file source, and files inside the author's folders are refused`;
      const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(p.trim());
      if (m) {
        const host = m[1].toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0' || host === '0' || /^0x7f/i.test(host) || /^2130706433$/.test(host)) {
          return `argument ${p} points at this machine (${host}); a local server can serve the author's own files, so it is not a primary source`;
        }
      }
    }
    // A forbidden folder named anywhere inside an argument (also inside a longer string).
    const t = normText(a);
    for (const r of forbiddenRoots) {
      const rp = normPath(r.path);
      if (rp && t.includes(rp)) return `argument names ${r.what} (${r.path}); a file there is the author's own material or notes, not a primary source`;
    }
  }
  return null;
}

function checkCommandSource(src, allow, notesAbs, runner, own) {
  const touch = touchesNotes(src, notesAbs);
  if (touch) return result(src.id, { error: `refused: ${touch}` });
  const named = argFiles(src);
  for (const f of named) {
    const why = ownFileProblem(f, own);
    if (why) return result(src.id, { error: `refused: the recipe reads ${f}: ${why}` });
  }
  const shape = recipeShapeProblem(src, own.forbiddenRoots);
  if (shape) return result(src.id, { error: `refused: ${shape}` });
  if (!isAllowedCmd(src.cmd, allow)) {
    return result(src.id, { error: `refused: "${src.cmd}" is not an allowed executable (allowExecutables: ${(allow ?? []).join(', ')})` });
  }
  let res;
  try {
    res = runner({
      cmd: src.cmd,
      args: (src.args ?? []).map(String),
      timeoutS: SOURCE_TIMEOUT_S,
      allow,
      maxBytes: SOURCE_MAX_BYTES,
    });
  } catch (e) {
    return result(src.id, { error: `could not run: ${e.message}` });
  }
  let out = res.stdout ?? '';
  let buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');
  if (buf.length > SOURCE_MAX_BYTES) buf = buf.subarray(0, SOURCE_MAX_BYTES);
  const text = buf.toString('utf8');
  const base = { exitCode: res.exitCode ?? null, bytes: buf.length, sha256: sha256Hex(buf), sample: text.slice(0, SAMPLE_CHARS), files: fileHashes(named) };
  if (res.timedOut) return result(src.id, { ...base, error: `timed out after ${SOURCE_TIMEOUT_S} s` });
  if (res.exitCode !== 0) {
    const err = String(res.stderr ?? '').trim().slice(0, SAMPLE_CHARS);
    return result(src.id, { ...base, error: `exit code ${res.exitCode}${err ? `: ${err}` : ''}` });
  }
  const why = checkExpect(src.expect ?? 'nonempty', text);
  return withRaw(result(src.id, { ...base, ok: why === null, error: why }), buf);
}

/**
 * sourceFileChanges(baseline, results) -> [{ id, path, was, now }] (r3-f3)
 * baseline: { <id>: [{ path, sha256 }] } recorded at setup (and at amend --what sources). A file a
 * source reads whose hash differs from the baseline, or that is gone, was changed during the run.
 */
export function sourceFileChanges(baseline, results) {
  const out = [];
  for (const r of results || []) {
    const was = (baseline || {})[r.id];
    if (!Array.isArray(was)) continue;
    const now = new Map((r.files || []).map((f) => [f.path, f.sha256]));
    for (const f of was) {
      const h = now.has(f.path) ? now.get(f.path) : null;
      if (h !== f.sha256) out.push({ id: r.id, path: f.path, was: f.sha256, now: h });
    }
  }
  return out;
}

/** baseline of a check: { <id>: files } for the sources that passed. */
export function sourcesBaseline(results) {
  const out = {};
  for (const r of results || []) if (r.ok) out[r.id] = (r.files || []).map((f) => ({ path: f.path, sha256: f.sha256 }));
  return out;
}

/**
 * checkSources(sources, { allow, notesAbs: [], forbiddenRoots: [], startedAtMs?, runner? }) -> [{ id, ok, exitCode, bytes, sha256, sample, error, files }]
 * files: [{ path, sha256 }] of what the recipe reads (the file of a file source; files named in a
 * command's arguments, e.g. its script). Code compares them with the setup baseline every round (r3-f3).
 * `sources` may be the sources.json object or its `sources` array. A command source without `expect`
 * must exit 0 with non-empty output; a file source must exist and be non-empty.
 */
export function checkSources(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources : (sources?.sources ?? []);
  const allow = opts.allow ?? [];
  const notesAbs = opts.notesAbs ?? [];
  const runner = opts.runner ?? runAllowed;
  const own = { forbiddenRoots: opts.forbiddenRoots ?? [], startedAtMs: opts.startedAtMs ?? null };
  return list.map((src) => {
    if (!src || typeof src.id !== 'string') return result(String(src?.id ?? '?'), { error: 'source without an id' });
    if (src.kind === 'command') return checkCommandSource(src, allow, notesAbs, runner, own);
    if (src.kind === 'file') return checkFileSource(src, notesAbs, own);
    return result(src.id, { error: `unknown source kind "${src.kind}"` });
  });
}

// ---------------------------------------------------------------- kept output (meta-mention check)

/** Folder of the kept source outputs of one round (rounds/NN/source-text). */
export function sourceTextDir(roundDir) {
  return path.join(roundDir, 'source-text');
}

/**
 * writeSourceTexts(roundDir, results) -> number of files written
 * Keeps the raw output of every source that ran (as checked at the round start) next to the round's
 * sources-check.json. The file is evidence only for ONE purpose: telling a reviewer who quotes a
 * primary source (so the quote may contain a word like "honeypot") from one who talks about the
 * check itself. readSourceTexts re-hashes each file against the sha256 in sources-check.json.
 */
export function writeSourceTexts(roundDir, results) {
  const dir = sourceTextDir(roundDir);
  let n = 0;
  for (const r of results || []) {
    if (!r || !r.raw || !/^[A-Za-z0-9_-]{1,40}$/.test(String(r.id))) continue;
    ensureDir(dir);
    writeRaw(path.join(dir, `${r.id}.txt`), r.raw);
    n += 1;
  }
  return n;
}

/**
 * readSourceTexts(roundDir, results) -> [{ id, text }]
 * Only files whose bytes still hash to the sha256 that sources-check.json recorded for that source
 * are returned: an edited or swapped file is silently left out (then nothing is excused by it).
 */
export function readSourceTexts(roundDir, results) {
  const dir = sourceTextDir(roundDir);
  const out = [];
  for (const r of results || []) {
    if (!r || !r.sha256 || !/^[A-Za-z0-9_-]{1,40}$/.test(String(r.id))) continue;
    const f = path.join(dir, `${r.id}.txt`);
    if (!exists(f)) continue;
    let buf;
    try {
      buf = readRaw(f);
    } catch {
      continue;
    }
    if (sha256Hex(buf) !== r.sha256) continue;
    out.push({ id: r.id, text: stripBom(buf.toString('utf8')) });
  }
  return out;
}

// ---------------------------------------------------------------- moving targets (SPEC 9.4, night 06-07.10.2026)
//
// A primary source must say the same thing in round 1 and in round 8. Two recipes broke that on the first
// live night: one read a file inside the executor's own git working tree (the executor appended to it
// during the run), another asked for `git log -4 origin/<branch>` and expected a commit that stopped being
// the tip after the executor pushed. movingTargetProblems lints a recipe by its shape: a git revision that
// is not a full commit hash, a `git log` without a pinned range, a command that reads the live state of a
// repository, a file source (or a data file named in a command) inside a git working tree. It never runs
// anything; setup and amend ask for the owner's words to keep a flagged recipe.

const HEX_FULL = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX_ABBR = /^[0-9a-f]{4,39}$/i;
const GIT_PRE_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const GIT_VALUE_OPTS = new Set(['-n', '--max-count', '--skip', '--format', '--pretty', '--since', '--until', '--after', '--before', '--author', '--committer', '--grep', '--date', '-U', '--unified', '--diff-filter', '-G', '-S', '-O', '--abbrev', '--relative', '--color', '--word-diff-regex', '--stat-width', '--output']);
const GIT_RANGE_CMDS = new Set(['log', 'rev-list', 'whatchanged', 'shortlog', 'cherry']);
const GIT_REV_CMDS = new Set(['show', 'diff', 'diff-tree', 'ls-tree', 'cat-file', 'rev-parse', 'archive', 'blame', 'describe', 'name-rev', 'merge-base', 'grep']);
const GIT_LIVE_CMDS = new Set(['status', 'ls-files', 'branch', 'tag', 'stash', 'remote', 'fetch', 'pull', 'ls-remote', 'reflog', 'worktree', 'for-each-ref', 'show-ref', 'symbolic-ref']);
const GIT_ALL_REFS = new Set(['--all', '--branches', '--remotes', '--tags', '--glob', '--exclude']);
const GIT_OBJECT_TYPES = new Set(['blob', 'tree', 'commit', 'tag']);
// Commands whose first positional is a tree-ish / commit-ish and every later one a path: `git ls-tree <hash> lib/db/`.
const GIT_FIRST_REV_ONLY = new Set(['ls-tree', 'archive', 'describe', 'name-rev']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '-lc', '-ec', '-command', '/c', '-encodedcommand']);

/** The git working tree a file lies in (the folder holding .git), or null. */
export function gitRootOf(abs) {
  let dir = path.dirname(path.resolve(String(abs)));
  for (let i = 0; i < 64; i++) {
    try {
      fs.statSync(path.join(dir, '.git'));
      return dir;
    } catch {
      /* keep walking up */
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** One revision expression -> { pinned, abbreviated?, implicit?, name }. A full hash (optionally ^, ~N, :path) is pinned. */
function classifyRev(tok) {
  let t = String(tok);
  const colon = t.indexOf(':');
  if (colon > 0 && !t.includes('..') && !/^[A-Za-z]:[\\/]/.test(t)) t = t.slice(0, colon);
  const parts = t.includes('..') ? t.split(/\.{2,3}/) : [t];
  for (const part of parts) {
    const base = part.replace(/(?:\^\{[^}]*\}|\^\d*|~\d*)+$/, '');
    if (base === '') return { pinned: false, implicit: true, name: t };
    if (HEX_FULL.test(base)) continue;
    return { pinned: false, abbreviated: HEX_ABBR.test(base), name: base };
  }
  return { pinned: true, name: t };
}

/**
 * A positional that is a file or folder, not a revision: a trailing slash, a file extension that starts with a letter
 * (v1.2.0 is a tag, SPEND.md a file), or something that exists in the repository folder. Tokens with ":" or ".."
 * are revision expressions (HEAD:a.txt, A..B). Writing `--` before the paths removes every doubt.
 */
function looksLikePath(tok, dir) {
  const t = String(tok);
  if (t.includes(':') || t.includes('..')) return false;
  if (t.endsWith('/') || t.endsWith('\\')) return true;
  if (/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) return true;
  if (dir && dir !== '<repository>') {
    try {
      fs.statSync(path.join(dir, t));
      return true;
    } catch {
      /* not on disk */
    }
  }
  return false;
}

/** Subcommand, positional tokens and options of a git invocation (arguments after "--" are paths). */
function parseGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GIT_PRE_VALUE_OPTS.has(args[i]) ? 2 : 1;
  const sub = args[i];
  const positional = [];
  const options = [];
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (a === '--') break;
    if (a.startsWith('-')) {
      options.push(a);
      if (GIT_VALUE_OPTS.has(a)) j += 1;
      continue;
    }
    positional.push(a);
  }
  return { sub, positional, options };
}

function gitDirOf(args) {
  const k = args.indexOf('-C');
  return k >= 0 && args[k + 1] ? args[k + 1] : '<repository>';
}

/**
 * Why one git recipe reads a moving target -> [{ key, why, suggest, hint? }]. `hint` marks a weaker finding
 * (an abbreviated hash of 7+ characters): shown, but it does not need the owner's words.
 */
export function gitMovingProblems(argList) {
  const args = (argList ?? []).map(String);
  const out = [];
  const { sub, positional, options } = parseGit(args);
  if (!sub || options.includes('--no-index')) return out;
  const dir = gitDirOf(args);
  const pin = (name) => `pin it: run \`git -C ${dir} rev-parse ${name}\` once and write the full 40-character hash into the recipe (git -C ${dir} show <full-hash>:<path>, git -C ${dir} log -4 <full-hash>, git -C ${dir} diff <full-hash> <full-hash>)`;
  if (GIT_LIVE_CMDS.has(sub)) {
    out.push({ key: `git ${sub} reads the live state of the repository`, why: `git ${sub} shows the repository as it is now, and the executor changes it during the run`, suggest: `read a pinned commit instead: git -C ${dir} show <full-hash>:<path>` });
    return out;
  }
  if (!GIT_RANGE_CMDS.has(sub) && !GIT_REV_CMDS.has(sub)) return out;
  let revs = positional;
  if (sub === 'cat-file') revs = revs.filter((x) => !GIT_OBJECT_TYPES.has(x));
  if (sub === 'grep') revs = revs.slice(1); // the first positional is the pattern
  if (GIT_FIRST_REV_ONLY.has(sub)) revs = revs.slice(0, 1);
  else if (sub === 'diff-tree') revs = revs.filter((x, k) => k === 0 || HEX_ABBR.test(x) || x.includes('..'));
  else revs = revs.filter((x) => !looksLikePath(x, dir));
  const classified = revs.map((r) => ({ tok: r, ...classifyRev(r) }));
  const allRefs = options.find((o) => GIT_ALL_REFS.has(o.split('=')[0]));
  if (allRefs) out.push({ key: `git ${sub} ${allRefs} reads every ref of the repository`, why: 'every branch and tag moves during the run', suggest: pin('<ref>') });
  for (const c of classified) {
    if (c.pinned) continue;
    if (c.implicit) out.push({ key: `git ${sub} range "${c.tok}" has an open end (HEAD)`, why: 'the open end of a range is HEAD, which moves', suggest: pin('HEAD') });
    else if (c.abbreviated) out.push({ key: `git revision "${c.name}" is an abbreviated hash, not a full commit hash`, why: 'an abbreviated hash names one commit that does not move, but it can turn ambiguous as the repository grows', suggest: pin(c.name), hint: c.name.length >= 7 });
    else out.push({ key: `git revision "${c.name}" is not a full commit hash`, why: `${c.name} is a branch, tag or relative name: it points somewhere else after the executor commits or pushes`, suggest: pin(c.name) });
  }
  // `git diff <one revision>` compares that commit with the working tree, which is what the executor edits.
  const diffAgainstTree = sub === 'diff' && classified.length === 1 && classified[0].pinned && !classified[0].tok.includes('..') && !options.some((o) => o === '--cached' || o === '--staged');
  if (diffAgainstTree) out.push({ key: `git diff with one revision compares it with the working tree`, why: 'the working tree is exactly what the executor edits', suggest: `read pinned commits: git -C ${dir} diff <full-hash> <full-hash>` });
  if (classified.length === 0 && !allRefs) {
    if (GIT_RANGE_CMDS.has(sub)) out.push({ key: `git ${sub} has no pinned range (it walks back from HEAD)`, why: 'without a revision git starts at HEAD, which moves', suggest: pin('HEAD') });
    else if (sub === 'diff' || sub === 'blame' || sub === 'grep') out.push({ key: `git ${sub} without a commit reads the working tree`, why: 'the working tree is exactly what the executor edits', suggest: `read pinned commits: git -C ${dir} ${sub === 'diff' ? 'diff <full-hash> <full-hash>' : 'show <full-hash>:<path>'}` });
    else if (['show', 'describe', 'name-rev', 'ls-tree', 'diff-tree', 'archive'].includes(sub)) out.push({ key: `git ${sub} has no pinned commit (it reads HEAD)`, why: 'without a revision git uses HEAD, which moves', suggest: pin('HEAD') });
  }
  return out;
}

/** The program name of a command, whatever the directory and extension: C:/Program Files/Git/cmd/git.exe -> git. */
function commandBase(cmd) {
  return String(cmd ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

/** Split a one-line script into words, honouring single and double quotes. */
function shellWords(text) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/** The git invocations (argument lists after `git`) inside a shell's -c / -Command one-liner. */
function wrappedGitCommands(args) {
  const k = args.findIndex((a) => SHELL_COMMAND_FLAGS.has(a.toLowerCase()));
  if (k < 0 || k + 1 >= args.length) return [];
  const script = args.slice(k + 1).join(' ');
  const found = [];
  for (const segment of script.split(/&&|\|\||;|\|/)) {
    const words = shellWords(segment.trim());
    // `cd x && git ...` and `& git ...` are fine: only the segment's own first word matters
    const first = words[0] === '&' ? 1 : 0;
    if (words[first] && commandBase(words[first]) === 'git') found.push(words.slice(first + 1));
  }
  return found;
}

const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'pwsh', 'powershell', 'bash', 'sh', 'ruby', 'perl', 'deno', 'bun']);

/**
 * movingTargetProblems(sources, { gitRoot? }) -> [{ id, key, why, suggest }]
 * `key` is stable text ("source S35: git revision "origin/x" is not a full commit hash") that the owner's
 * approval is recorded against. `sources` is the sources.json object or its array. gitRoot(abs) is injectable.
 */
export function movingTargetProblems(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources : (sources?.sources ?? []);
  const gitRoot = opts.gitRoot ?? gitRootOf;
  const out = [];
  const fileInTree = (id, abs) => {
    const root = gitRoot(abs);
    if (!root) return;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    out.push({
      id,
      key: `source ${id}: ${abs.split(path.sep).join('/')} lies inside the git working tree ${root.split(path.sep).join('/')}`,
      why: 'the executor can edit or append to a file in its own working tree during the run, so the source says something else in a later round',
      suggest: `read a pinned commit: git -C ${root.split(path.sep).join('/')} show <full-commit-hash>:${rel} (the full hash comes from \`git -C ${root.split(path.sep).join('/')} rev-parse <ref>\`)`,
    });
  };
  for (const src of list) {
    if (!src || typeof src.id !== 'string') continue;
    if (src.kind === 'file' && typeof src.path === 'string' && path.isAbsolute(src.path)) fileInTree(src.id, path.resolve(src.path));
    if (src.kind !== 'command') continue;
    const base = commandBase(src.cmd);
    const args = (src.args ?? []).map(String);
    if (base === 'git') {
      for (const p of gitMovingProblems(args)) out.push({ id: src.id, key: `source ${src.id}: ${p.key}`, why: p.why, suggest: p.suggest, ...(p.hint ? { hint: true } : {}) });
      continue;
    }
    // `sh -c "git log -4 origin/x"`, `powershell -Command "git ..."`: the git commands inside a one-line script.
    const wrapped = SHELLS.has(base) ? wrappedGitCommands(args) : [];
    for (const gitArgs of wrapped) {
      for (const p of gitMovingProblems(gitArgs)) out.push({ id: src.id, key: `source ${src.id}: ${p.key}`, why: p.why, suggest: p.suggest, ...(p.hint ? { hint: true } : {}) });
    }
    if (wrapped.length) continue;
    // A data file named in a command's arguments. The script an interpreter runs is guarded by the setup
    // baseline (any change to it blocks the round), so only the other files are linted here.
    const scriptArg = INTERPRETERS.has(base) ? args.find((a) => !a.startsWith('-')) : null;
    for (const f of argFiles(src)) {
      if (scriptArg !== null && path.resolve(scriptArg) === f) continue;
      fileInTree(src.id, f);
    }
  }
  return out;
}
