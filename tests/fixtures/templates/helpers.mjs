// Shared helpers for tests/templates/*.test.mjs (P5). Local test doubles for modules that other
// packages own (render, glob, prompt lint); each test also uses the real module when it exists.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURES = dirname(fileURLToPath(import.meta.url));
export const REPO = join(FIXTURES, '..', '..', '..');
export const TEMPLATES = join(REPO, 'templates');
export const LENS_EXAMPLES = join(REPO, 'lenses', 'examples');

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function readText(p) {
  let t = readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n');
}
export const readJson = (p) => JSON.parse(readText(p));

/** Placeholders of every template, exactly as listed in SPEC 15.3 (and 15.1 for agent-call.txt). */
export const PLACEHOLDERS = {
  'reviewer.md': ['DUTY', 'LENS_TITLE', 'PROCEDURE', 'CHECKLIST', 'TASK', 'REQUIREMENTS', 'MATERIAL_LIST', 'AUTHOR_NOTES',
    'SOURCES', 'MINIMUM', 'SEVERITY', 'CHALLENGES', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'ANSWER_LANGUAGE', 'CHECK_COMMAND'],
  'verifier.md': ['TASK', 'MATERIAL_LIST', 'SOURCES', 'SEVERITY', 'ITEMS', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'ANSWER_LANGUAGE', 'CHECK_COMMAND'],
  'dispute-verifier.md': ['TASK', 'MATERIAL_LIST', 'SOURCES', 'SEVERITY', 'DISPUTES', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'ANSWER_LANGUAGE', 'CHECK_COMMAND'],
  'planter.md': ['TASK', 'COPY_DIR', 'MATERIAL_LIST', 'SOURCES', 'SLOTS', 'TYPE_DEFINITIONS', 'USED', 'MAX_EDIT',
    'CANDIDATES_PER_SLOT', 'REPORT_LANGUAGE', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'CHECK_COMMAND'],
  'canary-validator.md': ['TASK', 'COPY_DIR', 'SOURCES', 'SEVERITY', 'TYPE_DEFINITIONS', 'CANDIDATES', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'CHECK_COMMAND'],
  'decoy-writer.md': ['TASK', 'COPY_DIR', 'MATERIAL_LIST', 'SOURCES', 'DECOY_COUNT', 'ANSWER_LANGUAGE', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'CHECK_COMMAND'],
  'matcher.md': ['PAIRS', 'NONCE', 'JOB_DIR', 'CHECK_COMMAND'],
  'lens-writer.md': ['TASK', 'ARTIFACT_TYPE', 'MANIFEST_SUMMARY', 'SOURCES', 'EXAMPLE', 'CANARY_TYPES', 'GENERALIST',
    'PREVIOUS_ERRORS', 'NONCE', 'JOB_DIR', 'CHECK_COMMAND'],
  'agent-call.txt': ['PROMPT_PATH'],
  'severity.md': [],
  'author-notes-banner.md': [],
};
/** Optional sections ({{#X}}...{{/X}}) per template. */
export const SECTIONS = { 'reviewer.md': ['AUTHOR_NOTES'], 'lens-writer.md': ['PREVIOUS_ERRORS'] };
/** Templates whose answers are checked, and the schema each one uses. */
export const ROLE_SCHEMA = {
  'reviewer.md': 'answer-reviewer', 'verifier.md': 'answer-verifier', 'dispute-verifier.md': 'answer-dispute',
  'planter.md': 'answer-planter', 'canary-validator.md': 'answer-validator', 'matcher.md': 'answer-matcher', 'decoy-writer.md': 'answer-decoy',
  'lens-writer.md': 'answer-lens-writer',
};

const TOKEN = /\{\{([#/]?)([A-Za-z0-9_]+)\}\}/g;

/** All {{...}} tokens of a template: [{ kind: ''|'#'|'/', name }]. */
export function tokens(text) {
  return [...text.matchAll(TOKEN)].map((m) => ({ kind: m[1], name: m[2] }));
}
export function placeholderNames(text) {
  return [...new Set(tokens(text).map((t) => t.name))].sort();
}

/**
 * Local renderer with the semantics of SPEC 15.1: {{X}} substitution; {{#X}}...{{/X}} kept only when
 * X is non-empty; throws on a placeholder without a value (missing) or a value without a placeholder
 * (unknown). Values are substituted in one pass, so a value containing "{{" is never re-expanded.
 */
export function renderLocal(text, values) {
  const names = placeholderNames(text);
  for (const n of names) if (!(n in values)) throw new Error(`missing placeholder value: ${n}`);
  for (const k of Object.keys(values)) if (!names.includes(k)) throw new Error(`unknown placeholder: ${k}`);
  let out = text.replace(/\{\{#([A-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, name, inner) => (String(values[name] ?? '') === '' ? '' : inner));
  out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => String(values[name]));
  return out;
}

/** A full, realistic value set for a template (every placeholder non-empty). */
export function fullValues(name) {
  const jobDir = 'C:\\Users\\x\\work-copies\\demo\\wc\\k3mzq8wd';
  const all = {
    DUTY: 'Find every wrong number or fact.',
    LENS_TITLE: 'Facts and numbers',
    PROCEDURE: '1. List every number.\n2. Check each against the sources.\n3. Recompute every sum.',
    CHECKLIST: '- Does every price match the source?\n- Are sums correct?',
    TASK: 'Make a leaflet for the bakery with all prices.\nSource: owner, 2026-10-06, chat',
    REQUIREMENTS: '- R01: All prices are listed. Quote: "with all prices"',
    MATERIAL_LIST: '- C:\\x\\wc\\k3mzq8wd\\content\\leaflet.md (text)',
    AUTHOR_NOTES: '- C:\\x\\wc\\k3mzq8wd\\content\\AUTHOR-NOTES.md',
    SOURCES: '- S1: shop prices: `curl -s https://bakery.example/api/prices`',
    MINIMUM: '- M1: every line of content/leaflet.md (1 file)',
    SEVERITY: readText(join(TEMPLATES, 'severity.md')),
    CHALLENGES: 'Q1. Copy line 3 of content/leaflet.md exactly.\nQ2. How many files match content/*.md?\nQ3. How many files match **/*.png?',
    NONCE: 'PL-ABCD-EF23',
    JOB_DIR: jobDir,
    WORK_DIR: `${jobDir}\\work`,
    ANSWER_LANGUAGE: 'ru',
    CHECK_COMMAND: `node "${jobDir}\\check-answer.mjs" "${jobDir}\\answer.json"`,
    ITEMS: 'V1. content/leaflet.md, line 14. Quote: "Rye bread — 2.90 EUR". Claim: the price differs from the shop.',
    DISPUTES: 'D1. Problem: ... Argument: ... Evidence: ...',
    COPY_DIR: 'C:\\x\\wc\\k3mzq8wd',
    SLOTS: '- S1: kind FACT-NUM, part: start (0.00-0.33), minimum class major',
    TYPE_DEFINITIONS: '- FACT-NUM: wrong number or arithmetic, provable from the material or a source.',
    USED: 'none yet',
    MAX_EDIT: '240',
    CANDIDATES_PER_SLOT: '2',
    DECOY_COUNT: '10',
    REPORT_LANGUAGE: 'ru',
    CANDIDATES: '- S1 alt 1: content/leaflet.md line 14; before "3.20"; after "2.90".',
    PAIRS: '- C1: content/leaflet.md line 14, before "3.20", after "2.90".\n  - k3mzq8wd#2: quote "2.90 EUR", problem "wrong price"',
    ARTIFACT_TYPE: 'marketing-plan',
    MANIFEST_SUMMARY: '- content/leaflet.md (text)\n- content/menu.json (json, /items: 12)',
    EXAMPLE: readText(join(LENS_EXAMPLES, 'marketing-plan.json')).trim(),
    CANARY_TYPES: '- FACT-NUM: wrong number (usable to check attention)',
    GENERALIST: 'on',
    PREVIOUS_ERRORS: '- lenses/0/checklist: needs at least 5 items',
    PROMPT_PATH: `${jobDir}\\PROMPT.md`,
  };
  const out = {};
  for (const p of PLACEHOLDERS[name]) out[p] = all[p];
  return out;
}

/** The answer example of a template: the first ```json block after "### Answer example". */
export function answerExample(text) {
  const at = text.indexOf('### Answer example');
  if (at < 0) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(text.slice(at));
  return m ? m[1] : null;
}

/** Minimal glob matcher (SPEC: `**`, `*`, `?`), copy-relative POSIX paths. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
export const matchGlob = (rel, glob) => globToRegExp(glob).test(rel);

/** The minimum prompt-lint list of SPEC 15.5 (forbidden in every substituted value). */
export const PROMPT_LINT_MIN = [
  /≥\s*\d/u, />=\s*\d/u, /\b9[.,]5\b/u, /at least \d+(\.\d)? (points|score)/iu, /score/iu, /оценк[уа]/iu, /rating/iu,
  /average/iu, /средн/iu, /do not flag/iu, /не отмечай/iu, /не указывай/iu, /deliberate/iu, /намеренн/iu,
  /out of scope/iu, /вне рамок/iu, /already fixed/iu, /исправлено/iu, /do not invent/iu, /не придумывай/iu,
  /not substantive/iu, /несущественн/iu, /previous (round|score|review)/iu, /предыдущ(ий|его) круг/iu,
];

/** Real prompt-lint patterns from catalog/forbidden-prompt-patterns.json (P2), or null if absent. */
export function realPromptPatterns() {
  const p = join(REPO, 'catalog', 'forbidden-prompt-patterns.json');
  if (!existsSync(p)) return null;
  const cat = readJson(p);
  return (cat.patterns || []).map((x) => ({ id: x.id, re: new RegExp(x.regex, (x.flags || '').replace(/g/g, '') + (/(u|v)/.test(x.flags || '') ? '' : 'u')) }));
}

/** All string values of a JSON value with their pointers. */
export function stringsOf(value, path = '', out = []) {
  if (typeof value === 'string') out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => stringsOf(v, `${path}/${i}`, out));
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) stringsOf(value[k], `${path}/${k}`, out);
  return out;
}

export const V1_CANARY_TYPES = ['FACT-NUM', 'FACT-CLAIM', 'CONTRA', 'LANG', 'PATH', 'BRIEF', 'POLICY', 'OMIT-REQ', 'OMIT-CAVEAT', 'VISUAL'];

/** Real module of another package, or null when it does not exist yet. */
export async function tryImport(rel) {
  const p = join(REPO, rel);
  if (!existsSync(p)) return null;
  try { return await import(pathToFileURL(p).href); } catch { return null; }
}

/** Schema: the real one from schemas/ when it exists, plus our SPEC-derived double. */
export function schemas(name) {
  const out = [];
  if (existsSync(join(FIXTURES, 'schemas', `${name}.schema.json`))) out.push({ source: 'fixture', schema: readJson(join(FIXTURES, 'schemas', `${name}.schema.json`)) });
  const real = join(REPO, 'schemas', `${name}.schema.json`);
  if (existsSync(real)) out.push({ source: 'schemas/', schema: readJson(real) });
  return out;
}
