// Shape check of mechanical.json BEFORE freeze (setup) and at `amend --what mechanical`.
//
// The JSON schema only knows the union of all fields; it cannot say "file-exists takes `path`, not
// `glob`". In a night run two file-exists checks were written with `glob`, the file
// was accepted at freeze and failed only at round 1 (BLOCKED_PRECHECK, ~32 minutes lost, and the fix
// needed the owner's words because a changed check counts as narrowing). So the shape is refused
// here, with the check id, what is wrong and the exact fix, while the window can still fix its own file.
//
// mechanicalProblems(mechanical, { files, allow, schemaErrors }) -> [string]; empty = the file is sound.
// The runtime (mechanical.mjs) keeps its own fail-closed messages for files that bypass this check.

import path from 'node:path';
import { fileKind } from '../core/hash.mjs';
import { matchGlob } from '../core/glob.mjs';
import { arrayLengthAt } from './manifest.mjs';
import { isAllowedCmd } from './sources.mjs';

export const KINDS = Object.freeze(['json-valid', 'count', 'file-exists', 'no-forbidden-text', 'command']);
const COMMON = ['id', 'what', 'severity', 'kind'];
// field -> the kinds it belongs to
export const FIELD_KINDS = Object.freeze({
  glob: ['json-valid', 'count', 'no-forbidden-text'],
  pointer: ['count'],
  op: ['count'],
  value: ['count'],
  path: ['file-exists'],
  patterns: ['no-forbidden-text'],
  cmd: ['command'],
  args: ['command'],
});
const REQUIRED = { 'json-valid': [], count: ['glob', 'value'], 'file-exists': ['path'], 'no-forbidden-text': ['patterns'], command: ['cmd'] };
const WILDCARD = /[*?[\]{}]/;
const TEXT_KINDS = new Set(['text', 'json', 'html']);
const q = (s) => JSON.stringify(s);

function fieldsOf(kind) {
  return Object.keys(FIELD_KINDS).filter((f) => FIELD_KINDS[f].includes(kind));
}

function rootsOf(rels) {
  return [...new Set(rels.map((r) => r.split('/')[0]))].sort();
}

function similar(rels, wanted, n = 3) {
  const base = String(wanted).replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!base) return [];
  return rels.filter((r) => r.split('/').pop().toLowerCase() === base).slice(0, n);
}

function whereHint(rels, pattern) {
  const roots = rootsOf(rels);
  if (roots.length === 0) return 'The material has no files at all.';
  const first = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0];
  if (!roots.includes(first) && !WILDCARD.test(first)) {
    return `"${first}" is not a material root name: paths start with the root name (${roots.join(', ')}), for example "${roots[0]}/...".`;
  }
  return `Paths start with the root name (${roots.join(', ')}).`;
}

function exactMatch(rels, rel) {
  if (rels.includes(rel)) return true;
  return process.platform === 'win32' && rels.some((r) => r.toLowerCase() === rel.toLowerCase());
}

function countOver(files, spec) {
  const matched = files.filter((f) => matchGlob(f.rel, spec.glob));
  if (!spec.pointer) return { matched: matched.length, usable: matched.length };
  let usable = 0;
  for (const f of matched) if (arrayLengthAt(f.abs, spec.pointer) !== null) usable++;
  return { matched: matched.length, usable };
}

function oneCheck(c, i, ctx) {
  const out = [];
  const id = typeof c.id === 'string' && c.id !== '' ? c.id : `checks[${i}]`;
  const kind = c.kind;
  const say = (msg) => out.push(`${id}: ${msg}`);

  if (typeof c.id !== 'string' || !/^K[0-9]{1,2}$/.test(c.id)) say('"id" must be K followed by one or two digits (K1, K12). Fix: rename it.');
  if (typeof c.what !== 'string' || c.what.trim() === '') say('"what" is missing or empty. Fix: add one plain sentence that says what the check proves.');
  if (!['blocker', 'major', 'cosmetic'].includes(c.severity)) say(`"severity" must be blocker, major or cosmetic (got ${q(c.severity)}). Fix: pick one.`);

  if (kind === undefined && typeof c.type === 'string') {
    say(`has "type" ${q(c.type)}, but the field is called "kind". Fix: rename "type" to "kind" (kinds: ${KINDS.join(', ')}).`);
    return out;
  }
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    say(`"kind" ${kind === undefined ? 'is missing' : `${q(kind)} is not a known kind`}. Fix: set "kind" to one of ${KINDS.join(', ')}.`);
    return out;
  }

  const allowedHere = new Set([...COMMON, ...fieldsOf(kind)]);
  for (const f of Object.keys(c)) {
    if (allowedHere.has(f)) continue;
    if (FIELD_KINDS[f]) {
      let fix = `delete "${f}" from ${id}, or change its "kind" to ${FIELD_KINDS[f].map(q).join(' or ')}`;
      if (kind === 'file-exists' && f === 'glob' && c.path === undefined) {
        fix =
          typeof c.glob === 'string' && c.glob !== '' && !WILDCARD.test(c.glob)
            ? `rename "glob" to "path" (use "path": ${q(c.glob)})`
            : `a file-exists check names ONE exact file in "path"; to test that a pattern matches something use kind "count" with "glob": ${q(c.glob)}, "op": ">=", "value": 1`;
      }
      say(`kind "${kind}" has the field "${f}", which belongs to ${FIELD_KINDS[f].map((k) => `"${k}"`).join(' / ')} checks. Fix: ${fix}.`);
    } else {
      say(`has an unknown field "${f}". Fix: delete it (kind "${kind}" takes: ${fieldsOf(kind).join(', ') || 'no extra fields'}).`);
    }
  }
  for (const f of REQUIRED[kind]) {
    if (c[f] === undefined || c[f] === null || c[f] === '') {
      // The misplaced-field message above already names the fix for the file-exists glob case.
      if (kind === 'file-exists' && f === 'path' && c.glob !== undefined) continue;
      const hint = kind === 'file-exists' ? ' (the exact file, relative to the material, starting with the root name)' : kind === 'count' && f === 'value' ? ' (a number)' : '';
      say(`kind "${kind}" needs the field "${f}"${hint}. Fix: add "${f}".`);
    }
  }
  if (out.length) return out;

  // ---- field types and contents, per kind
  const isStr = (v) => typeof v === 'string' && v !== '';
  if (c.glob !== undefined && !isStr(c.glob)) say('"glob" must be a non-empty text. Fix: write the pattern as a string.');
  if (kind === 'count') {
    if (c.op !== undefined && !['>=', '=', '<='].includes(c.op)) say(`"op" must be ">=", "=" or "<=" (got ${q(c.op)}). Fix: use one of them.`);
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) say(`"value" must be a number (got ${q(c.value)}). Fix: write the expected count without quotes.`);
    if (c.pointer !== undefined && (typeof c.pointer !== 'string' || (c.pointer !== '' && !c.pointer.startsWith('/')))) say(`"pointer" must be a JSON pointer starting with "/" (got ${q(c.pointer)}). Fix: for example "/posts".`);
  }
  if (kind === 'file-exists') {
    if (!isStr(c.path)) say('"path" must be a non-empty text. Fix: write the exact file, for example "work/PRODUCT.md".');
    else {
      const r = c.path.replace(/\\/g, '/');
      if (r.split('/').includes('..') || path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) say(`"path" ${q(c.path)} must be relative to the material and must not contain "..". Fix: write it as "<root name>/<file>".`);
      else if (WILDCARD.test(r)) say(`"path" ${q(c.path)} contains pattern characters, but a file-exists check names ONE exact file. Fix: write the exact file, or use kind "count" with "glob": ${q(c.path)}, "op": ">=", "value": 1.`);
    }
  }
  if (kind === 'no-forbidden-text') {
    if (!Array.isArray(c.patterns) || c.patterns.length === 0) say('"patterns" must be a non-empty list of texts. Fix: for example ["TODO", "XXX"].');
    else {
      c.patterns.forEach((p, k) => {
        if (typeof p !== 'string' || p === '') {
          say(`patterns[${k}] must be a non-empty text. Fix: remove it or write the pattern.`);
          return;
        }
        try {
          new RegExp(p, 'gu');
        } catch (e) {
          say(`patterns[${k}] ${q(p)} is not a valid regular expression (${e.message}). Fix: escape special characters with a backslash (in JSON a double one) or write plain words.`);
        }
      });
    }
  }
  if (kind === 'command') {
    if (!isStr(c.cmd)) say('"cmd" must be a non-empty text. Fix: the program name, for example "node".');
    else if (ctx.allow && !isAllowedCmd(c.cmd, ctx.allow)) {
      const why = /[\\/]/.test(c.cmd) ? 'a program must be given by name only, without a folder' : `it is not in run.json "allowExecutables" (${ctx.allow.join(', ') || 'empty'})`;
      say(`command ${q(c.cmd)} is refused: ${why}. Fix: use an allowed program, or add its name to allowExecutables in run.json before the first step.`);
    }
    if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string'))) say('"args" must be a list of texts. Fix: write every argument as a string.');
  }
  if (out.length || !ctx.files) return out;

  // ---- does it match anything in the material
  const rels = ctx.files.map((f) => f.rel);
  if (kind === 'file-exists') {
    const rel = c.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!exactMatch(rels, rel)) {
      const near = similar(rels, rel);
      const asFolder = rels.some((r) => r.startsWith(rel.replace(/\/+$/, '') + '/'));
      say(
        `file-exists path ${q(c.path)} is not a file in the material (${rels.length} files). ${asFolder ? 'It is a folder; name a file in it. ' : ''}${whereHint(rels, rel)}` +
          `${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Fix: correct "path" to a file that exists; if the file is really missing, fix the material first.`,
      );
    }
  } else if (kind === 'json-valid') {
    const g = c.glob ?? '**/*.json';
    if (!rels.some((r) => matchGlob(r, g))) say(`json-valid glob ${q(g)}${c.glob === undefined ? ' (the default)' : ''} matches no file in the material (${rels.length} files). ${whereHint(rels, g)} Fix: correct "glob" to match the JSON files you mean.`);
  } else if (kind === 'no-forbidden-text') {
    const g = c.glob ?? '**/*';
    if (!rels.some((r) => TEXT_KINDS.has(fileKind(r)) && matchGlob(r, g))) say(`no-forbidden-text glob ${q(g)}${c.glob === undefined ? ' (the default)' : ''} matches no text file in the material (${rels.length} files). ${whereHint(rels, g)} Fix: correct "glob" to match the text files you mean.`);
  } else if (kind === 'count') {
    const op = c.op ?? '=';
    const zeroOk = { '>=': 0 >= c.value, '=': c.value === 0, '<=': 0 <= c.value }[op];
    const r = countOver(ctx.files, c);
    if (r.matched === 0 && !zeroOk) {
      say(`count glob ${q(c.glob)} matches no file in the material (${rels.length} files), so the count is 0 and "${op} ${c.value}" can never hold. ${whereHint(rels, c.glob)} Fix: correct "glob".`);
    } else if (c.pointer && r.matched > 0 && r.usable === 0 && !zeroOk) {
      say(`count pointer ${q(c.pointer)} does not give a list in any of the ${r.matched} file(s) matched by ${q(c.glob)}, so the count is 0 and "${op} ${c.value}" can never hold. Fix: correct "pointer" (a JSON pointer to a list, for example "/posts") or "glob".`);
    }
  }
  return out;
}

/**
 * mechanicalProblems(mechanical, { files?, allow?, schemaErrors? }) -> [string]
 * Each line starts with the check id and says what is wrong and the exact fix. Empty = the file is sound.
 *   files   [{ rel: "<as>/<path>", abs }] the material the round snapshot will hold (selectLiveFiles);
 *           omit to skip the "matches nothing" checks
 *   allow   run.json allowExecutables; omit to skip the command allowlist
 *   skipMaterial  Set of check ids whose "matches nothing" test is skipped (amend: a check kept exactly as
 *           frozen is not refused because the material moved on; it fails the round the usual way)
 *   schemaErrors  [{ path, message }] from the JSON schema: the top-level ones are always kept, a check's
 *           own (a wrong text type, a pattern) only when the shape check found nothing else for that check
 */
export function mechanicalProblems(mechanical, { files = null, allow = null, schemaErrors = [], skipMaterial = null } = {}) {
  if (!mechanical || typeof mechanical !== 'object' || Array.isArray(mechanical)) return ['mechanical.json must be an object like { "schemaVersion": 1, "checks": [ ... ] }.'];
  const out = [];
  const inCheck = (e) => /^\/checks\/(\d+)(\/|$)/.exec(e.path || '');
  for (const e of schemaErrors) if (!inCheck(e)) out.push(`${e.path || '/'}: ${e.message}`);
  if (!Array.isArray(mechanical.checks)) return out.length ? out : ['mechanical.json "checks" must be a list. Fix: "checks": [ ... ].'];
  const seen = new Map();
  mechanical.checks.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      out.push(`checks[${i}]: must be an object with id, what, severity, kind. Fix: replace it.`);
      return;
    }
    const mine = oneCheck(c, i, { files: skipMaterial && skipMaterial.has(c.id) ? null : files, allow });
    if (typeof c.id === 'string') {
      if (seen.has(c.id)) mine.push(`${c.id}: the id is used twice (checks[${seen.get(c.id)}] and checks[${i}]). Fix: give every check its own id.`);
      else seen.set(c.id, i);
    }
    if (mine.length === 0) {
      for (const e of schemaErrors) {
        const m = inCheck(e);
        if (m && Number(m[1]) === i) mine.push(`${c.id ?? `checks[${i}]`}: ${e.path}: ${e.message}`);
      }
    }
    out.push(...mine);
  });
  return out;
}

/** The refusal text for a list of problems (setup to-do lines and the amend usage error use it). */
export function mechanicalRefusal(problems) {
  return `mechanical.json is not sound; fix the file and run again (this is the executor's own file, no owner words are needed before freeze):\n  ${problems.slice(0, 30).join('\n  ')}${problems.length > 30 ? `\n  ... and ${problems.length - 30} more` : ''}`;
}

/**
 * Ids of the checks of a (frozen) mechanical.json that could never run because their shape is wrong
 * (a file-exists with "glob", a missing field, a program outside the allowlist). The material is not
 * judged here. `amend` uses it: replacing such a check by a sound one with the same id adds a check
 * that really runs and removes none that ever did, so it is not narrowing and needs no owner words.
 * Deleting it is still narrowing.
 */
export function unrunnableCheckIds(mechanical, { allow = null } = {}) {
  const out = [];
  if (!mechanical || !Array.isArray(mechanical.checks)) return out;
  mechanical.checks.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string') return;
    if (oneCheck(c, i, { files: null, allow }).length > 0) out.push(c.id);
  });
  return out;
}

/**
 * What an `amend --what mechanical` file narrows, as owner-visible lines: a frozen check that is gone or
 * changed. One exception: a frozen check that could never run (unrunnableCheckIds) may be replaced by a
 * sound one with the same id and a severity that is not lower, because nothing that ever ran is lost.
 * Deleting such a check, or lowering its severity, is still narrowing.
 */
export function mechanicalNarrowing(oldMech, nextMech, { allow = null } = {}) {
  const rank = { blocker: 3, major: 2, cosmetic: 1 };
  const oldChecks = oldMech?.checks || [];
  const nextChecks = nextMech?.checks || [];
  const neverRan = new Set(unrunnableCheckIds(oldMech, { allow }));
  const out = [];
  for (const c of oldChecks) {
    if (nextChecks.some((n) => JSON.stringify(n) === JSON.stringify(c))) continue;
    const repl = nextChecks.find((n) => n && n.id === c.id);
    if (neverRan.has(c.id) && repl && (rank[repl.severity] ?? 0) >= (rank[c.severity] ?? 3)) continue;
    out.push(`mechanical check ${c.id} removed or changed`);
  }
  return out;
}
