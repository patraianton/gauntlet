// `done <run>` (SPEC 11.8).
import { UsageError } from '../core/errors.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { parseArgv } from './state.mjs';
import { done } from './done.mjs';

export async function run(argv, ctx) {
  const { positional } = parseArgv(argv, {});
  if (!positional[0]) throw new UsageError('usage: done <run>');
  return withLock(normalizeInput(positional[0]), () => done(positional[0], ctx));
}
