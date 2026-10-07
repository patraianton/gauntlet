// Canary type catalog (SPEC 14.1).
//
// taxonomy/canary-types.json lists the v1 types. Code decides which types may be used
// for an attention canary (one per lens, gates that lens) and which only for
// measurement canaries (never gate).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../core/fsx.mjs';
import { UsageError } from '../core/errors.mjs';

export const TAXONOMY_PATH = fileURLToPath(new URL('../../taxonomy/canary-types.json', import.meta.url));

export const V1_TYPE_IDS = Object.freeze([
  'FACT-NUM',
  'FACT-CLAIM',
  'CONTRA',
  'LANG',
  'PATH',
  'BRIEF',
  'POLICY',
  'OMIT-REQ',
  'OMIT-CAVEAT',
  'VISUAL',
]);

const FLOORS = new Set(['major', 'blocker']);

/** Structural check of a taxonomy object; returns a list of error strings. */
export function checkTaxonomy(tax) {
  const errors = [];
  if (!tax || typeof tax !== 'object') return ['taxonomy is not an object'];
  if (tax.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(tax.types) || tax.types.length === 0) return [...errors, 'types must be a non-empty array'];
  const seen = new Set();
  for (const [i, t] of tax.types.entries()) {
    const at = `types[${i}]`;
    if (!t || typeof t.id !== 'string' || !/^[A-Z][A-Z-]{1,23}$/.test(t.id)) errors.push(`${at}.id invalid`);
    else if (seen.has(t.id)) errors.push(`${at}.id duplicate ${t.id}`);
    else seen.add(t.id);
    for (const k of ['title', 'definition', 'example']) {
      if (typeof t?.[k] !== 'string' || t[k].trim().length < 3) errors.push(`${at}.${k} missing`);
    }
    for (const k of ['attentionEligible', 'omission', 'needsRebuild']) {
      if (typeof t?.[k] !== 'boolean') errors.push(`${at}.${k} must be boolean`);
    }
    if (!FLOORS.has(t?.defaultFloor)) errors.push(`${at}.defaultFloor must be major or blocker`);
  }
  return errors;
}

function wrap(tax) {
  const map = new Map(tax.types.map((t) => [t.id, t]));
  return {
    schemaVersion: tax.schemaVersion,
    types: tax.types,
    byId(id) {
      return map.get(id) ?? null;
    },
  };
}

/**
 * loadTaxonomy(file?) -> { types, byId(id) }
 * `file` defaults to the repository's taxonomy/canary-types.json. A plain object
 * ({ schemaVersion, types }) is accepted too (tests, frozen copies).
 */
export function loadTaxonomy(file = TAXONOMY_PATH) {
  const tax = typeof file === 'object' && file !== null ? file : readJson(path.resolve(file));
  if (typeof tax.byId === 'function') return tax;
  const errors = checkTaxonomy(tax);
  if (errors.length) throw new UsageError(`invalid canary taxonomy: ${errors.join('; ')}`, { errors });
  return wrap(tax);
}

/** A type usable for a canary at all in this run (VISUAL needs visualAllowed + a rebuild). */
export function typeUsable(type, opts = {}) {
  if (!type) return false;
  if (type.needsRebuild) return Boolean(opts.visualAllowed) && opts.hasRebuild !== false;
  return true;
}

/**
 * attentionEligible(type, lens, opts?) -> bool
 *   - the type is attention-eligible in the catalog;
 *   - the lens lists the type in its canaryTypes (this is what makes OMIT-REQ eligible
 *     "only for a lens that lists it", and it holds for every type);
 *   - a type that needs a rebuild (VISUAL) only when opts.visualAllowed is true and the
 *     run has a rebuild (opts.hasRebuild, default true).
 */
export function attentionEligible(type, lens, opts = {}) {
  if (!type || !type.attentionEligible) return false;
  if (lens && Array.isArray(lens.canaryTypes) && !lens.canaryTypes.includes(type.id)) return false;
  return typeUsable(type, opts);
}

/** True when the type id names an omission type. */
export function isOmissionType(taxonomy, typeId) {
  return Boolean(taxonomy.byId(typeId)?.omission);
}
