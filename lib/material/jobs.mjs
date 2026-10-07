// Agent jobs (SPEC 9.8, 11, 15.1, 15.3, D11, 23.2).
//
// A job is a neutral folder <reviewBase>/<8 chars>/ holding:
//   PROMPT.md           the rendered prompt (UTF-8, no BOM, LF), hashed into promptSha256
//   answer.schema.json  the role's schema, copied byte-exact from the repo schemas/
//   check-answer.mjs    the standalone checker, copied byte-exact from the run's frozen templates/
//   work/               the job's own scratch folder (empty): helper scripts, extracts, downloads, notes.
//                       It lies outside the review copy, so nothing an agent makes while it works
//                       can change the copy (SPEC 14.13); it goes away with the job folder.
// The agent writes answer.json there. createJob owns job id and nonce generation, so every prompt
// that shows a nonce or a job folder gets them from one place.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { sha256Hex } from '../core/hash.mjs';
import { readRaw, readText, safeRemove, writeRaw, writeTextAtomic } from '../core/fsx.mjs';
import { NEUTRAL_ALPHABET } from '../core/rand.mjs';
import { schemaPath } from '../core/schema.mjs';
import { lintPath, loadPatterns } from './lint.mjs';
import { renderTemplate, verifyRunTemplate } from './render.mjs';

export const NONCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOB_ID_RE = /^[a-z2-9]{8}$/;
export const NONCE_RE = /^PL-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
export const ROLES = Object.freeze(['lens-writer', 'planter', 'validator', 'reviewer', 'matcher', 'verifier', 'dispute', 'decoy']);
export const PROMPT_FILE = 'PROMPT.md';
export const ANSWER_FILE = 'answer.json';
export const SCHEMA_FILE = 'answer.schema.json';
export const CHECK_FILE = 'check-answer.mjs';
export const WORK_DIR_NAME = 'work';
export const CALL_TEMPLATE = 'agent-call.txt';

const MAX_TRIES = 100;

/** A fresh nonce "PL-XXXX-XXXX". */
export function makeNonce(rng) {
  return `PL-${rng.id(4, NONCE_ALPHABET)}-${rng.id(4, NONCE_ALPHABET)}`;
}

/** The scratch folder of a job folder. */
export function workDirOf(jobDir) {
  return path.join(jobDir, WORK_DIR_NAME);
}

/** The command an agent runs to check its answer (15.3 CHECK_COMMAND). */
export function checkCommandFor(jobDir) {
  return `node "${path.join(jobDir, CHECK_FILE)}" "${path.join(jobDir, ANSWER_FILE)}"`;
}

function schemaFileFor(schemaName, schemasDir) {
  const base = String(schemaName).replace(/\.schema\.json$/, '').replace(/\.json$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(base)) throw new UsageError(`bad schema name: ${schemaName}`);
  const p = schemasDir ? path.join(schemasDir, `${base}.schema.json`) : schemaPath(base);
  if (!fs.existsSync(p)) throw new UsageError(`unknown answer schema: ${schemaName}`);
  return p;
}

/**
 * createJob({ reviewBase, role, lens?, attempt?, renderPrompt, schemaName, rng, runTemplatesDir, tracePatterns?, schemasDir? }) ->
 *   { job, dir, promptPath, promptSha256, nonce, role, lens, attempt, schemaName }
 * renderPrompt({ nonce, jobDir, workDir }) must return the prompt text. The job folder is removed again
 * if rendering or writing fails. The folder path must pass the path lint (trace patterns).
 * schemaName: "answer-reviewer" or "answer-reviewer.schema.json"; schemasDir defaults to the repo schemas/.
 * extraFiles: [{ name, content }] written byte-exact into the job folder next to PROMPT.md (the sample
 * files of large data files, SPEC 14.10); a name must be a plain file name.
 */
export function createJob(opts) {
  const { reviewBase, role, lens = null, attempt = 1, renderPrompt, schemaName, rng, runTemplatesDir } = opts ?? {};
  if (!reviewBase || !rng || typeof renderPrompt !== 'function' || !schemaName || !runTemplatesDir) {
    throw new UsageError('createJob needs reviewBase, rng, renderPrompt, schemaName and runTemplatesDir');
  }
  if (!ROLES.includes(role)) throw new UsageError(`unknown job role: ${role}`);
  const schemaSrc = schemaFileFor(schemaName, opts.schemasDir);
  verifyRunTemplate(runTemplatesDir, CHECK_FILE);
  const patterns = opts.tracePatterns ?? loadPatterns('trace');

  const baseHits = lintPath(reviewBase, patterns);
  if (baseHits.length) {
    throw new UsageError(`the review base path has review traces (${baseHits.map((h) => h.component).join(', ')}); set run.json reviewBase to a neutral folder under a run root`);
  }
  fs.mkdirSync(reviewBase, { recursive: true });

  let job = null;
  let dir = null;
  for (let i = 0; i < MAX_TRIES && !job; i++) {
    const cand = rng.id(8, NEUTRAL_ALPHABET);
    if (!JOB_ID_RE.test(cand) || lintPath(cand, patterns).length) continue;
    const d = path.join(reviewBase, cand);
    try {
      fs.mkdirSync(d); // exclusive: fails when it exists
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    job = cand;
    dir = d;
  }
  if (!job) throw new UsageError(`could not create a job folder under ${reviewBase}`);

  const nonce = makeNonce(rng);
  try {
    const workDir = workDirOf(dir);
    fs.mkdirSync(workDir);
    const prompt = renderPrompt({ nonce, jobDir: dir, workDir });
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new UsageError('renderPrompt returned an empty prompt');
    const promptPath = path.join(dir, PROMPT_FILE);
    writeTextAtomic(promptPath, prompt);
    for (const f of opts.extraFiles ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(f.name)) || [PROMPT_FILE, ANSWER_FILE, SCHEMA_FILE, CHECK_FILE, WORK_DIR_NAME].includes(f.name)) throw new UsageError(`bad extra file name for a job: ${f.name}`);
      writeRaw(path.join(dir, f.name), Buffer.from(String(f.content), 'utf8'));
    }
    writeRaw(path.join(dir, SCHEMA_FILE), readRaw(schemaSrc));
    writeRaw(path.join(dir, CHECK_FILE), readRaw(path.join(runTemplatesDir, CHECK_FILE)));
    const promptSha256 = sha256Hex(readRaw(promptPath));
    return { job, dir, promptPath, promptSha256, nonce, role, lens, attempt, schemaName };
  } catch (e) {
    safeRemove(dir);
    throw e;
  }
}

/** callFor(job, runTemplatesDir) -> the exact text to give the agent (agent-call.txt filled). */
export function callFor(job, runTemplatesDir) {
  const promptPath = job?.promptPath ?? (job?.dir ? path.join(job.dir, PROMPT_FILE) : null);
  if (!promptPath) throw new UsageError('callFor needs a job with promptPath or dir');
  verifyRunTemplate(runTemplatesDir, CALL_TEMPLATE);
  const text = readText(path.join(runTemplatesDir, CALL_TEMPLATE)).replace(/\s+$/, '');
  return renderTemplate(text, { PROMPT_PATH: promptPath });
}

/**
 * readAnswer(jobDir) -> { exists, raw, rawBuffer, sha256, json, parseError, promptSha256Now, mtimeMs }
 * raw: the file decoded as UTF-8 exactly (a BOM stays in `raw`; writing raw back as UTF-8 gives the
 * same bytes for valid UTF-8). sha256: of the bytes. json: parsed with the BOM stripped, or null.
 * promptSha256Now: sha256 of PROMPT.md bytes now, or null when it is gone.
 * mtimeMs: when answer.json was last written (null when there is none): the time the agent finished.
 */
export function readAnswer(jobDir) {
  const promptPath = path.join(jobDir, PROMPT_FILE);
  const promptSha256Now = fs.existsSync(promptPath) ? sha256Hex(readRaw(promptPath)) : null;
  const answerPath = path.join(jobDir, ANSWER_FILE);
  if (!fs.existsSync(answerPath) || !fs.statSync(answerPath).isFile()) {
    return { exists: false, raw: null, rawBuffer: null, sha256: null, json: null, parseError: null, promptSha256Now, mtimeMs: null };
  }
  const rawBuffer = readRaw(answerPath);
  const mtimeMs = Math.round(fs.statSync(answerPath).mtimeMs);
  const raw = rawBuffer.toString('utf8');
  let json = null;
  let parseError = null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(rawBuffer);
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    parseError = e instanceof TypeError ? `not valid UTF-8: ${e.message}` : e.message;
    json = null;
  }
  return { exists: true, raw, rawBuffer, sha256: sha256Hex(rawBuffer), json, parseError, promptSha256Now, mtimeMs };
}

/** removeJob(jobDir) -> safeRemove result. */
export function removeJob(jobDir) {
  return safeRemove(jobDir);
}

/** True when promptSha256Now equals the recorded hash (a job whose prompt was edited is rejected). */
export function promptUnchanged(readResult, promptSha256) {
  return Boolean(readResult) && readResult.promptSha256Now !== null && readResult.promptSha256Now === promptSha256;
}
