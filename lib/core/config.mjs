// run.json settings: defaults, validation, model opt-in rules, freeze (SPEC 9.1, 9.6).
//
// Rules enforced here (CODE level):
//  - limits and canaries are filled with the SPEC 9.1 defaults; the written run.json
//    then contains them, so FROZEN.json hashes the effective values;
//  - a role with no models.optIn entry runs with no explicit model (Sonnet via
//    CLAUDE_CODE_SUBAGENT_MODEL); every optIn entry needs approvedBy (the owner label, see ownerLabel()), a quote of
//    at least 10 characters and a real date, else freeze fails (exit 4);
//  - driver.mode "workflow" needs driver.workflowOptIn with a quote (>= 5 chars) and a date.

import fs from 'node:fs';
import { ownerWordsErrors, ownerLabel } from './owner.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic, exists, listFiles } from './fsx.mjs';
import { hashFile, hashJson } from './hash.mjs';
import { validate, loadSchema } from './schema.mjs';
import { runPaths } from './runstore.mjs';
import { now } from './clock.mjs';
import { IntegrityError, UsageError } from './errors.mjs';

export const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url));

export const MODEL_ROLES = Object.freeze(['reviewer', 'verifier', 'planter', 'validator', 'matcher', 'lens-writer', 'confirm-extra']);

export const DEFAULT_LIMITS = Object.freeze({
  maxRounds: 8,
  maxConfirms: 2,
  maxPanelTokens: 15000000,
  plateauRounds: 2,
  maxLensReruns: 1,
  verifierBatchMax: 8,
  roundTokenEstimate: 1800000,
  // Large data files are reviewed through a seeded sample (SPEC 14.10). A data file above either
  // threshold is sampled: the header plus up to sampleRows rows (never more than sampleMaxBytes
  // characters once 20 rows are in), drawn afresh every round.
  sampleThresholdBytes: 1048576,
  sampleThresholdRows: 2000,
  sampleRows: 200,
  sampleMaxBytes: 100000,
  // The most characters of drawn rows in all sample files of a round together (split evenly over
  // the large files; every large file keeps at least 20 rows).
  sampleTotalBytes: 250000,
});

export const DEFAULT_CANARIES = Object.freeze({
  attentionPerLens: 1,
  measurementWorking: 1,
  measurementConfirm: 2,
  candidatesPerSlot: 2,
  maxEditChars: 240,
  minDistanceChars: 400,
  // False findings (decoys) mixed into verifier batches each round; 0 switches them off (looser: owner's words).
  decoysPerRound: 8,
  // True controls (real planted defects found by the reviewers) mixed into verifier batches each round; 0 switches them off (looser: owner's words).
  controlsPerRound: 4,
  visualAllowed: false,
  fixedKey: null,
});

export const DEFAULT_ALLOW_EXECUTABLES = Object.freeze(['curl', 'node', 'python', 'python3', 'git']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A copy of run with every SPEC 9.1 default filled in. Existing values are kept. */
export function applyDefaults(run) {
  if (!isObj(run)) throw new UsageError('run.json must be a JSON object');
  const r = structuredClone(run);
  r.schemaVersion = r.schemaVersion ?? 1;
  r.limits = { ...DEFAULT_LIMITS, ...(isObj(r.limits) ? r.limits : {}) };
  r.canaries = { ...DEFAULT_CANARIES, ...(isObj(r.canaries) ? r.canaries : {}) };
  // Visual planted errors need a rebuild of the copy; when the run has one they are on unless the
  // executor turned them off explicitly (r2-f44: practice rounds r8-r10 planted one every round).
  if (!(isObj(run.canaries) && typeof run.canaries.visualAllowed === 'boolean')) r.canaries.visualAllowed = isObj(r.rebuild);
  if (r.generalist === undefined) r.generalist = true;
  if (!isObj(r.models)) r.models = { optIn: [] };
  else if (r.models.optIn === undefined) r.models = { ...r.models, optIn: [] };
  if (!isObj(r.driver)) r.driver = { mode: 'agent', workflowOptIn: null };
  else {
    if (r.driver.mode === undefined) r.driver = { ...r.driver, mode: 'agent' };
    if (r.driver.workflowOptIn === undefined) r.driver = { ...r.driver, workflowOptIn: null };
  }
  if (r.allowExecutables === undefined) r.allowExecutables = [...DEFAULT_ALLOW_EXECUTABLES];
  return r;
}

export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function optInErrors(entry, i, legacy = {}) {
  const errs = [];
  const at = `/models/optIn/${i}`;
  if (!isObj(entry)) return [{ path: at, message: 'must be an object' }];
  if (!MODEL_ROLES.includes(entry.role)) errs.push({ path: `${at}/role`, message: `must be one of ${MODEL_ROLES.join(', ')}` });
  if (typeof entry.model !== 'string' || entry.model.trim() === '') errs.push({ path: `${at}/model`, message: 'a model name is required' });
  if (entry.approvedBy !== ownerLabel()) errs.push({ path: `${at}/approvedBy`, message: `must be "${ownerLabel()}" (env GAUNTLET_OWNER): another model runs only on the owner's word` });
  errs.push(...ownerWordsErrors(entry, at, legacy));
  if (!isRealDate(entry.date)) errs.push({ path: `${at}/date`, message: 'must be a real date YYYY-MM-DD' });
  return errs;
}

/**
 * Direction in which a limit may move away from its default without the owner's words:
 * 'down' = a smaller value is stricter (fewer rounds, tokens, reruns, an earlier plateau stop);
 * 'up' = a larger value is stricter (a larger per-round estimate stops earlier).
 */
export const LIMIT_STRICTER = Object.freeze({
  maxRounds: 'down',
  maxConfirms: 'down',
  maxPanelTokens: 'down',
  plateauRounds: 'down',
  maxLensReruns: 'down',
  verifierBatchMax: 'down',
  roundTokenEstimate: 'up',
  // A bigger sample or budget means more of a data file is read: stricter. A threshold counts as the
  // other way round (a smaller one samples more files); a raised one is looser than the default and needs limitsOptIn (SAMPLE_THRESHOLD_CEILING).
  sampleThresholdBytes: 'up',
  sampleThresholdRows: 'up',
  sampleRows: 'up',
  sampleMaxBytes: 'up',
  sampleTotalBytes: 'up',
});

/**
 * A raised sampling threshold is never free: the ceiling is the default itself, so any value above
 * 1 MiB / 2 000 rows is a limit looser than the defaults and needs limitsOptIn with the owner's
 * words and question. Otherwise the executor could switch sampling off for a file of up to 20 MiB
 * with no word from the owner, reviewers would be handed 99 000 rows they cannot read, and both the
 * setup summary and the report would stop saying that those files exist.
 */
export const SAMPLE_THRESHOLD_CEILING = Object.freeze({
  sampleThresholdBytes: DEFAULT_LIMITS.sampleThresholdBytes,
  sampleThresholdRows: DEFAULT_LIMITS.sampleThresholdRows,
});

/**
 * The same for the planted-error settings (r3-f9): fewer planted errors, bigger edits, errors closer
 * together or more candidates per slot to choose from all make the gross-failure check easier.
 */
export const CANARY_STRICTER = Object.freeze({
  attentionPerLens: 'up',
  measurementWorking: 'up',
  measurementConfirm: 'up',
  candidatesPerSlot: 'down',
  maxEditChars: 'down',
  minDistanceChars: 'up',
  decoysPerRound: 'up',
  controlsPerRound: 'up',
});

/**
 * Limits and planted-error settings set looser than the defaults: [{ key, value, default }]
 * (planted-error keys as "canaries.<key>"). Each needs limitsOptIn with the owner's words.
 */
export function looserLimits(run) {
  const out = [];
  const scan = (obj, table, defaults, prefix) => {
    const l = isObj(obj) ? obj : {};
    for (const [k, dir] of Object.entries(table)) {
      const v = l[k];
      const d = defaults[k];
      if (typeof v !== 'number' || v === d) continue;
      if ((dir === 'down' && v > d) || (dir === 'up' && v < d)) out.push({ key: prefix + k, value: v, default: d });
    }
  };
  scan(run?.limits, LIMIT_STRICTER, DEFAULT_LIMITS, '');
  for (const [k, ceiling] of Object.entries(SAMPLE_THRESHOLD_CEILING)) {
    const v = run?.limits?.[k];
    if (typeof v === 'number' && v > ceiling) out.push({ key: k, value: v, default: DEFAULT_LIMITS[k] });
  }
  scan(run?.canaries, CANARY_STRICTER, DEFAULT_CANARIES, 'canaries.');
  return out;
}

function ownerWordErrors(w, at, legacy = {}) {
  const errs = [];
  if (!isObj(w)) return [{ path: at, message: "the owner's recorded words are required (approvedBy, quote, date)" }];
  if (w.approvedBy !== ownerLabel()) errs.push({ path: `${at}/approvedBy`, message: `must be "${ownerLabel()}" (env GAUNTLET_OWNER)` });
  // the words as the owner said them (a short answer too), with the question they answer (r3-f21)
  errs.push(...ownerWordsErrors(w, at, legacy));
  if (!isRealDate(w.date)) errs.push({ path: `${at}/date`, message: 'must be a real date YYYY-MM-DD' });
  return errs;
}

// Before freeze the executor writes run.json. A limit looser than the default (more rounds or
// tokens, a later plateau stop, more lens reruns, a smaller per-round estimate) switches a
// protection off, so it needs the owner's recorded words, exactly like a model opt-in.
function limitErrors(run, opts = {}) {
  const loose = looserLimits(run);
  if (!loose.length) return [];
  const errs = ownerWordErrors(run.limitsOptIn, '/limitsOptIn', legacyOf(opts));
  if (!errs.length) return [];
  const list = loose.map((x) => `${x.key}=${x.value} (default ${x.default})`).join(', ');
  return [{ path: '/limits', message: `limits or planted-error settings looser than the defaults need limitsOptIn with the owner's words: ${list}` }, ...errs];
}

/** The repository's bench folder: the only place a fixed (bench) canary key may live. */
export const BENCH_DIR = path.join(REPO_DIR, 'bench');

function insideDir(p, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Bench mode reuses a known key in every round, so it is never an honest review: it needs the
// owner's words and a key file from the repository's bench/ folder (the executor cannot point
// it at a key it wrote). A bench run can never be declared done (done.mjs) and every ledger
// row of it is contaminated (mledger.mjs).
function fixedKeyErrors(run, opts = {}) {
  const fk = run?.canaries?.fixedKey;
  if (!isObj(fk)) return [];
  const errs = ownerWordErrors(fk, '/canaries/fixedKey', legacyOf(opts));
  const benchDir = opts.benchDir ?? BENCH_DIR;
  const env = opts.env ?? process.env;
  // Test mode (GAUNTLET_TEST=1, as for the review-base path rule) lets tests use a temp key;
  // such runs are marked seeded in the report.
  if (typeof fk.path === 'string' && env.GAUNTLET_TEST !== '1' && !insideDir(fk.path, benchDir)) {
    errs.push({ path: '/canaries/fixedKey/path', message: `a fixed canary key must be a file in the repository's bench folder (${benchDir})` });
  }
  return errs;
}

/** validateRun option -> what ownerWordsErrors takes. */
function legacyOf(opts) {
  return { legacyQuestions: opts?.legacyQuestions === true };
}

/** All problems of a run (defaults should already be applied). -> [{ path, message }] */
export function validateRun(run, opts = {}) {
  const errors = [...validate(loadSchema('run'), run).errors];
  if (!isObj(run)) return errors;
  const optIn = run.models?.optIn;
  if (Array.isArray(optIn)) optIn.forEach((e, i) => errors.push(...optInErrors(e, i, legacyOf(opts))));
  const d = run.driver;
  if (isObj(d) && d.mode === 'workflow') {
    const w = d.workflowOptIn;
    if (!isObj(w)) errors.push({ path: '/driver/workflowOptIn', message: 'workflow mode needs the owner\'s recorded opt-in (quote and date)' });
    else {
      errors.push(...ownerWordsErrors(w, '/driver/workflowOptIn', legacyOf(opts)));
      if (!isRealDate(w.date)) errors.push({ path: '/driver/workflowOptIn/date', message: 'must be a real date YYYY-MM-DD' });
    }
  }
  errors.push(...limitErrors(run, opts));
  errors.push(...fixedKeyErrors(run, opts));
  const roots = run.material?.roots;
  if (Array.isArray(roots)) {
    const seen = new Set();
    roots.forEach((r, i) => {
      const key = String(r?.as ?? '').toLowerCase();
      if (seen.has(key)) errors.push({ path: `/material/roots/${i}/as`, message: `duplicate root name "${r?.as}"` });
      seen.add(key);
    });
    const notes = run.material?.authorNotes;
    if (Array.isArray(notes)) {
      notes.forEach((n, i) => {
        const first = String(n).replace(/\\/g, '/').split('/')[0].toLowerCase();
        if (!seen.has(first)) errors.push({ path: `/material/authorNotes/${i}`, message: 'must start with the name ("as") of a material root' });
      });
    }
  }
  return errors;
}

function formatErrors(errors) {
  return errors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n  ');
}

/**
 * run.json with defaults applied. After freeze (FROZEN.json exists) the run is also
 * validated and an invalid run throws UsageError (exit 4).
 */
export function loadRun(runDir, opts = {}) {
  const p = runPaths(runDir);
  if (!exists(p.runJson)) throw new UsageError(`no run.json in ${p.dir}`);
  const run = applyDefaults(readJson(p.runJson));
  if (exists(p.frozen)) {
    const errors = validateRun(run, { legacyQuestions: true, ...opts });
    if (errors.length) throw new UsageError(`run.json is invalid:\n  ${formatErrors(errors)}`, { errors });
  }
  return run;
}

/**
 * The model for a role: the last valid opt-in entry for that role, else null (default
 * Sonnet). Throws UsageError for an unknown role.
 */
export function effectiveModel(run, role) {
  if (!MODEL_ROLES.includes(role)) throw new UsageError(`unknown model role: ${role}`);
  const entries = Array.isArray(run?.models?.optIn) ? run.models.optIn : [];
  let model = null;
  entries.forEach((e, i) => {
    if (!isObj(e) || e.role !== role) return;
    // the opt-in was checked when the run was frozen; an entry from before the question rule still counts
    const errs = optInErrors(e, i, { legacyQuestions: true });
    if (errs.length === 0) model = e.model.trim();
  });
  return model;
}

function readToolInfo(repoDir) {
  let version = null;
  try {
    version = readJson(path.join(repoDir, 'package.json')).version ?? null;
  } catch {
    version = null;
  }
  return { version, gitHead: gitHead(repoDir) };
}

/** HEAD commit of the repository, read from .git without running git; null if unknown. */
export function gitHead(repoDir = REPO_DIR) {
  try {
    const gitDir = path.join(repoDir, '.git');
    let dir = gitDir;
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      dir = path.resolve(repoDir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return null;
    const candidates = [dir];
    const common = path.join(dir, 'commondir');
    if (fs.existsSync(common)) candidates.push(path.resolve(dir, fs.readFileSync(common, 'utf8').trim()));
    for (const d of candidates) {
      const refFile = path.join(d, ...ref.split('/'));
      if (fs.existsSync(refFile)) {
        const v = fs.readFileSync(refFile, 'utf8').trim();
        if (/^[0-9a-f]{40}$/.test(v)) return v;
      }
      const packed = path.join(d, 'packed-refs');
      if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
          const [sha, name] = line.split(' ');
          if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function hashOrNull(p) {
  return exists(p) ? hashFile(p) : null;
}

function hashDir(dir, filter = () => true) {
  const out = {};
  if (!exists(dir)) return out;
  for (const rel of listFiles(dir)) if (filter(rel)) out[rel] = hashFile(path.join(dir, ...rel.split('/')));
  return out;
}

/** The sha256 block of FROZEN.json, computed from the current files. */
export function computeFrozenHashes(runDir, opts = {}) {
  const repoDir = opts.repoDir ?? REPO_DIR;
  const p = runPaths(runDir);
  return {
    ownerTask: hashOrNull(p.ownerTask),
    task: hashOrNull(p.task),
    run: hashOrNull(p.runJson),
    lenses: hashOrNull(p.lenses),
    sources: hashOrNull(p.sources),
    strip: hashOrNull(p.strip),
    mechanical: hashOrNull(p.mechanical),
    templates: hashDir(p.templatesDir),
    taxonomy: hashOrNull(path.join(repoDir, 'taxonomy', 'canary-types.json')),
    catalog: hashDir(path.join(repoDir, 'catalog'), (rel) => !rel.includes('/') && rel.endsWith('.json')),
    fixedKey: fixedKeyHash(p.runJson),
  };
}

// The bench key file is re-read every round, so it is frozen with the rest (null when unset).
function fixedKeyHash(runJsonPath) {
  try {
    const fk = readJson(runJsonPath)?.canaries?.fixedKey;
    return isObj(fk) && typeof fk.path === 'string' ? hashOrNull(fk.path) : null;
  } catch {
    return null;
  }
}

/**
 * instrumentId = hashJson({ reviewer: sha(reviewer.md), severity: sha(severity.md) }): the frozen
 * reviewer instrument, the same for every run that uses these templates. It keys the cross-run
 * recall series (the accepted side note asks to pool 25-50 planted errors across runs). lenses.json
 * is written fresh for every run, so it is a sub-group (lensSetId), never part of the series key;
 * the reviewer model and the artifact type are kept on every ledger row and split in the stats.
 */
export function instrumentIdOf(sha) {
  return hashJson({
    reviewer: sha.templates?.['reviewer.md'] ?? null,
    severity: sha.templates?.['severity.md'] ?? null,
  });
}

const FROZEN_RESERVED = new Set(['schemaVersion', 'frozenAt', 'tool', 'sha256', 'instrumentId', 'lensSetId', 'repoDir']);

/**
 * Freeze: apply defaults to run.json and validate it (UsageError, exit 4, on any
 * problem), rewrite run.json with the effective values, hash every frozen file and
 * write FROZEN.json. extra: { repoDir?, ...fields copied into FROZEN.json }.
 */
export function writeFrozen(runDir, extra = {}, opts = {}) {
  const p = runPaths(runDir);
  const repoDir = extra?.repoDir ?? REPO_DIR;
  if (!exists(p.runJson)) throw new UsageError(`no run.json in ${p.dir}`);
  const run = applyDefaults(readJson(p.runJson));
  const errors = validateRun(run, { legacyQuestions: exists(p.frozen), ...opts });
  if (errors.length) throw new UsageError(`cannot freeze, run.json is invalid:\n  ${formatErrors(errors)}`, { errors });
  writeJsonAtomic(p.runJson, run);
  const sha256 = computeFrozenHashes(runDir, { repoDir });
  const frozen = {
    schemaVersion: 1,
    frozenAt: now(),
    tool: readToolInfo(repoDir),
    sha256,
    instrumentId: instrumentIdOf(sha256),
    lensSetId: sha256.lenses ?? null,
  };
  for (const [k, v] of Object.entries(extra ?? {})) if (!FROZEN_RESERVED.has(k)) frozen[k] = v;
  writeJsonAtomic(p.frozen, frozen);
  return frozen;
}

function diffMaps(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => (a ?? {})[k] !== (b ?? {})[k]).sort();
}

/** Throws IntegrityError('FROZEN_MISMATCH') when any frozen file changed (or FROZEN.json is missing). */
export function assertFrozen(runDir, opts = {}) {
  const p = runPaths(runDir);
  const repoDir = opts.repoDir ?? REPO_DIR;
  if (!exists(p.frozen)) throw new IntegrityError('FROZEN_MISMATCH', `FROZEN.json is missing in ${p.dir}`);
  let frozen;
  try {
    frozen = readJson(p.frozen);
  } catch (e) {
    throw new IntegrityError('FROZEN_MISMATCH', `FROZEN.json is unreadable: ${e.message}`);
  }
  const want = frozen?.sha256;
  if (!isObj(want)) throw new IntegrityError('FROZEN_MISMATCH', 'FROZEN.json has no sha256 block');
  const have = computeFrozenHashes(runDir, { repoDir });
  const mismatches = [];
  for (const k of ['ownerTask', 'task', 'run', 'lenses', 'sources', 'strip', 'mechanical', 'taxonomy', 'fixedKey']) {
    if ((want[k] ?? null) !== have[k]) mismatches.push(k);
  }
  for (const f of diffMaps(want.templates, have.templates)) mismatches.push(`templates/${f}`);
  for (const f of diffMaps(want.catalog, have.catalog)) mismatches.push(`catalog/${f}`);
  if (frozen.instrumentId !== instrumentIdOf(want)) mismatches.push('instrumentId');
  if (mismatches.length) {
    throw new IntegrityError('FROZEN_MISMATCH', `frozen files changed after freeze: ${mismatches.join(', ')}`, { mismatches });
  }
}
