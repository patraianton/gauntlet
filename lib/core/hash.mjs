// Hashing helpers (SPEC 9, 9.3, 23.1).
// Text, json and html files are hashed after stripping a UTF-8 BOM and turning CRLF
// into LF, so an editor that adds a BOM or Windows line endings does not change a
// version hash. Every other kind is hashed raw.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonical } from './canon.mjs';

// Text by extension. Code and config files are text too: the review-trace scan, strip rules and quote
// grounding read only text kinds, so a missing extension here silently hides a file from them (r2-f22).
const TEXT_EXT = new Set([
  'md', 'mdx', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'rst', 'adoc', 'org', 'tex',
  'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro',
  'py', 'rb', 'php', 'pl', 'lua', 'r', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'scala', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'svg',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'dockerignore', 'lock',
  // r3-f15: line-oriented data, notebooks, subtitles and editor/backup leftovers are text too
  'jsonl', 'ndjson', 'ipynb', 'srt', 'vtt', 'ass', 'po', 'bak', 'orig', 'rej', 'old', 'tmp', 'swp', 'patch', 'diff',
]);
// Well-known text files without an extension.
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'licence', 'changelog', 'procfile', 'gemfile', 'rakefile', 'notice', 'authors', 'codeowners', 'vagrantfile', 'jenkinsfile']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm']);

export const NORMALIZED_KINDS = Object.freeze(['text', 'json', 'html']);

export function sha256Hex(bufferOrString) {
  const h = createHash('sha256');
  if (typeof bufferOrString === 'string') h.update(bufferOrString, 'utf8');
  else h.update(bufferOrString);
  return h.digest('hex');
}

export function hashJson(value) {
  return sha256Hex(canonical(value));
}

/** Kind of a file by its extension (SPEC 9.3). Case-insensitive. */
export function fileKind(rel) {
  const name = String(rel).replace(/\\/g, '/').split('/').pop();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return TEXT_NAMES.has(name.toLowerCase()) ? 'text' : 'binary';
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'binary';
}

/** Strip a leading UTF-8 BOM and turn every CRLF into LF, at byte level. */
export function normalizeTextBuffer(buf) {
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  let crlf = false;
  for (let i = start; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      crlf = true;
      break;
    }
  }
  if (!crlf) return start ? buf.subarray(start) : buf;
  const out = Buffer.allocUnsafe(buf.length - start);
  let o = 0;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) continue;
    out[o++] = buf[i];
  }
  return out.subarray(0, o);
}

/** Hash bytes the way hashFile does for `kind`. */
export function hashBuffer(buf, kind) {
  return sha256Hex(NORMALIZED_KINDS.includes(kind) ? normalizeTextBuffer(buf) : buf);
}

/** Hash a file. `kind` defaults to fileKind(absPath). */
export function hashFile(absPath, kind) {
  const k = kind ?? fileKind(absPath);
  return hashBuffer(readFileSync(absPath), k);
}

/** versionHash = sha256(canonical([[rel, sha256], ...] sorted by rel)). Does not mutate the input. */
export function treeHash(entries) {
  const sorted = entries.map((e) => [String(e[0]), String(e[1])]);
  sorted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] === sorted[i - 1][0]) throw new Error(`treeHash: duplicate path ${sorted[i][0]}`);
  }
  return hashJson(sorted);
}
