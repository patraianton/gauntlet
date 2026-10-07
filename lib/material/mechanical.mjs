// Mechanical checks on the round snapshot (SPEC 9.5, D23, 11.2 step 5).
//
// Builtins: json-valid, count, file-exists, no-forbidden-text; plus `command` (allowlisted,
// exit 0 = pass, stdout lines = details). Paths and globs are snapshot-relative ("<as>/...").
// A check that cannot run (bad regex, refused executable, glob that matches nothing) fails:
// a check that proves nothing is not a pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileKind } from '../core/hash.mjs';
import { listFiles, readText } from '../core/fsx.mjs';
import { matchGlob } from '../core/glob.mjs';
import { runAllowed } from '../core/proc.mjs';
import { countFor, countKey } from './manifest.mjs';
import { isAllowedCmd } from './sources.mjs';

export const COMMAND_TIMEOUT_S = 120;
export const COMMAND_MAX_BYTES = 1024 * 1024;
export const MAX_DETAILS = 50;

const TEXT_KINDS = new Set(['text', 'json', 'html']);

function absOf(dir, rel) {
  return path.join(dir, ...String(rel).replace(/\\/g, '/').split('/'));
}

function cap(details) {
  if (details.length <= MAX_DETAILS) return details;
  return [...details.slice(0, MAX_DETAILS), `... and ${details.length - MAX_DETAILS} more`];
}

function jsonValid(check, dir, rels) {
  const glob = check.glob ?? '**/*.json';
  const matched = rels.filter((r) => matchGlob(r, glob));
  if (matched.length === 0) return { ok: false, details: [`no file matches ${glob}`] };
  const details = [];
  for (const r of matched) {
    try {
      JSON.parse(readText(absOf(dir, r)));
    } catch (e) {
      details.push(`${r}: ${e.message}`);
    }
  }
  return { ok: details.length === 0, details };
}

function count(check, dir) {
  if (typeof check.glob !== 'string') return { ok: false, details: ['count check needs a glob'] };
  const op = check.op ?? '=';
  const want = check.value;
  if (typeof want !== 'number') return { ok: false, details: ['count check needs a numeric value'] };
  const n = countFor(dir, { glob: check.glob, pointer: check.pointer });
  const ok = { '>=': n >= want, '=': n === want, '<=': n <= want }[op];
  if (ok === undefined) return { ok: false, details: [`unknown op "${op}"`] };
  return { ok, details: [`${countKey(check)}: ${n} (expected ${op} ${want})`] };
}

function fileExists(check, dir) {
  if (typeof check.path !== 'string' || check.path === '') return { ok: false, details: ['file-exists check needs a path'] };
  const r = check.path.replace(/\\/g, '/');
  if (r.split('/').includes('..') || path.isAbsolute(r)) return { ok: false, details: [`path must be relative to the material: ${check.path}`] };
  const abs = absOf(dir, r);
  const ok = fs.existsSync(abs) && fs.statSync(abs).isFile();
  return { ok, details: ok ? [] : [`missing: ${r}`] };
}

function noForbiddenText(check, dir, rels) {
  const glob = check.glob ?? '**/*';
  const res = [];
  for (const [i, p] of (check.patterns ?? []).entries()) {
    try {
      res.push({ src: p, re: new RegExp(p, 'gu') });
    } catch (e) {
      return { ok: false, details: [`patterns[${i}] does not compile: ${e.message}`] };
    }
  }
  if (res.length === 0) return { ok: false, details: ['no-forbidden-text check needs patterns'] };
  const matched = rels.filter((r) => TEXT_KINDS.has(fileKind(r)) && matchGlob(r, glob));
  if (matched.length === 0) return { ok: false, details: [`no text file matches ${glob}`] };
  const details = [];
  for (const r of matched) {
    const lines = readText(absOf(dir, r)).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { src, re } of res) {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m) details.push(`${r}:${i + 1}: "${m[0]}" (pattern ${src})`);
      }
    });
  }
  return { ok: details.length === 0, details: cap(details) };
}

function command(check, dir, allow, runner) {
  if (!isAllowedCmd(check.cmd, allow)) {
    return { ok: false, details: [`refused: "${check.cmd}" is not an allowed executable`] };
  }
  const args = (check.args ?? []).map((a) => String(a).replace(/\{snapshot\}/g, dir));
  let res;
  try {
    res = runner({ cmd: check.cmd, args, cwd: dir, timeoutS: COMMAND_TIMEOUT_S, allow, maxBytes: COMMAND_MAX_BYTES });
  } catch (e) {
    return { ok: false, details: [`could not run: ${e.message}`] };
  }
  const lines = String(res.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');
  if (res.timedOut) return { ok: false, details: cap([`timed out after ${COMMAND_TIMEOUT_S} s`, ...lines]) };
  const details = cap(lines);
  if (res.exitCode !== 0) {
    const err = String(res.stderr ?? '').trim();
    if (details.length === 0 && err) details.push(err.slice(0, 500));
    details.unshift(`exit code ${res.exitCode}`);
  }
  return { ok: res.exitCode === 0, details };
}

/**
 * runMechanical(mechanical, snapshotDir, { allow, runner? }) -> [{ id, ok, severity, what, details: [string] }]
 * `mechanical` may be the mechanical.json object or its `checks` array.
 */
export function runMechanical(mechanical, snapshotDir, opts = {}) {
  const checks = Array.isArray(mechanical) ? mechanical : (mechanical?.checks ?? []);
  const allow = opts.allow ?? [];
  const runner = opts.runner ?? runAllowed;
  const rels = listFiles(snapshotDir);
  return checks.map((c) => {
    let r;
    try {
      switch (c.kind) {
        case 'json-valid':
          r = jsonValid(c, snapshotDir, rels);
          break;
        case 'count':
          r = count(c, snapshotDir);
          break;
        case 'file-exists':
          r = fileExists(c, snapshotDir);
          break;
        case 'no-forbidden-text':
          r = noForbiddenText(c, snapshotDir, rels);
          break;
        case 'command':
          r = command(c, snapshotDir, allow, runner);
          break;
        default:
          r = { ok: false, details: [`unknown check kind "${c.kind}"`] };
      }
    } catch (e) {
      r = { ok: false, details: [`check failed to run: ${e.message}`] };
    }
    return { id: c.id, ok: r.ok, severity: c.severity, what: c.what, details: r.details };
  });
}
