// Shared helpers for the engine, cheater and e2e tests: temp environments and runs driven by the
// fake agents of lib/selftest. Every helper restores process.env through env.restore().

import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, newRun, drive, cli, applyFix, loadScript, roundDir, ledgerOf, readJsonFile } from '../../../lib/selftest/scenarios.mjs';
import { answerJobs } from '../../../lib/selftest/fake-agents.mjs';

export { cli, applyFix, loadScript, roundDir, ledgerOf, readJsonFile, drive, answerJobs };

/** Run fn(env) inside a fresh temp environment; the temp folder is removed afterwards. */
export async function withEnv(fn) {
  const env = makeEnv();
  try {
    return await fn(env);
  } finally {
    env.restore();
    try {
      fs.rmSync(env.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** init + task set + settings; nothing stepped yet. */
export async function freshRun(env, opts = {}) {
  return newRun(env, { script: loadScript(), ...opts });
}

/** A run whose setup is frozen (state READY). */
export async function readyRun(env, opts = {}) {
  const r = await freshRun(env, opts);
  if (opts.beforeSetup) opts.beforeSetup(r);
  const d = await drive(r.runDir, { script: loadScript() });
  if (d.last.exitCode !== 20 || d.last.state !== 'READY') throw new Error(`setup did not freeze: ${d.last.exitCode} ${d.last.text}`);
  return r;
}

/** A run after round 1 (decision FIX). */
export async function fixRun(env, opts = {}) {
  const r = await readyRun(env, opts);
  const d = await drive(r.runDir, { script: loadScript(), mutate: opts.mutate, skip: opts.skip });
  return { ...r, round1: d };
}

/** A run after round 3 (decision DONE, before `done`). */
export async function doneRun(env) {
  const r = await fixRun(env);
  applyFix(r.project);
  await drive(r.runDir, { script: loadScript() });
  const d3 = await drive(r.runDir, { script: loadScript() });
  return { ...r, round3: d3 };
}

/**
 * Step (answering every call with the fake agents) until a printed spawn satisfies `when`;
 * that envelope is returned UNANSWERED so the test can act before the agents answer.
 */
export async function stepUntil(runDir, when, { script = loadScript(), max = 30 } = {}) {
  let extra = [];
  for (let i = 0; i < max; i++) {
    const env = await cli(['step', runDir, ...extra]);
    if (env.exitCode !== 10) return env;
    if (when(env)) return env;
    answerJobs(env.payload.jobs, { runDir, script });
    extra = [];
  }
  throw new Error('stepUntil: condition never met');
}

export const isReviewerSpawn = (e) => e.exitCode === 10 && e.payload.jobs.some((j) => j.role === 'reviewer');

export function stateOf(runDir) {
  return readJsonFile(path.join(runDir, 'state.json'));
}

export function gateOf(runDir, n) {
  return readJsonFile(path.join(roundDir(runDir, n), 'gate.json'));
}

export function clustersOf(runDir) {
  return readJsonFile(path.join(runDir, 'clusters.json')).clusters;
}

export function openOf(runDir) {
  return clustersOf(runDir).filter((c) => ['open', 'unverified', 'contested'].includes(c.status) && ['blocker', 'major'].includes(c.severity) && c.status !== 'waived');
}

export function jobsOf(runDir, n) {
  return readJsonFile(path.join(roundDir(runDir, n), 'jobs.json')).jobs;
}
