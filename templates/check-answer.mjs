// check-answer.mjs — standalone answer checker for gauntlet job folders.
//
// Usage:  node check-answer.mjs <answer.json>
//
// Reads `answer.schema.json` from the folder this script lives in, checks that the answer file is
// valid UTF-8 and valid JSON, validates it against the schema with the JSON Schema subset of
// SPEC 9.0 (the same subset as lib/core/schema.mjs), applies the few cross-field rules of SPEC 9.9
// that the subset cannot express, prints every error with its JSON path, and exits 0 (valid) or
// 1 (invalid or unreadable). On success it prints an "answer code" (the first 16 hex characters of the
// file's sha256); the agent replies "DONE <code>" and the driver passes it to `step --answer-hash`.
//
// This file is copied alone into each job folder, so it has no import statements: Node built-ins
// are taken with process.getBuiltinModule (Node >= 22.3).

const fs = process.getBuiltinModule('node:fs');
const nodePath = process.getBuiltinModule('node:path');
const nodeUrl = process.getBuiltinModule('node:url');
const nodeFs = process.getBuiltinModule('node:fs');

const SCORE_KEYS = new Set(['score', 'rating', 'grade', 'overall']);

/** Length of the answer code printed on success (the first hex characters of the answer's sha256). */
export const ANSWER_CODE_CHARS = 16;

// ---------------------------------------------------------------------------------------------
// JSON Schema subset (SPEC 9.0)
// type (string or array of: object, array, string, integer, number, boolean, null), required,
// properties, additionalProperties (boolean only), enum, const, items (single schema), minItems,
// maxItems, minLength, maxLength, minimum, maximum, pattern (JS regex, unicode flag).
// Unknown keywords are ignored.
// ---------------------------------------------------------------------------------------------

function escapePointer(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'object' | 'string' | 'number' | 'boolean' | ...
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}

function validateNode(schema, value, path, errors) {
  if (schema === null || typeof schema !== 'object') return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `must be of type ${types.join(' or ')} (found ${typeOf(value)})` });
      return; // nothing else is meaningful for a value of the wrong type
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(value, e))) {
    errors.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters long (found ${value.length})` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters long (found ${value.length})` });
    }
    if (typeof schema.pattern === 'string') {
      let re = null;
      try { re = new RegExp(schema.pattern, 'u'); } catch (e) {
        errors.push({ path, message: `schema pattern is not a valid regular expression: ${schema.pattern}` });
      }
      if (re && !re.test(value)) errors.push({ path, message: `must match the pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum} (found ${value})` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum} (found ${value})` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items (found ${value.length})` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items (found ${value.length})` });
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, i) => validateNode(schema.items, item, `${path}/${i}`, errors));
    }
  }

  if (matchesType(value, 'object')) {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({ path: `${path}/${escapePointer(key)}`, message: 'is required but missing' });
        }
      }
    }
    for (const key of Object.keys(value)) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        validateNode(props[key], value[key], childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath, message: 'is not an allowed property' });
      }
    }
  }
}

/** validate(schema, value) -> { ok, errors: [{ path, message }] } — SPEC 9.0 subset. */
export function validate(schema, value) {
  const errors = [];
  validateNode(schema, value, '', errors);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------------------
// Cross-field rules of SPEC 9.9 that the subset cannot express. They are applied by shape, so
// the same script works for every role.
// ---------------------------------------------------------------------------------------------

export function crossFieldRules(answer) {
  const errors = [];
  if (!matchesType(answer, 'object')) return errors;

  if (Array.isArray(answer.findings)) {
    const seen = new Map();
    answer.findings.forEach((f, i) => {
      if (!matchesType(f, 'object')) return;
      const p = `/findings/${i}`;
      if (Number.isInteger(f.n)) {
        if (seen.has(f.n)) errors.push({ path: `${p}/n`, message: `duplicates n=${f.n} of /findings/${seen.get(f.n)}; every finding needs its own number` });
        else seen.set(f.n, i);
      }
      const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
      if (f.kind === 'omission') {
        if (!hasText(f.missingWhat)) errors.push({ path: `${p}/missingWhat`, message: 'is required for kind "omission": say what is required and where it should be' });
      } else if (f.kind === 'visual') {
        if (!hasText(f.seen)) errors.push({ path: `${p}/seen`, message: 'is required for kind "visual": say what is visible' });
      } else if (typeof f.kind === 'string') {
        if (!hasText(f.quote)) errors.push({ path: `${p}/quote`, message: `is required for kind "${f.kind}": copy the exact text from the file` });
      }
    });
  }

  // A source that did not answer is documented, not skipped: outcome "unavailable" needs an excerpt of
  // the error or status in `result` (otherwise the attempt does not count toward a source-check minimum).
  if (Array.isArray(answer.sourceChecks)) {
    answer.sourceChecks.forEach((c, i) => {
      if (!matchesType(c, 'object') || c.outcome !== 'unavailable') return;
      if (typeof c.result !== 'string' || c.result.trim().length < 3) {
        errors.push({ path: `/sourceChecks/${i}/result`, message: 'is required for outcome "unavailable": copy the status or the error the source gave (for example "HTTP 429" or the first line of the error)' });
      }
    });
  }

  if (Array.isArray(answer.items)) {
    answer.items.forEach((it, i) => {
      if (!matchesType(it, 'object')) return;
      if (it.verdict === 'confirmed' && (it.severity === null || it.severity === undefined)) {
        errors.push({ path: `/items/${i}/severity`, message: 'is required (blocker, major or cosmetic) when the verdict is "confirmed"' });
      }
      if (it.outcome === 'reclassified' && (it.severity === null || it.severity === undefined)) {
        errors.push({ path: `/items/${i}/severity`, message: 'is required (blocker, major or cosmetic) when the outcome is "reclassified"' });
      }
    });
  }

  return errors;
}

function findScoreKeys(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findScoreKeys(v, `${path}/${i}`, out));
  } else if (matchesType(value, 'object')) {
    for (const key of Object.keys(value)) {
      const p = `${path}/${escapePointer(key)}`;
      if (SCORE_KEYS.has(key.toLowerCase())) out.push(p);
      findScoreKeys(value[key], p, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// File checks and command line
// ---------------------------------------------------------------------------------------------

/**
 * checkAnswerText(bytes, schema) -> { ok, errors, warnings }
 * bytes: Buffer/Uint8Array of the answer file.
 */
export function checkAnswerBytes(bytes, schema) {
  const errors = [];
  const warnings = [];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    errors.push({ path: '', message: 'the file is not valid UTF-8; save it as UTF-8' });
    return { ok: false, errors, warnings };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') {
    errors.push({ path: '', message: 'the file is empty' });
    return { ok: false, errors, warnings };
  }
  let answer;
  try {
    answer = JSON.parse(text);
  } catch (e) {
    errors.push({ path: '', message: `not valid JSON: ${e.message}` });
    return { ok: false, errors, warnings };
  }
  const res = validate(schema, answer);
  errors.push(...res.errors);
  errors.push(...crossFieldRules(answer));
  for (const p of findScoreKeys(answer, '', [])) {
    warnings.push({ path: p, message: 'keys named score, rating, grade or overall are ignored' });
  }
  return { ok: errors.length === 0, errors, warnings };
}

function show(path) {
  return path === '' ? '/' : path;
}

function main(argv) {
  if (argv.length !== 1) {
    process.stdout.write('usage: node check-answer.mjs <answer.json>\n');
    return 1;
  }
  const answerPath = nodePath.resolve(argv[0]);
  const schemaPath = nodeUrl.fileURLToPath(new URL('./answer.schema.json', import.meta.url));

  let schema;
  try {
    let schemaText = fs.readFileSync(schemaPath, 'utf8');
    if (schemaText.charCodeAt(0) === 0xfeff) schemaText = schemaText.slice(1);
    schema = JSON.parse(schemaText);
  } catch (e) {
    process.stdout.write(`ERROR: cannot read answer.schema.json next to this script (${schemaPath}): ${e.message}\n`);
    return 1;
  }

  let bytes;
  try {
    bytes = fs.readFileSync(answerPath);
  } catch (e) {
    process.stdout.write(`ERROR: cannot read the answer file ${answerPath}: ${e.code || e.message}\n`);
    return 1;
  }

  const res = checkAnswerBytes(bytes, schema);
  for (const w of res.warnings) process.stdout.write(`WARNING ${show(w.path)}: ${w.message}\n`);
  if (res.ok) {
    // The answer code binds what the agent wrote to what gauntlet ingests: the driver passes it to
    // `step --answer-hash`, and an answer file changed after this check no longer matches it.
    const crypto = process.getBuiltinModule('node:crypto');
    const code = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, ANSWER_CODE_CHARS);
    process.stdout.write(`OK: the answer matches the required shape. Answer code: ${code}\n`);
    return 0;
  }
  for (const e of res.errors) process.stdout.write(`ERROR ${show(e.path)}: ${e.message}\n`);
  process.stdout.write(`INVALID: ${res.errors.length} error(s). Fix them in ${answerPath} and run this check again.\n`);
  return 1;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    // Real paths, case-folded on Windows: a call through a junction must still run the check.
    const norm = (p) => {
      const r = nodeFs.realpathSync(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(nodePath.resolve(process.argv[1])) === norm(nodeUrl.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
