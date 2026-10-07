// update-manifest.mjs — regenerates templates/MANIFEST.json (SPEC 15.1).
//
// Usage:
//   node templates/update-manifest.mjs           rewrite MANIFEST.json; bumps "version" when any hash changed
//   node templates/update-manifest.mjs --check   change nothing; exit 0 if MANIFEST.json matches the files, 1 if not
//
// MANIFEST.json = { schemaVersion: 1, version: "<n>", files: { "<name>": sha256 } } over every file in
// templates/ except MANIFEST.json itself and this script. Text files are hashed after a BOM strip and
// CRLF -> LF, the same rule as lib/core/hash.mjs hashFile for text/json/html, so a Windows checkout with
// CRLF line endings gives the same hashes. Changing a template is a deliberate act: the version bump
// is printed and becomes part of every later run's FROZEN.json.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEMPLATES_DIR = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_NAME = 'MANIFEST.json';
const SELF_NAME = 'update-manifest.mjs';

export function normalizedHash(buf) {
  let b = Buffer.from(buf);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  const text = b.toString('utf8');
  // Only normalise when the bytes are valid UTF-8 text; otherwise hash raw.
  if (Buffer.from(text, 'utf8').equals(b)) {
    return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  }
  return createHash('sha256').update(b).digest('hex');
}

export function listTemplateFiles(dir = TEMPLATES_DIR) {
  return readdirSync(dir)
    .filter((name) => name !== MANIFEST_NAME && name !== SELF_NAME && !name.endsWith('.tmp'))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

export function computeFiles(dir = TEMPLATES_DIR) {
  const files = {};
  for (const name of listTemplateFiles(dir)) files[name] = normalizedHash(readFileSync(join(dir, name)));
  return files;
}

export function readManifest(dir = TEMPLATES_DIR) {
  const p = join(dir, MANIFEST_NAME);
  if (!existsSync(p)) return null;
  let text = readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

/** diffFiles(oldFiles, newFiles) -> { added: [], removed: [], changed: [] } */
export function diffFiles(oldFiles = {}, newFiles = {}) {
  const added = Object.keys(newFiles).filter((k) => !(k in oldFiles)).sort();
  const removed = Object.keys(oldFiles).filter((k) => !(k in newFiles)).sort();
  const changed = Object.keys(newFiles).filter((k) => k in oldFiles && oldFiles[k] !== newFiles[k]).sort();
  return { added, removed, changed };
}

export function checkManifest(dir = TEMPLATES_DIR) {
  const manifest = readManifest(dir);
  const files = computeFiles(dir);
  if (!manifest || typeof manifest.files !== 'object' || manifest.files === null) {
    return { ok: false, manifest, files, diff: diffFiles({}, files), reason: 'MANIFEST.json is missing or has no files map' };
  }
  const diff = diffFiles(manifest.files, files);
  const ok = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  return { ok, manifest, files, diff, reason: ok ? null : 'template files differ from MANIFEST.json' };
}

export function updateManifest(dir = TEMPLATES_DIR) {
  const res = checkManifest(dir);
  if (res.ok) return { written: false, version: res.manifest.version, diff: res.diff };
  const oldVersion = res.manifest && /^[0-9]+$/.test(String(res.manifest.version)) ? Number(res.manifest.version) : 0;
  const version = String(oldVersion + 1);
  const out = { schemaVersion: 1, version, files: res.files };
  const p = join(dir, MANIFEST_NAME);
  writeFileSync(p + '.tmp', JSON.stringify(out, null, 2) + '\n', 'utf8');
  renameSync(p + '.tmp', p);
  return { written: true, version, diff: res.diff };
}

function main(argv) {
  if (argv.includes('--check')) {
    const res = checkManifest();
    if (res.ok) {
      process.stdout.write(`OK: MANIFEST.json version ${res.manifest.version} matches ${Object.keys(res.files).length} template files.\n`);
      return 0;
    }
    process.stdout.write(`MISMATCH: ${res.reason}\n`);
    for (const k of ['added', 'removed', 'changed']) for (const f of res.diff[k]) process.stdout.write(`  ${k}: ${f}\n`);
    return 1;
  }
  const res = updateManifest();
  if (!res.written) {
    process.stdout.write(`MANIFEST.json is up to date (version ${res.version}).\n`);
    return 0;
  }
  process.stdout.write(`MANIFEST.json written, version ${res.version}.\n`);
  for (const k of ['added', 'removed', 'changed']) for (const f of res.diff[k]) process.stdout.write(`  ${k}: ${f}\n`);
  return 0;
}

const realNorm = (p) => {
  const r = realpathSync(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
let invoked = false;
try {
  invoked = Boolean(process.argv[1]) && realNorm(process.argv[1]) === realNorm(fileURLToPath(import.meta.url));
} catch {
  invoked = false;
}
if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
