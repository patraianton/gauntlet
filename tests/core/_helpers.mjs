// Shared helpers for the P1 core tests. Temporary folders live under the OS temp
// folder and are removed by the test that made them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'core');

export function tempDir(label = 'core') {
  const d = path.join(os.tmpdir(), `pl-test-${label}-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function rmTemp(d) {
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

export function fixtureJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}
