// Path helpers (SPEC 7, 9, 23.1). Windows and POSIX are both supported: inputs may arrive as
// C:\x, C:/x, /c/x (Git Bash) or ~/x. Comparisons are lexical (no realpath) and
// case-insensitive on win32.

import path from 'node:path';
import os from 'node:os';
import { UsageError } from './errors.mjs';

function ctxOf(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  return {
    platform,
    win,
    P: win ? path.win32 : path.posix,
    home: opts.home ?? os.homedir(),
    cwd: opts.cwd ?? process.cwd(),
  };
}

/** Native absolute path from any accepted form. Trailing separators are removed (except a root). */
export function normalizeInput(p, opts = {}) {
  if (typeof p !== 'string' || p.trim() === '') throw new UsageError('empty path');
  const c = ctxOf(opts);
  let s = p.trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    s = s.slice(1, -1);
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = c.home + s.slice(1);
  }
  if (c.win) {
    // Git Bash / MSYS: /c/Users/x -> C:\Users\x ; /mnt/c/x (WSL style) -> C:\x
    let m = /^\/([a-zA-Z])(\/.*)?$/.exec(s.replace(/\\/g, '/'));
    if (m && !/^\/\//.test(s)) s = `${m[1].toUpperCase()}:${m[2] ?? '/'}`;
    else {
      m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s.replace(/\\/g, '/'));
      if (m) s = `${m[1].toUpperCase()}:${m[2] ?? '/'}`;
    }
    s = s.replace(/\//g, '\\');
  }
  let out = c.P.resolve(c.cwd, s);
  if (c.win && /^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  const root = c.P.parse(out).root;
  while (out.length > root.length && (out.endsWith('\\') || out.endsWith('/'))) out = out.slice(0, -1);
  return out;
}

/** Backslashes to forward slashes. */
export function toPosix(rel) {
  return String(rel).replace(/\\/g, '/');
}

/** Platform separators. */
export function toNative(p, opts = {}) {
  const c = ctxOf(opts);
  return c.win ? String(p).replace(/\//g, '\\') : String(p);
}

/**
 * True if child is parent itself or lies inside it (lexical; case-insensitive on win32).
 * Both inputs go through normalizeInput.
 */
export function isUnder(child, parent, opts = {}) {
  const c = ctxOf(opts);
  let a = normalizeInput(child, opts);
  let b = normalizeInput(parent, opts);
  if (c.win) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = c.P.relative(b, a);
  if (rel === '') return true;
  if (c.P.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return first !== '..';
}

/** POSIX relative path of abs inside root; throws UsageError when abs is outside. */
export function relPosix(root, abs, opts = {}) {
  const c = ctxOf(opts);
  if (!isUnder(abs, root, opts)) throw new UsageError(`${abs} is not inside ${root}`);
  const a = normalizeInput(abs, opts);
  const b = normalizeInput(root, opts);
  return toPosix(c.P.relative(b, a));
}

/** Path components of a native absolute path (root excluded). */
export function components(p, opts = {}) {
  const c = ctxOf(opts);
  const n = normalizeInput(p, opts);
  const root = c.P.parse(n).root;
  return n.slice(root.length).split(/[\\/]/).filter(Boolean);
}

/** Folder name (under the home folder) of the default run root. Neutral on purpose: reviewers must not meet the tool's name in a path. */
export const DEFAULT_RUN_ROOT_NAME = 'work-copies';

/**
 * The folders in which run folders and working copies may live (a documented, configurable
 * allow-list). Env GAUNTLET_RUN_ROOTS holds a list separated by `;`, a newline or the platform's
 * path delimiter; the entry `*` means "anywhere" (the material, review-base and data-home checks
 * still apply). Without the variable the only root is `<home>/work-copies`.
 * -> { any: boolean, roots: string[] } (roots are normalised absolute paths, in the given order).
 */
export function runRoots(opts = {}) {
  const env = opts.env ?? process.env;
  const c = ctxOf(opts);
  const raw = typeof env.GAUNTLET_RUN_ROOTS === 'string' ? env.GAUNTLET_RUN_ROOTS : '';
  const sep = c.win ? /[;\n]/ : /[;:\n]/;
  const items = raw.split(sep).map((x) => x.trim()).filter(Boolean);
  if (items.length === 0) return { any: false, roots: [normalizeInput(c.P.join(c.home, DEFAULT_RUN_ROOT_NAME), opts)] };
  const any = items.includes('*');
  const roots = items.filter((x) => x !== '*').map((x) => normalizeInput(x, opts));
  if (any && roots.length === 0) roots.push(normalizeInput(c.P.join(c.home, DEFAULT_RUN_ROOT_NAME), opts));
  return { any, roots };
}

/** The configured run root that strictly contains p, or null. */
export function runRootOf(p, opts = {}) {
  const c = ctxOf(opts);
  const n = normalizeInput(p, opts);
  const eq = (x, y) => (c.win ? x.toLowerCase() === y.toLowerCase() : x === y);
  for (const r of runRoots(opts).roots) {
    if (!eq(n, r) && isUnder(n, r, opts)) return r;
  }
  return null;
}

/**
 * A run folder must lie strictly inside one of the run roots (see runRoots), unless
 * GAUNTLET_TEST=1 or the roots include `*`. Throws UsageError otherwise. Returns the
 * normalised path.
 */
export function assertAllowedRunDir(p, opts = {}) {
  const env = opts.env ?? process.env;
  const n = normalizeInput(p, opts);
  if (env.GAUNTLET_TEST === '1') return n;
  const { any, roots } = runRoots(opts);
  if (any || runRootOf(n, opts)) return n;
  throw new UsageError(
    `run folder ${n} is not inside an allowed run root (${roots.join(', ')}); working copies live under a run root. ` +
      'Set GAUNTLET_RUN_ROOTS to a list of folders separated by ";" (or "*" for anywhere), or use the default <home>/' + DEFAULT_RUN_ROOT_NAME + '/<project>/',
  );
}
