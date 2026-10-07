// Strip rules on a review copy (SPEC 9.5, 11.2 step 6).
//
// applyStrip(copyDir, strip) applies, in this order:
//   1. strip.excludeGlobs  - matching files are deleted from the copy (logged as rule "exclude[i]");
//   2. strip.regex         - each rule replaces every match in the text/json/html files its glob
//                            selects (the 'g' flag is always added); BOM and line endings are kept.
// `expect` is checked over the total number of matches of a rule across all its files:
//   "any" - no check; "atLeastOne" - at least one match; "zero" - no match at all.
// A violated expect, an uncompilable rule, or a JSON file that no longer parses after a rule
// are returned in `violations` (the engine turns any violation into BLOCKED_TRACE).

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { fileKind } from '../core/hash.mjs';
import { listFiles, readRaw, writeRaw } from '../core/fsx.mjs';
import { matchGlob } from '../core/glob.mjs';

const TEXT_KINDS = new Set(['text', 'json', 'html']);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Split a file buffer into { bom, text } (text decoded as UTF-8). */
export function decodeKeepBom(buf) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { bom: hasBom, text: (hasBom ? buf.subarray(3) : buf).toString('utf8') };
}

/** Encode text back with the BOM it had. Line endings are whatever the text contains. */
export function encodeKeepBom(text, bom) {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([BOM, body]) : body;
}

function regexFlags(flags) {
  const set = new Set(String(flags ?? '').split('').filter(Boolean));
  set.add('g');
  return [...set].join('');
}

function jsonParses(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * applyStrip(copyDir, strip) -> { log: [{ rule, file, matches }], violations: [{ rule, expect, matches, why?, file?, error? }],
 *                                 excluded: [rel] }
 */
export function applyStrip(copyDir, strip) {
  const s = strip ?? {};
  const log = [];
  const violations = [];
  const excluded = [];

  // 1. exclude globs
  const excludeGlobs = s.excludeGlobs ?? [];
  if (!Array.isArray(excludeGlobs)) throw new UsageError('strip.excludeGlobs must be a list');
  for (const rel of listFiles(copyDir)) {
    const i = excludeGlobs.findIndex((g) => matchGlob(rel, g));
    if (i < 0) continue;
    fs.rmSync(path.join(copyDir, ...rel.split('/')), { force: true });
    excluded.push(rel);
    log.push({ rule: `exclude[${i}]`, file: rel, matches: 1 });
  }
  removeEmptyDirs(copyDir);

  // 2. regex rules
  const rules = s.regex ?? [];
  if (!Array.isArray(rules)) throw new UsageError('strip.regex must be a list');
  const files = listFiles(copyDir);
  rules.forEach((rule, i) => {
    const id = `regex[${i}]`;
    const expect = rule.expect ?? 'any';
    let re;
    try {
      re = new RegExp(rule.pattern, regexFlags(rule.flags));
    } catch (e) {
      violations.push({ rule: id, expect, matches: 0, why: rule.why, error: `pattern does not compile: ${e.message}` });
      return;
    }
    const replacement = rule.replace ?? '';
    let total = 0;
    for (const rel of files) {
      if (!TEXT_KINDS.has(fileKind(rel))) continue;
      if (!matchGlob(rel, rule.glob ?? '**/*')) continue;
      const abs = path.join(copyDir, ...rel.split('/'));
      if (!fs.existsSync(abs)) continue;
      const { bom, text } = decodeKeepBom(readRaw(abs));
      let n = 0;
      for (const _m of text.matchAll(re)) n++;
      if (n === 0) continue;
      total += n;
      const out = text.replace(re, replacement);
      if (out !== text) {
        if (fileKind(rel) === 'json' && jsonParses(text) && !jsonParses(out)) {
          violations.push({ rule: id, expect: 'json-valid', matches: n, why: rule.why, file: rel, error: 'the JSON file no longer parses after this rule' });
        }
        writeRaw(abs, encodeKeepBom(out, bom));
      }
      log.push({ rule: id, file: rel, matches: n });
    }
    if (expect === 'atLeastOne' && total < 1) violations.push({ rule: id, expect, matches: total, why: rule.why });
    else if (expect === 'zero' && total > 0) violations.push({ rule: id, expect, matches: total, why: rule.why });
    else if (!['any', 'atLeastOne', 'zero'].includes(expect)) {
      violations.push({ rule: id, expect, matches: total, why: rule.why, error: `unknown expect "${expect}"` });
    }
  });

  return { log, violations, excluded };
}

/** Remove folders left empty by excludes (bottom-up). The copy root itself stays. */
function removeEmptyDirs(root) {
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (!walk(p)) empty = false;
        else fs.rmdirSync(p);
      } else empty = false;
    }
    return empty;
  };
  walk(root);
}
