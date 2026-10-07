// Jobs and ingest (SPEC 9.8, 9.9, 12.1–12.3, D11).
//
// issueJob renders a prompt from a frozen run template (values are prompt-linted first: a hit is
// exit 3, PROMPT_LINT), creates the neutral job folder via P2 createJob, keeps a byte copy of the
// prompt in the round folder and logs `job-issued` with its hash.
//
// ingestAnswer reads <jobDir>/answer.json, re-hashes PROMPT.md (an edited prompt rejects the
// answer: `prompt-edited`), strips and logs score keys, validates against the role schema and the
// nonce, copies the raw answer write-once (`wx`) into the run folder, logs `answer-ingested` with
// its sha256, records meta mentions, and removes the job folder.

import fs from 'node:fs';
import path from 'node:path';
import { IntegrityError, UsageError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, writeExclusive, readRaw, exists, ensureDir } from '../core/fsx.mjs';
import { sha256Hex } from '../core/hash.mjs';
import { validate, loadSchema } from '../core/schema.mjs';
import { effectiveModel } from '../core/config.mjs';
import { now } from '../core/clock.mjs';
import { isUnder, relPosix } from '../core/paths.mjs';
import { createJob, callFor, readAnswer, removeJob, checkCommandFor } from '../material/jobs.mjs';
import { renderTemplate, loadRunTemplate, lintRendered } from '../material/render.mjs';
import { loadPatterns, findQuote, normalizeQuote } from '../material/lint.mjs';
import { checkReceipts } from '../material/receipts.mjs';
import { metaScan } from '../material/meta-quote.mjs';
import { readSourceTexts } from '../material/sources.mjs';
import { JOB_FILE_RE } from '../material/sample.mjs';
import { crossFieldRules } from '../../templates/check-answer.mjs';
import { log, rngFor, readJsonIf } from './state.mjs';

export const SCHEMA_FOR_ROLE = Object.freeze({
  'lens-writer': 'answer-lens-writer',
  planter: 'answer-planter',
  validator: 'answer-validator',
  reviewer: 'answer-reviewer',
  matcher: 'answer-matcher',
  verifier: 'answer-verifier',
  dispute: 'answer-dispute',
  decoy: 'answer-decoy',
});

export const TEMPLATE_FOR_ROLE = Object.freeze({
  'lens-writer': 'lens-writer.md',
  planter: 'planter.md',
  validator: 'canary-validator.md',
  reviewer: 'reviewer.md',
  matcher: 'matcher.md',
  verifier: 'verifier.md',
  dispute: 'dispute-verifier.md',
  decoy: 'decoy-writer.md',
});

/** Role name in run.json models.optIn for a job role. */
export function modelRoleFor(role, { confirmExtra = false } = {}) {
  if (confirmExtra) return 'confirm-extra';
  if (role === 'dispute') return 'verifier';
  if (role === 'decoy') return 'planter';
  return role;
}

const SCORE_KEYS = new Set(['score', 'rating', 'grade', 'overall']);

/**
 * Remove every key named score/rating/grade/overall (any depth). The matcher's pairs[].score is
 * its own field (a 1–5 match strength), not a quality score, and is kept.
 */
export function stripScoreKeys(value, role) {
  const removed = [];
  const walk = (v, ptr, parentKey) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${ptr}/${i}`, parentKey));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const keep = role === 'matcher' && k === 'score' && /^\/pairs\/\d+$/.test(ptr);
        if (SCORE_KEYS.has(k.toLowerCase()) && !keep) {
          removed.push(`${ptr}/${k}`);
          continue;
        }
        out[k] = walk(x, `${ptr}/${k}`, k);
      }
      return out;
    }
    return v;
  };
  const cleaned = walk(value, '', null);
  return { cleaned, removed };
}

// ---------------------------------------------------------------- job registry

export function jobsFile(rc, round) {
  return rc.paths.roundDir(round).jobs;
}

export function loadJobs(rc, round) {
  const j = readJsonIf(jobsFile(rc, round), null);
  return j ? j.jobs : [];
}

export function saveJobs(rc, round, jobs) {
  writeJsonAtomic(jobsFile(rc, round), { schemaVersion: 1, round, jobs });
}

export function upsertJob(rc, round, rec) {
  const jobs = loadJobs(rc, round);
  const i = jobs.findIndex((j) => j.job === rec.job);
  if (i >= 0) jobs[i] = rec;
  else jobs.push(rec);
  saveJobs(rc, round, jobs);
}

/** Setup jobs (lens writer) live in setup/lens-writer-<n>/job.json. */
export function setupJobs(rc) {
  const dir = rc.paths.setupDir;
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^lens-writer-\d+$/.test(n))
    .sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop()))
    .map((n) => readJsonIf(path.join(dir, n, 'job.json'), null))
    .filter(Boolean);
}

// ---------------------------------------------------------------- issue

/**
 * issueJob(rc, { round, role, lens?, attempt?, values, extra?, confirmExtra?, promptsDir, lintSkip? }) -> job record
 * values: every placeholder of the role template except NONCE, JOB_DIR, CHECK_COMMAND.
 * files: [{ name, content }] put into the job folder (sample files of large data files, SPEC 14.10);
 * a token <<JOB_FILE:name>> in a value becomes the full path of that file in the job folder, so a prompt can name it.
 */
export function issueJob(rc, opts) {
  const { round = null, role, lens = null, attempt = 1, values, extra = {}, confirmExtra = false, promptsDir } = opts;
  const templateName = TEMPLATE_FOR_ROLE[role];
  if (!templateName) throw new UsageError(`no template for role ${role}`);
  const schemaName = SCHEMA_FOR_ROLE[role];
  const text = loadRunTemplate(rc.runDir, templateName);

  // Prompt lint over substituted values (never the frozen template text).
  const lintSkip = opts.lintSkip ?? ['SEVERITY', 'NONCE', 'JOB_DIR', 'WORK_DIR', 'CHECK_COMMAND', 'ANSWER_LANGUAGE', 'PROMPT_PATH', 'EXAMPLE', 'TYPE_DEFINITIONS', 'CANARY_TYPES'];
  // Owner- and lens-derived values: loop-control constructs only. Executor-written values (SOURCES:
  // source descriptions and notes) also get the rating words (score, оценка, average, ...).
  const executorKeys = new Set(['SOURCES']);
  const ownerVals = {};
  const execVals = {};
  for (const [k, v] of Object.entries(values)) (executorKeys.has(k) ? execVals : ownerVals)[k] = v;
  const hits = [
    ...lintRendered(ownerVals, loadPatterns('prompt', { controlOnly: true }), { skip: lintSkip }),
    ...lintRendered(execVals, loadPatterns('prompt'), { skip: lintSkip }),
  ];
  if (hits.length) {
    throw new IntegrityError(
      'PROMPT_LINT',
      `a value for the ${role} prompt contains forbidden text: ` + hits.slice(0, 8).map((h) => `${h.name}: "${h.text}" (${h.patternId})`).join('; '),
      { hits },
    );
  }

  const model = effectiveModel(rc.run, modelRoleFor(role, { confirmExtra }));
  const rng = rngFor(rc, `job:${round}:${role}:${lens}:${attempt}`);
  const created = createJob({
    reviewBase: rc.run.reviewBase,
    role,
    lens,
    attempt,
    schemaName,
    rng,
    runTemplatesDir: rc.paths.templatesDir,
    extraFiles: opts.files ?? [],
    renderPrompt: ({ nonce, jobDir, workDir }) => {
      const bound = {};
      for (const [k, v] of Object.entries(values)) bound[k] = typeof v === 'string' ? v.replace(JOB_FILE_RE, (_, name) => path.join(jobDir, name)) : v;
      return renderTemplate(text, { ...bound, NONCE: nonce, JOB_DIR: jobDir, WORK_DIR: workDir, CHECK_COMMAND: checkCommandFor(jobDir) });
    },
  });
  ensureDir(promptsDir);
  writeExclusive(path.join(promptsDir, `${created.job}.md`), readRaw(created.promptPath));
  const rec = {
    job: created.job,
    role,
    ...(lens ? { lens } : {}),
    attempt,
    ...extra,
    dir: created.dir,
    promptSha256: created.promptSha256,
    schemaName,
    model,
    nonce: created.nonce,
    status: 'pending',
    issuedAt: now(),
  };
  log(rc, 'job-issued', { job: rec.job, role, lens, attempt, promptSha256: rec.promptSha256, model, ...(extra.verifierPass ? { verifierPass: extra.verifierPass } : {}) }, round);
  return rec;
}

/** One entry of the exit-10 payload. */
export function callEntry(rc, rec) {
  const promptPath = path.join(rec.dir, 'PROMPT.md');
  const label = rec.role === 'reviewer' && rec.lens ? `reviewer:${rec.lens}${rec.confirmExtra ? ':extra' : ''}` : rec.role;
  return {
    job: rec.job,
    role: rec.role,
    label,
    call: callFor({ promptPath }, rc.paths.templatesDir),
    model: rec.model ?? null,
    promptPath,
  };
}

/** Payload + text for exit 10. */
export function spawnResult(rc, recs, note = '') {
  const jobs = recs.map((r) => callEntry(rc, r));
  const lines = [];
  if (note) lines.push(note);
  lines.push(`Spawn ${jobs.length} agent(s) in ONE message, in parallel (Agent tool, subagent_type "general-purpose"), each with exactly this prompt and nothing added:`);
  for (const j of jobs) {
    lines.push('');
    lines.push(`[${j.label}] job ${j.job}${j.model ? ` model=${j.model}` : ''}`);
    lines.push(j.call);
  }
  lines.push('');
  lines.push('NEXT: when every agent replied "DONE <code>", run step again with --answer-hash <job>=<code>,... (the code each agent replied) and --usage <job>=<tokens>,... (total tokens of each agent).');
  return {
    exitCode: 10,
    state: rc.state.state,
    payload: { jobs, parallel: true },
    text: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- ingest

/** A finding's file as a copy-relative POSIX path. */
export function normaliseFile(copyDir, file) {
  if (file == null) return null;
  const s = String(file).trim();
  if (copyDir && (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s))) {
    try {
      if (isUnder(s, copyDir)) return relPosix(copyDir, s);
    } catch {
      /* fall through */
    }
  }
  return s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * What a reviewer answer may quote from: the review copy of the round and the raw output of the
 * primary sources the engine ran at its start (readSourceTexts re-hashes every file).
 */
function metaEvidence(rc, round) {
  if (round == null) return { copyDir: null, sources: [] };
  try {
    const rd = rc.paths.roundDir(round);
    const copyDir = readJsonIf(rd.roundJson, null)?.copyDir ?? null;
    const check = readJsonIf(rd.sourcesCheck, null)?.results ?? null;
    return { copyDir: copyDir && exists(copyDir) ? copyDir : null, sources: check ? readSourceTexts(rd.dir, check) : [] };
  } catch {
    return { copyDir: null, sources: [] };
  }
}

/**
 * Meta mentions of an answer: { mentions: ['M-CANARY: canary', ...], ignored: [...] }.
 * mentions invalidate a reviewer attempt; ignored lists the hits the engine showed to be quotes from
 * the material or from a primary source (see lib/material/meta-quote.mjs); they are recorded so the
 * report can show them. Only reviewer answers are checked against the material.
 */
function metaMentionsOf(json, evidence) {
  try {
    const pats = loadPatterns('meta');
    const r = metaScan(json, { patterns: pats, ...evidence });
    return { mentions: r.hits.map((h) => `${h.patternId}: ${h.text}`), ignored: r.ignored, ignoredTotal: r.ignoredTotal ?? r.ignored.reduce((n, x) => n + (x.count || 1), 0) };
  } catch {
    return { mentions: [], ignored: [], ignoredTotal: 0 };
  }
}

/**
 * ingestAnswer(rc, round, job, { dest }) -> null (no answer yet) | record
 * record = { job, role, lens, attempt, answerSha256, kept, reasons, json, ignoredScoreKeys, metaMentions, metaIgnored, schemaErrors }
 * dest: where the raw answer is kept (write-once). Default rounds/NN/answers/<job>.json.
 */
export function ingestAnswer(rc, round, job, opts = {}) {
  const r = readAnswer(job.dir);
  if (!r.exists) return null;
  const reasons = [];
  if (r.promptSha256Now !== job.promptSha256) reasons.push('prompt-edited');
  // The code the agent replied with ("DONE <code>", printed by check-answer.mjs) binds the answer it
  // wrote to the answer ingested here: a file changed in between is rejected. Without a code the
  // answer is kept but logged as unbound (Agent mode relays codes by hand; the report counts them).
  const code = rc.answerHashes?.[job.job] ?? null;
  if (code && !String(r.sha256).startsWith(String(code).toLowerCase())) reasons.push('answer-hash-mismatch');
  let json = null;
  let ignoredScoreKeys = [];
  let schemaErrors = [];
  if (r.parseError || r.json === null) {
    reasons.push('schema-invalid');
    schemaErrors = [{ path: '', message: r.parseError || 'empty' }];
  } else {
    const s = stripScoreKeys(r.json, job.role);
    json = s.cleaned;
    ignoredScoreKeys = s.removed;
    const v = validate(loadSchema(job.schemaName), json);
    if (!v.ok) {
      reasons.push('schema-invalid');
      schemaErrors = v.errors.slice(0, 50);
    }
    if (!json || json.nonce !== job.nonce) reasons.push('nonce-mismatch');
    // Cross-field rules of SPEC 9.9 that the schema subset cannot express (unique finding numbers,
    // the quote / missingWhat / seen a finding kind needs, a class for "confirmed"): the same rules
    // the agent's own check applies, enforced here too.
    const cross = json ? crossFieldRules(json) : [];
    if (cross.length) {
      if (!reasons.includes('schema-invalid')) reasons.push('schema-invalid');
      schemaErrors = [...schemaErrors, ...cross].slice(0, 50);
    }
  }
  const dest = opts.dest ?? path.join(rc.paths.roundDir(round).answers, `${job.job}.json`);
  ensureDir(path.dirname(dest));
  if (exists(dest)) {
    const have = sha256Hex(readRaw(dest));
    if (have !== r.sha256) throw new IntegrityError('TAMPER', `a different answer was already ingested for job ${job.job}`, { dest });
  } else {
    writeExclusive(dest, r.rawBuffer);
  }
  const meta = json ? metaMentionsOf(json, job.role === 'reviewer' ? metaEvidence(rc, round) : { copyDir: null, sources: [] }) : { mentions: [], ignored: [], ignoredTotal: 0 };
  const metaMentions = meta.mentions;
  const metaIgnored = meta.ignored;
  const metaIgnoredTotal = meta.ignoredTotal ?? 0;
  // Agent mode: the executor window types the spawn message. A reviewer copies the message it was
  // started with into instructionReceived; one that differs from the fixed call (words added, e.g.
  // "final pass, report only blockers") is logged and counted in the report (r3-f10). EVID only: a
  // window that adds words can also ask the agent to copy the plain call.
  let spawnEcho = null;
  if (job.role === 'reviewer' && json) {
    let want = null;
    try {
      want = callFor({ dir: job.dir }, rc.paths.templatesDir);
    } catch {
      want = null;
    }
    const norm = (x) => normalizeQuote(String(x ?? '')).replace(/\\/g, '/').toLowerCase();
    spawnEcho = typeof json.instructionReceived !== 'string' || !json.instructionReceived.trim() ? 'missing' : want !== null && norm(json.instructionReceived) === norm(want) ? 'same' : 'differs';
  }
  // A reviewer answer that breaks only its binding (the prompt changed before it answered, or the
  // relayed code does not match the file) is still parsed and its findings are kept: discarding it
  // would let the window drop an inconvenient answer by relaying a wrong code (a free re-roll of
  // the lens, r2-f41). The attempt is still invalid (reviewerRecord), so the lens is reviewed again.
  const BINDING_REASONS = ['answer-hash-mismatch', 'prompt-edited'];
  const blocking = job.role === 'reviewer' ? reasons.filter((x) => !BINDING_REASONS.includes(x)) : reasons;
  const kept = blocking.length === 0;
  log(
    rc,
    'answer-ingested',
    {
      job: job.job,
      role: job.role,
      lens: job.lens ?? null,
      attempt: job.attempt ?? 1,
      sha256: r.sha256,
      dest: opts.logDest ?? path.relative(rc.runDir, dest).replace(/\\/g, '/'),
      kept,
      reasons,
      ignoredScoreKeys,
      ...(metaIgnoredTotal > 0 ? { metaIgnored: metaIgnoredTotal } : {}),
      boundByAgentCode: !!code,
      ...(spawnEcho ? { spawnEcho } : {}),
    },
    round,
  );
  const removed = removeJob(job.dir);
  return {
    job: job.job,
    role: job.role,
    lens: job.lens ?? null,
    attempt: job.attempt ?? 1,
    answerSha256: r.sha256,
    answerFileMs: r.mtimeMs,
    kept,
    reasons,
    json: kept ? json : null,
    ignoredScoreKeys,
    metaMentions,
    metaIgnored,
    schemaErrors,
    jobFolderRemoved: removed.removed,
  };
}

/** Characters of an "unavailable" result a reviewer must give as the excerpt of the error (no empty claims). */
export const UNAVAILABLE_EXCERPT_MIN = 3;

/** A result that is an error status or a block, not data: "HTTP 429 Too Many Requests", "403", "throttled", "timed out". */
const ERROR_RESULT = /^\s*(?:(?:http\s*)?[45]\d\d\b|throttled|rate[- ]?limit|too many requests|timed? ?out|timeout|captcha|connection (?:refused|reset)|econn|etimedout)/i;

/**
 * summariseSourceAttempts(sourceChecks) -> [{ sourceId, attempts, ok, unavailable, excerpt }]
 * One entry per source the reviewer documented. An attempt counts when it names the source and carries
 * a non-empty result; outcome "unavailable" (the source answered with an error, a block or nothing)
 * counts only with an excerpt of that error in `result`. A missing outcome means the attempt worked, unless
 * `result` starts with an error status. One entry is one attempt: an entry that sums up several runs counts once.
 */
export function summariseSourceAttempts(sourceChecks) {
  const by = new Map();
  for (const c of Array.isArray(sourceChecks) ? sourceChecks : []) {
    if (!c || typeof c.sourceId !== 'string' || c.sourceId === '') continue;
    const result = String(c.result ?? '').trim();
    // An entry without `outcome` whose result is itself an error status ("HTTP 429", "throttled", "timed out")
    // is read as unavailable: the reviewer wrote down what the source answered, the code reads it.
    const unavailable = c.outcome === 'unavailable' || (c.outcome == null && ERROR_RESULT.test(result));
    if (unavailable ? result.length < UNAVAILABLE_EXCERPT_MIN : false) continue;
    const e = by.get(c.sourceId) || { sourceId: c.sourceId, attempts: 0, ok: 0, unavailable: 0, excerpt: '' };
    e.attempts += 1;
    if (unavailable) {
      e.unavailable += 1;
      if (!e.excerpt) e.excerpt = result.slice(0, 200);
    } else e.ok += 1;
    by.set(c.sourceId, e);
  }
  return [...by.values()];
}

/**
 * A source-check minimum the reviewer marked not done still stands when the source refused them: the documented
 * attempts reach the item's count and at least one is "unavailable". -> the source's attempt summary, or null.
 * Attempts are counted per source, over every minimum of the lens that names it (one run of a source can serve
 * two items); the report uses the same rule, so both read a rescued item the same way.
 */
export function sourceMinimumRescue(m, attemptsOf) {
  if (!m || m.kind !== 'source-check') return null;
  const at = attemptsOf.get(m.sourceId);
  return at && at.attempts >= (m.count || 1) && at.unavailable >= 1 ? at : null;
}

/**
 * Reviewer validity (12.2) and quote grounding (12.3). Mutates nothing; returns the ingest record
 * written to rounds/NN/ingest/<job>.json.
 */
export function reviewerRecord(base, { job, lens, copyDir, requirements }) {
  const rec = {
    job: job.job,
    lens: job.lens,
    attempt: job.attempt,
    confirmExtra: !!job.confirmExtra,
    answerSha256: base.answerSha256,
    kept: base.kept,
    valid: false,
    reasons: [...base.reasons],
    receipts: { correct: 0, total: (job.challenges || []).length },
    minimumMissing: [],
    minimumNotDone: [],
    minimumUnavailable: [],
    sourceAttempts: [],
    quoteChecks: [],
    metaMentions: base.metaMentions,
    metaIgnored: base.metaIgnored ?? [],
    ignoredScoreKeys: base.ignoredScoreKeys,
    counts: { blocker: 0, major: 0, cosmetic: 0 },
    notChecked: [],
    notVerified: [],
  };
  if (!base.kept || !base.json) return rec;
  const a = base.json;
  const rr = checkReceipts(job.challenges || [], a.receipt || []);
  rec.receipts = { correct: rr.correct, total: rr.total };
  if (rr.total > 0 && rr.correct < Math.min(2, rr.total)) rec.reasons.push(`receipts ${rr.correct}/${rr.total}`);
  const inspected = a.inspected || [];
  // Every documented attempt at a primary source, with its outcome (ok / unavailable + excerpt).
  rec.sourceAttempts = summariseSourceAttempts(a.sourceChecks);
  const attemptsOf = new Map(rec.sourceAttempts.map((x) => [x.sourceId, x]));
  for (const m of lens?.minimum || []) {
    const e = inspected.find((x) => x.minimumId === m.id);
    if (!e) rec.minimumMissing.push(m.id);
    else if (e.done === false) {
      // A source-check minimum counts what the reviewer tried and documented, not only what worked:
      // a source that blocks the reviewers (HTTP 429, captcha, timeout) must not make the lens invalid
      // every round. Enough documented attempts, at least one of them "unavailable" with its excerpt,
      // and the item stands as done; the unavailability itself is recorded and reported.
      const at = sourceMinimumRescue(m, attemptsOf);
      if (at) {
        rec.minimumUnavailable.push({ minimumId: m.id, sourceId: m.sourceId, attempts: at.attempts, unavailable: at.unavailable, ok: at.ok, excerpt: at.excerpt });
        continue;
      }
      rec.minimumNotDone.push(m.id);
      if (!e.how || String(e.how).trim().length < 10) rec.minimumMissing.push(m.id);
    }
  }
  if (rec.minimumMissing.length) rec.reasons.push(`minimum not recorded: ${rec.minimumMissing.join(', ')}`);
  // An item of the mandatory minimum marked not done makes the answer invalid (the lens is reviewed
  // again by a fresh reviewer): "nothing found" counts only with the whole minimum done (failure point 3).
  const notDoneOnly = rec.minimumNotDone.filter((id) => !rec.minimumMissing.includes(id));
  if (notDoneOnly.length) rec.reasons.push(`minimum not done: ${notDoneOnly.join(', ')}`);
  const marked = new Set((a.requirements || []).map((x) => x.id));
  const unmarked = (requirements || []).map((r) => r.id).filter((id) => !marked.has(id));
  if (unmarked.length) rec.reasons.push(`requirements not marked: ${unmarked.join(', ')}`);
  if (base.metaMentions.length) rec.reasons.push('talks about the check itself');
  for (const f of a.findings || []) {
    const file = normaliseFile(copyDir, f.location?.file);
    let grounded = null;
    if (f.quote != null && String(f.quote).trim() !== '') {
      grounded = copyDir ? findQuote(copyDir, file, f.quote).found : false;
      if (grounded && f.quote2) grounded = findQuote(copyDir, file, f.quote2).found;
    } else if (f.kind === 'omission') grounded = f.missingWhat ? null : false;
    else if (f.kind === 'visual') grounded = f.seen ? null : false;
    else grounded = false;
    rec.quoteChecks.push({ n: f.n, grounded, file });
    if (rec.counts[f.severity] !== undefined) rec.counts[f.severity] += 1;
  }
  rec.notChecked = a.notChecked || [];
  rec.notVerified = a.notVerified || [];
  rec.valid = rec.reasons.length === 0;
  return rec;
}

/** Findings of a kept reviewer answer in a normalised shape for clustering and matching. */
export function findingsOf(base, rec, { round, copyDir }) {
  if (!base || !base.kept || !base.json) return [];
  const checks = new Map((rec.quoteChecks || []).map((q) => [q.n, q]));
  return (base.json.findings || []).map((f) => {
    const q = checks.get(f.n);
    return {
      round,
      lens: rec.lens,
      job: rec.job,
      attempt: rec.attempt,
      n: f.n,
      severity: f.severity,
      kind: f.kind,
      file: q ? q.file : normaliseFile(copyDir, f.location?.file),
      locator: f.location?.locator ?? '',
      quote: f.quote ?? null,
      quote2: f.quote2 ?? null,
      seen: f.seen ?? null,
      missingWhat: f.missingWhat ?? null,
      problem: f.problem ?? '',
      fix: f.fix ?? null,
      evidence: f.evidence ?? null,
      grounded: q ? q.grounded !== false : false,
    };
  });
}

export function writeIngest(rc, round, rec) {
  writeJsonAtomic(path.join(rc.paths.roundDir(round).ingest, `${rec.job}.json`), rec);
}

export function readIngest(rc, round, job) {
  return readJsonIf(path.join(rc.paths.roundDir(round).ingest, `${job}.json`), null);
}

/** Parsed (score-stripped) answer of a job from the run folder copy, or null. */
export function storedAnswer(rc, round, job) {
  const p = path.join(rc.paths.roundDir(round).answers, `${job.job || job}.json`);
  if (!exists(p)) return null;
  try {
    const raw = readRaw(p).toString('utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return stripScoreKeys(j, job.role || 'reviewer').cleaned;
  } catch {
    return null;
  }
}

export { readJson };
