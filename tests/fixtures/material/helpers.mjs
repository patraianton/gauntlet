// Shared helpers for tests/material/*.test.mjs (P2). Not a test file itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../../../lib/core/hash.mjs';
import { makeRng } from '../../../lib/core/rand.mjs';

export const FIXTURE_DIR = fileURLToPath(new URL('./', import.meta.url));
export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** A fresh temp folder with a neutral name; removed by the returned cleanup. */
export function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-'));
  if (t && typeof t.after === 'function') t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a file (string as UTF-8, or a Buffer) creating parent folders. Returns its absolute path. */
export function put(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
  return abs;
}

export function seededRng(seedHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90') {
  return makeRng({ seedHex });
}

/** A small live material root: content/{plan.json, page.md (BOM+CRLF), page.html, AUTHOR-NOTES.md, img.png}. */
export function makeMaterial(root) {
  const plan = { posts: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Post ${i + 1}`, price_eur: 10 + i })) };
  put(root, 'plan.json', JSON.stringify(plan, null, 2) + '\n');
  put(root, 'page.md', Buffer.concat([BOM, Buffer.from('# Offer\r\nPrice: 49 EUR per month\r\nRules apply to every order.\r\n', 'utf8')]));
  put(root, 'page.html', '<html><body><p>Fast <b>delivery</b> to Springfield</p></body></html>\n');
  put(root, 'AUTHOR-NOTES.md', '# Notes\nThe price was checked against S1.\n');
  put(root, 'img.png', PNG_BYTES);
  return root;
}

export function runFor(root, extra = {}) {
  return {
    schemaVersion: 1,
    runId: '20260115-0930-a1b2c3',
    material: { roots: [{ path: root, as: 'content', include: ['**/*'] }], authorNotes: ['content/AUTHOR-NOTES.md'] },
    allowExecutables: ['node'],
    ...extra,
  };
}

/** A run templates/ folder with the files P2 reads plus a MANIFEST.json of their hashes. */
export function makeRunTemplates(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'agent-call.txt': 'Read the file {{PROMPT_PATH}} and do exactly what it says. Do not read anything else before it. When finished, reply with the single word DONE.',
    'author-notes-banner.md':
      "Author's notes. Claims by the person who made the work. Nobody has checked them. Use them as hints where to look, never as proof.\n" +
      'Заметки автора. Утверждения того, кто делал работу. Никем не проверены. Подсказка, где искать, а не доказательство.\n',
    'check-answer.mjs': "// stub checker for tests\nprocess.exit(0);\n",
    'reviewer.md': 'Duty: {{DUTY}}\n{{#AUTHOR_NOTES}}Notes: {{AUTHOR_NOTES}}\n{{/AUTHOR_NOTES}}Nonce: {{NONCE}}\nDo not give an overall score.\n',
    ...(opts.files ?? {}),
  };
  const manifest = { version: '1', files: {} };
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, 'utf8');
    manifest.files[name] = hashFile(p);
  }
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

/** A schemas/ folder with one small answer schema. */
export function makeSchemas(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const schema = {
    type: 'object',
    required: ['schemaVersion', 'nonce'],
    properties: { schemaVersion: { const: 1 }, nonce: { type: 'string' } },
  };
  fs.writeFileSync(path.join(dir, 'answer-test.schema.json'), JSON.stringify(schema, null, 2) + '\n');
  return dir;
}

export function readExamples() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'pattern-examples.json'), 'utf8'));
}
