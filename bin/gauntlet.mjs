#!/usr/bin/env node
// gauntlet CLI entry (SPEC 10): argv parsing, dispatch table, --json envelope with sig, exit codes.
//
//   node bin/gauntlet.mjs <command> [<runDir>] [options] [--json]
//
// Exit codes: 0 done, 10 agents to spawn, 20 executor action, 30 stopped (report written),
//             3 integrity failure, 4 usage error, 1 internal error.
// With --json stdout is exactly one JSON object:
//   { ok, exitCode, command, state, payload, sig }   sig = sha256(canonical(payload))

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical } from '../lib/core/canon.mjs';
import { sha256Hex } from '../lib/core/hash.mjs';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Command -> module (relative to the repository). `ledger` and `report` belong to P4. */
export const DISPATCH = Object.freeze({
  init: 'lib/engine/cmd-init.mjs',
  task: 'lib/engine/cmd-task.mjs',
  sources: 'lib/engine/cmd-sources.mjs',
  step: 'lib/engine/cmd-step.mjs',
  status: 'lib/engine/cmd-status.mjs',
  todo: 'lib/engine/cmd-todo.mjs',
  dispute: 'lib/engine/cmd-dispute.mjs',
  waive: 'lib/engine/cmd-waive.mjs',
  owner: 'lib/engine/cmd-owner.mjs',
  amend: 'lib/engine/cmd-amend.mjs',
  done: 'lib/engine/cmd-done.mjs',
  report: 'lib/report/cmd-report.mjs',
  audit: 'lib/engine/cmd-audit.mjs',
  'restore-best': 'lib/engine/cmd-restore-best.mjs',
  abort: 'lib/engine/cmd-abort.mjs',
  cleanup: 'lib/engine/cmd-cleanup.mjs',
  lint: 'lib/engine/cmd-lint.mjs',
  ledger: 'lib/measure/cmd-ledger.mjs',
  selftest: 'lib/selftest/cmd-selftest.mjs',
  doctor: 'lib/engine/cmd-doctor.mjs',
  templates: 'lib/engine/cmd-templates.mjs',
});

const USAGE = `usage: gauntlet <command> [<runDir>] [options] [--json]
commands: ${Object.keys(DISPATCH).join(', ')}
exit codes: 0 done, 10 spawn agents, 20 executor action, 30 stopped, 3 integrity, 4 usage, 1 bug`;

/** sig = sha256(canonical(payload)) — the Workflow driver recomputes it (D24). */
export function sigOf(payload) {
  return sha256Hex(canonical(payload ?? null));
}

function exitCodeFor(err) {
  const name = err && (err.name || err.constructor?.name);
  if (name === 'IntegrityError') return 3;
  if (name === 'UsageError' || name === 'StateError') return 4;
  if (err && (err.exitCode === 3 || err.exitCode === 4)) return err.exitCode;
  return 1;
}

/**
 * main(argv, { env, stdout }) -> { exitCode, out, envelope }
 * In-process entry used by the selftest and the tests; the process entry below only prints.
 */
export async function main(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const args = [...argv];
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const command = rest.shift();
  let result;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    result = { exitCode: command ? 0 : 4, state: null, payload: { usage: USAGE }, text: USAGE };
  } else if (!Object.prototype.hasOwnProperty.call(DISPATCH, command)) {
    result = { exitCode: 4, state: null, payload: { error: { kind: 'UsageError', message: `unknown command: ${command}` } }, text: `unknown command: ${command}\n${USAGE}` };
  } else {
    try {
      const { dataHome } = await import('../lib/core/datahome.mjs');
      // `doctor` only looks: it never creates the data home (r2-f35).
      const ctx = { repoDir: REPO_DIR, dataHome: dataHome({ env, create: command !== 'doctor' }), json, env };
      const mod = await import(pathToFileURL(path.join(REPO_DIR, DISPATCH[command])).href);
      result = await mod.run(rest, ctx);
      if (!result || typeof result.exitCode !== 'number') throw new Error(`command ${command} returned no result`);
    } catch (err) {
      const code = exitCodeFor(err);
      const kind = err?.name || 'Error';
      const message = String(err?.message ?? err);
      const payload = { error: { kind, code: err?.code ?? null, message, details: err?.details ?? null } };
      if (code === 1 && env.GAUNTLET_DEBUG) payload.error.stack = String(err?.stack || '');
      result = {
        exitCode: code,
        state: null,
        payload,
        text: `${code === 3 ? 'INTEGRITY FAILURE' : code === 4 ? 'USAGE ERROR' : 'INTERNAL ERROR'}${err?.code ? ` (${err.code})` : ''}: ${message}` +
          (code === 1 ? `\n${String(err?.stack || '').split('\n').slice(1, 6).join('\n')}` : '') +
          `\nNEXT: ${code === 3 ? 'stop; nothing further runs until the owner looks at it' : code === 4 ? 'fix the command and run it again' : 'report this bug; do not work around it'}`,
      };
    }
  }
  const payload = result.payload ?? {};
  const envelope = {
    ok: [0, 10, 20, 30].includes(result.exitCode),
    exitCode: result.exitCode,
    command: command ?? null,
    state: result.state ?? null,
    payload,
    sig: sigOf(payload),
  };
  const out = json ? JSON.stringify(envelope) : String(result.text ?? '');
  return { exitCode: result.exitCode, out, envelope, result };
}

// Real paths, case-folded on Windows: a call through a junction or symlink must still run main()
// instead of printing nothing with exit 0 (which would read as "nothing waiting", r2-f23).
function isEntry() {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => {
      const r = fs.realpathSync(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(path.resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then(
    ({ exitCode, out }) => {
      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      process.exitCode = exitCode;
    },
    (err) => {
      process.stderr.write(`INTERNAL ERROR: ${err?.stack || err}\n`);
      process.exitCode = 1;
    },
  );
}
