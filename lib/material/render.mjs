// Prompt rendering from frozen templates (SPEC 15.1, 15.5).
//
// Syntax:  {{NAME}}             substitution
//          {{#NAME}}...{{/NAME}} section, kept only when NAME's value is non-empty
// Rules:   a placeholder or section anywhere in the template (also inside a dropped section)
//          whose NAME is not a key of `values`                          -> UsageError (unknown)
//          a rendered {{NAME}} whose value is undefined or null         -> UsageError (missing)
//          a section value of null/undefined/""/[]/{}/false counts as empty (section dropped)
//          a "{{" that does not form a valid tag, or an unclosed section  -> UsageError
// Values are substituted in one pass, so a value that contains "{{X}}" is never expanded.
// Arrays are joined with newlines; objects are written as indented JSON.
// The prompt lint runs over the substituted values only, never over the frozen template text.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, IntegrityError } from '../core/errors.mjs';
import { hashFile, sha256Hex } from '../core/hash.mjs';
import { readJson, readRaw, readText } from '../core/fsx.mjs';
import { lintValues, loadPatterns } from './lint.mjs';

const TAG = /\{\{\s*([#/]?)\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const NAME_OK = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A new global tag RegExp (matchAll/replace must not inherit a lastIndex left by exec). */
function freshTag() {
  return new RegExp(TAG.source, 'g');
}

function isEmptyValue(v) {
  if (v === undefined || v === null || v === false) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** The text a value is substituted as. */
export function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(valueText).join('\n');
  return JSON.stringify(v, null, 2);
}

function checkKnown(name, values, where) {
  if (!Object.prototype.hasOwnProperty.call(values, name)) {
    throw new UsageError(`unknown placeholder {{${where}${name}}}: no value with this name was given`, { placeholder: name });
  }
}

function checkName(name, values, where) {
  checkKnown(name, values, where);
  const v = values[name];
  if (v === undefined || v === null) {
    throw new UsageError(`missing value for placeholder {{${where}${name}}}`, { placeholder: name });
  }
}

/** Every "{{" in the text must start a well-formed tag. */
function assertWellFormed(text) {
  let i = text.indexOf('{{');
  while (i !== -1) {
    TAG.lastIndex = i;
    const m = TAG.exec(text);
    if (!m || m.index !== i) {
      const snippet = text.slice(i, i + 40).split('\n')[0];
      throw new UsageError(`malformed placeholder near "${snippet}"`);
    }
    i = text.indexOf('{{', i + m[0].length);
  }
}

/** Resolve sections (innermost first is not needed: sections are matched by name and nest naturally). */
function renderSections(text, values) {
  let out = '';
  let pos = 0;
  TAG.lastIndex = 0;
  for (;;) {
    TAG.lastIndex = pos;
    const m = TAG.exec(text);
    if (!m) {
      out += text.slice(pos);
      return out;
    }
    const [whole, sigil, name] = m;
    if (sigil === '/') throw new UsageError(`section end {{/${name}}} without a start`);
    if (sigil === '') {
      out += text.slice(pos, m.index + whole.length);
      pos = m.index + whole.length;
      continue;
    }
    // section start: find the matching end, counting nested sections of the same name
    checkKnown(name, values, '#');
    let depth = 1;
    let j = m.index + whole.length;
    let end = null;
    while (depth > 0) {
      TAG.lastIndex = j;
      const n = TAG.exec(text);
      if (!n) break;
      if (n[2] === name && n[1] === '#') depth++;
      if (n[2] === name && n[1] === '/') depth--;
      j = n.index + n[0].length;
      if (depth === 0) end = n;
    }
    if (!end) throw new UsageError(`section {{#${name}}} is not closed`);
    const inner = text.slice(m.index + whole.length, end.index);
    out += text.slice(pos, m.index);
    if (!isEmptyValue(values[name])) out += renderSections(inner, values);
    pos = end.index + end[0].length;
  }
}

/** renderTemplate(text, values) -> string (see the rules at the top of this file). */
export function renderTemplate(text, values) {
  if (typeof text !== 'string') throw new UsageError('template text must be a string');
  const vals = values ?? {};
  for (const k of Object.keys(vals)) if (!NAME_OK.test(k)) throw new UsageError(`bad placeholder name in values: ${k}`);
  assertWellFormed(text);
  for (const m of text.matchAll(freshTag())) checkKnown(m[2], vals, m[1]);
  const withSections = renderSections(text, vals);
  return withSections.replace(freshTag(), (whole, sigil, name) => {
    if (sigil) throw new UsageError(`unexpected section tag {{${sigil}${name}}}`);
    checkName(name, vals, '');
    return valueText(vals[name]);
  });
}

/** Placeholder and section names used by a template: { placeholders: [], sections: [] }. */
export function templateNames(text) {
  const placeholders = new Set();
  const sections = new Set();
  for (const m of String(text).matchAll(freshTag())) {
    if (m[1] === '#') sections.add(m[2]);
    else if (m[1] === '') placeholders.add(m[2]);
  }
  return { placeholders: [...placeholders].sort(), sections: [...sections].sort() };
}

function hashesOf(p) {
  return [hashFile(p), sha256Hex(readRaw(p))];
}

/**
 * verifyRunTemplate(templatesDir, name) -> void | throws IntegrityError
 * After freeze (<run>/FROZEN.json exists): the file must match FROZEN.sha256.templates[name]
 * (FROZEN_MISMATCH). Before freeze: it must match <templatesDir>/MANIFEST.json files[name]
 * (TEMPLATE_MISMATCH). A hash may be of the normalised text (hashFile) or of the raw bytes.
 */
export function verifyRunTemplate(templatesDir, name) {
  const file = path.join(templatesDir, name);
  if (!fs.existsSync(file)) throw new IntegrityError('TEMPLATE_MISMATCH', `run template missing: ${name}`);
  const have = hashesOf(file);
  const frozenPath = path.join(path.dirname(templatesDir), 'FROZEN.json');
  if (fs.existsSync(frozenPath)) {
    let want;
    try {
      want = readJson(frozenPath)?.sha256?.templates?.[name];
    } catch (e) {
      throw new IntegrityError('FROZEN_MISMATCH', `FROZEN.json is unreadable: ${e.message}`);
    }
    if (!want || !have.includes(want)) throw new IntegrityError('FROZEN_MISMATCH', `run template ${name} differs from FROZEN.json`);
    return;
  }
  const manifestPath = path.join(templatesDir, 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) throw new IntegrityError('TEMPLATE_MISMATCH', `no FROZEN.json and no templates/MANIFEST.json to verify ${name}`);
  let want;
  try {
    want = readJson(manifestPath)?.files?.[name];
  } catch (e) {
    throw new IntegrityError('TEMPLATE_MISMATCH', `templates/MANIFEST.json is unreadable: ${e.message}`);
  }
  if (!want || !have.includes(want)) throw new IntegrityError('TEMPLATE_MISMATCH', `run template ${name} differs from templates/MANIFEST.json`);
}

/** loadRunTemplate(runDir, name) -> text from <run>/templates/<name>, verified (see verifyRunTemplate). */
export function loadRunTemplate(runDir, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new UsageError(`bad template name: ${name}`);
  const dir = path.join(runDir, 'templates');
  verifyRunTemplate(dir, name);
  return readText(path.join(dir, name));
}

/** Values the prompt lint skips by default: code-generated or frozen-template text, not executor-written. */
export const LINT_SKIP_DEFAULT = Object.freeze(['SEVERITY', 'NONCE', 'JOB_DIR', 'CHECK_COMMAND', 'ANSWER_LANGUAGE', 'PROMPT_PATH']);

/**
 * lintRendered(values, patterns?, { skip? }) -> [{ name, patternId, text }]
 * Prompt lint over the substituted values only. patterns default to catalog/forbidden-prompt-patterns.json.
 * The engine treats any hit as exit 3 (PROMPT_LINT).
 */
export function lintRendered(values, patterns, opts = {}) {
  const pats = patterns ?? loadPatterns('prompt');
  const skip = new Set(opts.skip ?? LINT_SKIP_DEFAULT);
  const subset = {};
  for (const [k, v] of Object.entries(values ?? {})) if (!skip.has(k)) subset[k] = v;
  return lintValues(subset, pats);
}
