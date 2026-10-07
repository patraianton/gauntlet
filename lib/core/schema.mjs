// JSON Schema validator for the subset of SPEC 9.0:
//   type (string or array of object|array|string|integer|number|boolean|null), required,
//   properties, additionalProperties (boolean only), enum, const, items (single schema),
//   minItems, maxItems, minLength, maxLength (in code points), minimum, maximum,
//   pattern (JS regex, unicode flag).
// $id, description, default and any other keyword are ignored.
// Errors: [{ path: "/findings/3/severity", message }] ; the root path is "".
// templates/check-answer.mjs embeds an identical validator (it cannot import).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './canon.mjs';
import { UsageError } from './errors.mjs';

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));

export function schemaDir() {
  return SCHEMA_DIR;
}

const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object, undefined, ...
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return (actual === 'number' || actual === 'integer') && Number.isFinite(v);
  if (t === 'integer') return actual === 'integer';
  if (t === 'object') return actual === 'object';
  return actual === t;
}

function ptr(base, key) {
  return `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

const reCache = new Map();
function regex(pattern) {
  let re = reCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, 'u');
    reCache.set(pattern, re);
  }
  return re;
}

function same(a, b) {
  return canonical(a) === canonical(b);
}

function check(schema, value, at, errors) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    errors.push({ path: at, message: 'no value is allowed here' });
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) if (!TYPES.includes(t)) throw new UsageError(`schema: unknown type "${t}" at ${at || '/'}`);
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push({ path: at, message: `must be ${types.join(' or ')} (got ${value === undefined ? 'nothing' : typeOf(value)})` });
      return;
    }
  }
  if (schema.const !== undefined && !same(schema.const, value)) {
    errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) {
    errors.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  const t = typeOf(value);
  if (t === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push({ path: at, message: `must have at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push({ path: at, message: `must have at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) errors.push({ path: at, message: `must match ${schema.pattern}` });
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `must be <= ${schema.maximum}` });
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path: at, message: `must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path: at, message: `must have at most ${schema.maxItems} items` });
    if (schema.items !== undefined) value.forEach((item, i) => check(schema.items, item, ptr(at, i), errors));
  }
  if (t === 'object') {
    const props = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, k) || value[k] === undefined) {
          errors.push({ path: ptr(at, k), message: 'is required' });
        }
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, k) && value[k] !== undefined) check(sub, value[k], ptr(at, k), errors);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) errors.push({ path: ptr(at, k), message: 'is not allowed' });
      }
    }
  }
}

/** validate(schema, value) -> { ok, errors: [{ path, message }] } */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', errors);
  return { ok: errors.length === 0, errors };
}

const loaded = new Map();

/** Load schemas/<name>.schema.json from the repository ("answer-reviewer" or "answer-reviewer.schema.json"). */
export function loadSchema(name) {
  const base = String(name).replace(/\.schema\.json$/, '').replace(/\.json$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(base)) throw new UsageError(`bad schema name: ${name}`);
  const hit = loaded.get(base);
  if (hit) return hit;
  const file = path.join(SCHEMA_DIR, `${base}.schema.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`unknown schema: ${name}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const schema = JSON.parse(text);
  loaded.set(base, schema);
  return schema;
}

/** Path of the schema file (for copying into job folders). */
export function schemaPath(name) {
  const base = String(name).replace(/\.schema\.json$/, '').replace(/\.json$/, '');
  return path.join(SCHEMA_DIR, `${base}.schema.json`);
}

/** Names of every schema file in schemas/ (without ".schema.json"). */
export function listSchemas() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => f.slice(0, -'.schema.json'.length))
    .sort();
}

/** Throw UsageError listing the errors when value does not validate. */
export function assertValid(name, value, what = name) {
  const r = validate(loadSchema(name), value);
  if (!r.ok) {
    const lines = r.errors.map((e) => `${e.path || '/'}: ${e.message}`);
    throw new UsageError(`${what} is invalid:\n  ${lines.join('\n  ')}`, { errors: r.errors });
  }
}
