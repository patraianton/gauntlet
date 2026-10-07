// Round numbers for the OWNER (bug 14).
//
// Two different numbers exist and must not be mixed up:
//   - the FOLDER number (rounds/NN): taken by every attempt, including a BLOCKED_* attempt that never
//     reached the reviewers. Ledger events, gate files and the audit keep using it;
//   - the REAL round number: 1, 2, 3 ... counting only what counts toward the limits and the plateau
//     (every folder with a gate that is not BLOCKED_*; a folder without a gate yet is the round in
//     progress and counts as the next real round).
// Everything an owner (or the executor) reads says the real number and, where it differs from the
// folder, the folder in brackets: «круг 3 (папка 04)», «round 3 (folder 04)». An attempt that never
// reached the reviewers is an attempt, never a round.
//
// This file is the one place that defines the counting. It is pure: callers pass what they read.

/** Folder name part: 4 -> '04'. */
export function folderPart(n) {
  return String(n).padStart(2, '0');
}

/** True for the gate decisions of an attempt that never reached the reviewers. */
export function isAttemptDecision(decision) {
  return decision === 'BLOCKED_PRECHECK' || decision === 'BLOCKED_TRACE';
}

/**
 * items: [{ n, blocked }] in any order (n = folder number; blocked = the folder holds an attempt that
 * never reached the reviewers). -> Map n -> real round number, or null for an attempt.
 */
export function realRoundNumbers(items) {
  const out = new Map();
  let k = 0;
  for (const it of [...items].sort((a, b) => a.n - b.n)) {
    if (it.blocked) out.set(it.n, null);
    else out.set(it.n, (k += 1));
  }
  return out;
}

/** «3» or «3 (папка 04)» (Russian, for the owner). Unknown folder: the folder number as is. */
export function roundLabelRu(n, map) {
  if (n == null) return '?';
  const real = map ? map.get(n) : undefined;
  if (real === undefined) return String(n);
  if (real === null) return `попытка (папка ${folderPart(n)})`;
  return real === n ? String(n) : `${real} (папка ${folderPart(n)})`;
}

/** «3» or «3 (folder 04)» (English, for CLI lines and the to-do). */
export function roundLabelEn(n, map) {
  if (n == null) return '?';
  const real = map ? map.get(n) : undefined;
  if (real === undefined) return String(n);
  if (real === null) return `attempt (folder ${folderPart(n)})`;
  return real === n ? String(n) : `${real} (folder ${folderPart(n)})`;
}

/** Real number of a folder, or null for an attempt / unknown. */
export function realOf(n, map) {
  const v = map ? map.get(n) : undefined;
  return v === undefined ? null : v;
}
