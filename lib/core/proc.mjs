// Child processes (SPEC 1.3, 23.1): spawnSync with shell:false and windowsHide:true,
// never a shell string. Only bare executable names from an allowlist are run; the
// name is resolved on PATH (PATHEXT on win32). Batch files (.cmd/.bat) are refused:
// Windows can only run them through cmd.exe, which would be a shell.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UsageError } from './errors.mjs';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const BATCH = new Set(['.cmd', '.bat']);

function envGet(env, name, win) {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function baseName(cmd, win) {
  let b = cmd;
  if (win) {
    const ext = path.win32.extname(b).toLowerCase();
    if (['.exe', '.com', '.cmd', '.bat'].includes(ext)) b = b.slice(0, -ext.length);
    b = b.toLowerCase();
  }
  return b;
}

/** True if cmd (a bare name, optionally with .exe on win32) is in allow. */
export function isAllowed(cmd, allow, opts = {}) {
  const win = (opts.platform ?? process.platform) === 'win32';
  if (!Array.isArray(allow) || allow.length === 0) return false;
  const b = baseName(String(cmd), win);
  return allow.some((a) => baseName(String(a), win) === b);
}

/**
 * Resolve a bare executable name on PATH. -> absolute path. Throws UsageError if the
 * name contains a path separator, is not found, or only exists as a batch file.
 */
export function resolveExecutable(cmd, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const env = opts.env ?? process.env;
  const P = win ? path.win32 : path.posix;
  if (typeof cmd !== 'string' || cmd === '' || /[\\/]/.test(cmd) || (win && /:/.test(cmd))) {
    throw new UsageError(`executable must be a bare name from the allowlist, not a path: ${cmd}`);
  }
  const dirs = String(envGet(env, 'PATH', win) ?? '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  let exts = [''];
  if (win) {
    const pathext = String(envGet(env, 'PATHEXT', win) ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const own = P.extname(cmd).toLowerCase();
    exts = own && pathext.includes(own) ? [''] : pathext;
  }
  let batchOnly = null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = P.join(dir, cmd + ext);
      let st;
      try {
        st = fs.statSync(cand);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (win) {
        const e = P.extname(cand).toLowerCase();
        if (BATCH.has(e)) {
          batchOnly = batchOnly ?? cand;
          continue;
        }
        if (!['.exe', '.com'].includes(e)) continue;
        return cand;
      }
      try {
        fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch {
        continue;
      }
    }
  }
  if (batchOnly) throw new UsageError(`${cmd} resolves only to a batch file (${batchOnly}); it cannot run without a shell`);
  throw new UsageError(`executable not found on PATH: ${cmd}`);
}

function decode(buf) {
  if (buf === null || buf === undefined) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * runAllowed({ cmd, args, cwd, env, timeoutS, allow, maxBytes })
 *   -> { exitCode, stdout, stderr, timedOut, truncated, resolved, error }
 * env entries are added on top of the current environment. Refuses (UsageError)
 * a cmd that is not on the allowlist or not a bare name. Output beyond maxBytes is
 * cut (truncated: true) and the child is stopped.
 */
export function runAllowed(opts) {
  const { cmd, args = [], cwd, env, timeoutS = 30, allow, maxBytes = DEFAULT_MAX_BYTES } = opts ?? {};
  const platform = opts?.platform ?? process.platform;
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new UsageError('args must be an array of strings');
  if (!isAllowed(cmd, allow, { platform })) {
    throw new UsageError(`executable not on the allowlist: ${cmd} (allowed: ${(allow ?? []).join(', ') || 'none'})`);
  }
  const fullEnv = { ...process.env, ...(env ?? {}) };
  const resolved = resolveExecutable(cmd, { platform, env: fullEnv });
  const r = spawnSync(resolved, args, {
    shell: false,
    windowsHide: true,
    cwd,
    env: fullEnv,
    timeout: Math.max(1, Math.round(Number(timeoutS) * 1000)),
    maxBuffer: maxBytes,
    encoding: 'buffer',
    killSignal: 'SIGKILL',
  });
  const errCode = r.error?.code ?? null;
  const timedOut = errCode === 'ETIMEDOUT';
  const truncated = errCode === 'ENOBUFS';
  let stdout = r.stdout ?? Buffer.alloc(0);
  let stderr = r.stderr ?? Buffer.alloc(0);
  if (stdout.length > maxBytes) stdout = stdout.subarray(0, maxBytes);
  if (stderr.length > maxBytes) stderr = stderr.subarray(0, maxBytes);
  return {
    exitCode: typeof r.status === 'number' ? r.status : null,
    stdout: decode(stdout),
    stderr: decode(stderr),
    timedOut,
    truncated,
    resolved,
    error: r.error && !timedOut && !truncated ? `${errCode ?? ''} ${r.error.message}`.trim() : null,
  };
}
