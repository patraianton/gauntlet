// Randomness for gauntlet (SPEC 11, 23.1).
//
// Every generator is a SHA-256 counter stream keyed by a 32-byte seed. In normal use
// the seed comes from node:crypto (a fresh one per makeRng() call), so the stream is
// cryptographically unpredictable, yet `seedHex` can be revealed later (canary key)
// and the choices replayed for audit.
//
// Seeded mode from the environment exists ONLY when both GAUNTLET_TEST=1 and
// GAUNTLET_SEED are set (tests and selftest). Then each makeRng() call in the
// process gets seed_i = sha256("gauntlet-env-seed\0" + GAUNTLET_SEED + "\0" + i),
// i = 0, 1, 2 ... so two generators in one process never repeat each other.
// GAUNTLET_SEED alone (without GAUNTLET_TEST=1) is ignored.
//
// An explicit `seedHex` argument replays a generator from a revealed seed (audit,
// tests). It is a code-level API; no CLI flag passes a seed. Such generators report
// `seeded: true`.

import { randomBytes, createHash } from 'node:crypto';
import { UsageError } from './errors.mjs';

export const NEUTRAL_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

let envCounter = 0;

/** True when the environment asks for the seeded test generator. */
export function seededFromEnv(env = process.env) {
  return env.GAUNTLET_TEST === '1' && typeof env.GAUNTLET_SEED === 'string' && env.GAUNTLET_SEED.length > 0;
}

/** Derive a child seed (hex) from a seed and a label, e.g. per round or per job. */
export function deriveSeed(seedHex, label) {
  return createHash('sha256').update(`gauntlet-derive\0${seedHex}\0${label}`, 'utf8').digest('hex');
}

/**
 * makeRng({ seedHex?, env? }) -> { bytes(n), int(lo, hi), pick(arr), shuffle(arr), id(len, alphabet), seedHex, seeded }
 *   int(lo, hi): integer in [lo, hi) (hi exclusive, like crypto.randomInt).
 *   shuffle(arr): returns a new shuffled array; the input is not changed.
 */
export function makeRng(opts = {}) {
  const env = opts.env ?? process.env;
  let seedHex;
  let seeded;
  if (opts.seedHex !== undefined && opts.seedHex !== null) {
    seedHex = normaliseSeed(opts.seedHex);
    seeded = true;
  } else if (seededFromEnv(env)) {
    seedHex = createHash('sha256')
      .update(`gauntlet-env-seed\0${env.GAUNTLET_SEED}\0${envCounter++}`, 'utf8')
      .digest('hex');
    seeded = true;
  } else {
    seedHex = randomBytes(32).toString('hex');
    seeded = false;
  }
  return streamRng(seedHex, seeded);
}

function normaliseSeed(s) {
  const t = String(s).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(t) || t.length % 2 !== 0 || t.length < 16) {
    throw new UsageError(`seedHex must be an even-length hex string of at least 16 characters`);
  }
  return t;
}

function streamRng(seedHex, seeded) {
  const key = Buffer.from(seedHex, 'hex');
  let counter = 0n;
  let pool = Buffer.alloc(0);

  function bytes(n) {
    if (!Number.isInteger(n) || n < 0) throw new UsageError('bytes(n) needs a non-negative integer');
    const chunks = [pool];
    let have = pool.length;
    while (have < n) {
      const ctr = Buffer.alloc(8);
      ctr.writeBigUInt64BE(counter++);
      const block = createHash('sha256').update(key).update(ctr).digest();
      chunks.push(block);
      have += block.length;
    }
    const all = Buffer.concat(chunks);
    pool = all.subarray(n);
    return Buffer.from(all.subarray(0, n));
  }

  function int(lo, hi) {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi <= lo) {
      throw new UsageError(`int(lo, hi) needs safe integers with lo < hi (got ${lo}, ${hi})`);
    }
    const range = hi - lo;
    if (range > 2 ** 48) throw new UsageError('int range too large');
    if (range === 1) return lo;
    const max = 2 ** 48;
    const limit = max - (max % range);
    for (;;) {
      const v = bytes(6).readUIntBE(0, 6);
      if (v < limit) return lo + (v % range);
    }
  }

  function pick(arr) {
    if (!Array.isArray(arr) || arr.length === 0) throw new UsageError('pick() needs a non-empty array');
    return arr[int(0, arr.length)];
  }

  function shuffle(arr) {
    const a = Array.from(arr);
    for (let i = a.length - 1; i > 0; i--) {
      const j = int(0, i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function id(len = 8, alphabet = NEUTRAL_ALPHABET) {
    if (!Number.isInteger(len) || len < 1) throw new UsageError('id(len) needs a positive integer');
    if (typeof alphabet !== 'string' || alphabet.length < 2) throw new UsageError('id() needs an alphabet of 2+ characters');
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[int(0, alphabet.length)];
    return s;
  }

  return { bytes, int, pick, shuffle, id, seedHex, seeded };
}
