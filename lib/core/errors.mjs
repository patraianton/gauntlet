// Error classes shared by every gauntlet module (SPEC section 23.1).
//
// Exit-code mapping (SPEC 10.1):
//   UsageError     -> 4  (bad arguments, wrong state, refused input)
//   StateError     -> 4  (illegal state transition)
//   IntegrityError -> 3  (TAMPER, FROZEN_MISMATCH, TEMPLATE_MISMATCH, PROMPT_LINT, COMMITMENT_MISMATCH, AUDIT_FAILED)
//   anything else  -> 1  (a bug)

export const INTEGRITY_CODES = Object.freeze([
  'TAMPER',
  'FROZEN_MISMATCH',
  'TEMPLATE_MISMATCH',
  'PROMPT_LINT',
  'COMMITMENT_MISMATCH',
  'AUDIT_FAILED',
]);

export class UsageError extends Error {
  constructor(msg, details) {
    super(msg);
    this.name = 'UsageError';
    this.exitCode = 4;
    if (details !== undefined) this.details = details;
  }
}

export class IntegrityError extends Error {
  constructor(code, msg, details) {
    if (!INTEGRITY_CODES.includes(code)) {
      // An unknown code is still an integrity failure (fail closed), but keep the
      // original code visible so the bug in the caller is easy to find.
      msg = `${msg ?? ''} [unknown integrity code: ${code}]`.trim();
    }
    super(msg ?? code);
    this.name = 'IntegrityError';
    this.code = code;
    this.exitCode = 3;
    if (details !== undefined) this.details = details;
  }
}

export class StateError extends Error {
  constructor(msg, details) {
    super(msg);
    this.name = 'StateError';
    this.exitCode = 4;
    if (details !== undefined) this.details = details;
  }
}

/** Exit code for any thrown value (SPEC 10.1). */
export function exitCodeFor(err) {
  if (err instanceof IntegrityError) return 3;
  if (err instanceof UsageError || err instanceof StateError) return 4;
  return 1;
}
