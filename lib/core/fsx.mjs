// File helpers (SPEC 1.3, 23.1). Our own files are UTF-8 without BOM, LF, written
// atomically (temp file + rename). Artifact files are copied byte-exact.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { UsageError } from './errors.mjs';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/** Synchronous sleep (used only for short retry back-offs). */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Text with a leading BOM removed. Line endings are left as they are. */
export function readText(p) {
  const s = fs.readFileSync(p, 'utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function readJson(p) {
  const text = readText(p);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new SyntaxError(`invalid JSON in ${p}: ${e.message}`);
    err.path = p;
    throw err;
  }
}

export function readRaw(p) {
  return fs.readFileSync(p);
}

function toLfNoBom(s) {
  let t = String(s);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n');
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt < 5 && RETRY_CODES.has(e.code)) {
        sleepMs(50 * (attempt + 1));
        continue;
      }
      try {
        fs.unlinkSync(from);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}

function atomicWrite(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  renameWithRetry(tmp, p);
}

/** Write text atomically as UTF-8, no BOM, LF line endings. */
export function writeTextAtomic(p, s) {
  atomicWrite(p, Buffer.from(toLfNoBom(s), 'utf8'));
}

/** Write JSON atomically: 2-space indent, trailing newline. */
export function writeJsonAtomic(p, v) {
  const s = JSON.stringify(v, null, 2);
  if (s === undefined) throw new UsageError(`writeJsonAtomic: value for ${p} is not JSON`);
  writeTextAtomic(p, s + '\n');
}

/** Bytes written atomically, unchanged. */
export function writeRaw(p, buf) {
  atomicWrite(p, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}

/**
 * Create a file that must not exist yet (flag 'wx'). Strings are written as UTF-8
 * exactly as given (no line-ending change: used for verbatim copies); Buffers raw.
 * Throws the native EEXIST error when the file exists.
 */
export function writeExclusive(p, s) {
  ensureDir(path.dirname(p));
  const data = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
  const fd = fs.openSync(p, 'wx');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Append one line (a trailing LF is added). The line itself may not contain a newline. */
export function appendLine(p, s) {
  const line = String(s);
  if (/[\r\n]/.test(line)) throw new UsageError('appendLine: the line contains a newline');
  ensureDir(path.dirname(p));
  const fd = fs.openSync(p, 'a');
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function isLink(st) {
  return st.isSymbolicLink();
}

/**
 * All files under root as sorted POSIX relative paths. Links are not followed into:
 * a link to a file is listed (copyFiles copies its target content); a link to a
 * directory, a junction or a broken link is skipped. Any `.git` entry is skipped.
 */
export function listFiles(root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(childAbs);
      if (isLink(st)) {
        let target;
        try {
          target = fs.statSync(childAbs);
        } catch {
          continue; // broken link
        }
        if (target.isFile()) out.push(childRel);
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
    }
  };
  walk(root, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * Entries under root that listFiles skips silently: links to folders, NTFS junctions and broken
 * links (sorted POSIX relative paths; `.git` ignored). Their files never reach a snapshot, so the
 * engine reports them instead of reviewing less than the owner thinks (failure point 8).
 */
export function listSkippedLinks(root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(childAbs);
      if (isLink(st)) {
        let target = null;
        try {
          target = fs.statSync(childAbs);
        } catch {
          target = null;
        }
        if (!target || !target.isFile()) out.push(childRel);
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function assertSafeRel(rel) {
  const r = String(rel).replace(/\\/g, '/');
  if (r === '' || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.split('/').some((c) => c === '..' || c === '')) {
    throw new UsageError(`unsafe relative path: ${rel}`);
  }
  return r;
}

/** Byte-exact copy of the listed files (relative POSIX paths) from srcRoot into dstRoot. */
export function copyFiles(srcRoot, rels, dstRoot) {
  for (const rel of rels) {
    const r = assertSafeRel(rel);
    const parts = r.split('/');
    const src = path.join(srcRoot, ...parts);
    const dst = path.join(dstRoot, ...parts);
    ensureDir(path.dirname(dst));
    const data = fs.readFileSync(src); // follows a file link: its target content
    fs.writeFileSync(dst, data);
  }
}

/** Paths of every symlink/junction inside p (p included). Does not follow links. */
export function findLinks(p) {
  const found = [];
  const walk = (abs) => {
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (isLink(st)) {
      found.push(abs);
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
    }
  };
  walk(p);
  return found;
}

function isDangerousRoot(abs) {
  const resolved = path.resolve(abs);
  const root = path.parse(resolved).root;
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x).replace(/[\\/]+$/, '');
  if (norm(resolved) === norm(root)) return true;
  if (norm(resolved) === norm(os.homedir())) return true;
  return false;
}

/**
 * Remove a file or a folder tree. Refuses (removes nothing) when the tree contains a
 * symlink or junction anywhere, or when p is a drive root or the home folder.
 * Retries EBUSY/EPERM 3 times. A path that does not exist counts as removed.
 * -> { removed, refused: [paths], leftovers: [paths] }
 */
export function safeRemove(p) {
  const abs = path.resolve(p);
  if (!exists(abs)) return { removed: true, refused: [], leftovers: [] };
  if (isDangerousRoot(abs)) return { removed: false, refused: [abs], leftovers: [abs] };
  const links = findLinks(abs);
  if (links.length) return { removed: false, refused: links, leftovers: [abs] };
  let lastErr = null;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      fs.rmSync(abs, { recursive: true, force: true, maxRetries: 0 });
      lastErr = null;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code)) break;
    }
    if (!exists(abs)) return { removed: true, refused: [], leftovers: [] };
    if (attempt < 3) sleepMs(100 * (attempt + 1));
  }
  const leftovers = [];
  const walk = (x) => {
    let st;
    try {
      st = fs.lstatSync(x);
    } catch {
      return;
    }
    leftovers.push(x);
    if (st.isDirectory() && !isLink(st)) for (const n of fs.readdirSync(x)) walk(path.join(x, n));
  };
  walk(abs);
  const res = { removed: leftovers.length === 0, refused: [], leftovers };
  if (lastErr) res.error = `${lastErr.code ?? ''} ${lastErr.message}`.trim();
  return res;
}
