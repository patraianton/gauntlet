// `init` (SPEC 10.2): create the run folder, run.json with defaults, a copy of the repository
// templates (a repository change mid-run changes nothing), the first ledger event and a
// runs-index line. Refuses a run folder outside the run roots (GAUNTLET_RUN_ROOTS), an existing folder, and a
// second unfinished run on overlapping roots, whatever its project name (unless --supersede, which
// needs the owner's words). Every earlier run on overlapping roots (any status, any project) is looked
// up and its open verified problems are recorded in the init event: SETUP-SUMMARY, the report and
// the summary show them, so a new run never silently drops what an earlier one found (r2-f4).

import fs from 'node:fs';
import { ownerWords } from '../core/owner.mjs';
import path from 'node:path';
import os from 'node:os';
import { UsageError, IntegrityError } from '../core/errors.mjs';
import { writeJsonAtomic, exists, listFiles, copyFiles, readJson } from '../core/fsx.mjs';
import { hashFile, sha256Hex } from '../core/hash.mjs';
import { repoTemplates, findApproval } from './cmd-templates.mjs';
import { readChained, appendChained } from '../core/chain.mjs';
import { normalizeInput, assertAllowedRunDir, isUnder, runRoots, runRootOf } from '../core/paths.mjs';
import { applyDefaults } from '../core/config.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { dataHome as resolveDataHome } from '../core/datahome.mjs';
import { now, runStamp } from '../core/clock.mjs';
import { makeRng } from '../core/rand.mjs';
import { recordEvent, writeState } from '../core/runstore.mjs';
import { dataPaths as defaultDataPaths } from '../core/datahome.mjs';
import { parseArgv, initialState, rootsKey, openRun, commitState, runLeftovers } from './state.mjs';

export const ARTIFACT_TYPES = Object.freeze(['marketing-plan', 'copy', 'slides', 'report', 'code', 'other']);
const AS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Default project working folder: <first run root>/<project>. */
function defaultProjectDir(project) {
  return path.join(runRoots().roots[0], project);
}

/**
 * Default review base: <run root>/_wc — a folder of its own, not next to the run
 * folders (gauntlet-runs), the reports or the data home, so a reviewer one or two folders up finds no
 * answers and no keys (D26). Without a run root above the project folder (tests, `--project-dir`
 * elsewhere): a _wc folder beside the project folder.
 */
export function defaultReviewBase(projectDir) {
  const root = runRootOf(projectDir);
  if (root) return path.join(root, '_wc');
  return path.join(path.dirname(path.resolve(projectDir)), '_wc');
}

function parseRoot(spec, i) {
  const s = String(spec);
  const eq = s.lastIndexOf('=');
  let p = s;
  let as = null;
  if (eq > 0 && AS_RE.test(s.slice(eq + 1))) {
    p = s.slice(0, eq);
    as = s.slice(eq + 1);
  }
  const abs = normalizeInput(p);
  if (!exists(abs) || !fs.statSync(abs).isDirectory()) throw new UsageError(`--root ${abs} is not an existing folder`);
  return { path: abs, as: as || (i === 0 ? 'content' : `content-${i + 1}`) };
}

/** Latest runs-index line per runId (the material file hashes of its first line are kept). */
export function latestIndex(dp) {
  const latest = new Map();
  for (const l of readChained(dp.runsIndex)) {
    const prev = latest.get(l.runId);
    latest.set(l.runId, { ...l, fileHashes: l.fileHashes ?? prev?.fileHashes ?? null });
  }
  return [...latest.values()];
}

function overlaps(keyA, keyB) {
  const a = String(keyA || '').split('|').filter(Boolean);
  const b = String(keyB || '').split('|').filter(Boolean);
  return a.some((x) => b.some((y) => isUnder(x, y) || isUnder(y, x)));
}

/** At most this many material file hashes are kept per run in the runs index. */
export const MAX_INDEX_HASHES = 5000;

/** Short content hashes of the material files (sorted, unique, capped). */
export function materialHashes(run) {
  try {
    const m = buildManifest(run, { countsFor: [] });
    return [...new Set(m.files.map((f) => String(f.sha256).slice(0, 16)))].sort().slice(0, MAX_INDEX_HASHES);
  } catch {
    return [];
  }
}

/**
 * Same material by content (r3-f8): most (more than half) of the smaller set of file hashes is
 * shared. A copy of the material in another folder still matches.
 */
export function contentOverlaps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  const B = new Set(b);
  const shared = a.filter((h) => B.has(h)).length;
  return shared * 2 > Math.min(a.length, b.length);
}

export async function run(argv, ctx) {
  const { opts } = parseArgv(argv, {
    options: ['project', 'artifact-type', 'project-dir', 'run-dir', 'supersede', 'reason', 'answers-lang', 'owner-quote', 'question'],
    multi: ['root', 'include', 'exclude', 'notes'],
  });
  const project = opts.project;
  if (!project || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)) throw new UsageError('--project <name> is required (letters, digits, . _ -)');
  const artifactType = opts.artifactType;
  if (!ARTIFACT_TYPES.includes(artifactType)) throw new UsageError(`--artifact-type must be one of ${ARTIFACT_TYPES.join(', ')}`);
  if (!opts.root.length) throw new UsageError('at least one --root <abs>[=<as>] is required');
  const roots = opts.root.map(parseRoot);
  const asSeen = new Set();
  for (const r of roots) {
    if (asSeen.has(r.as)) throw new UsageError(`two roots share the name "${r.as}"; give each --root a different =<as>`);
    asSeen.add(r.as);
  }
  const include = opts.include.length ? opts.include : ['**/*'];
  const exclude = opts.exclude;
  if (opts.answersLang && !['ru', 'lv', 'en'].includes(opts.answersLang)) throw new UsageError('--answers-lang must be ru, lv or en');
  if (opts.supersede && !opts.reason) throw new UsageError('--supersede needs --reason <text>');
  if (opts.supersede && !opts.ownerQuote) throw new UsageError("--supersede replaces an unfinished run and needs --owner-quote with the owner's words and --question with the exact question you asked the owner");
  const words = ownerWords(opts.ownerQuote, opts.question, { required: false });
  const quote = words?.quote ?? null;

  const dp = ctx.dataPaths ?? defaultDataPaths(ctx.dataHome);
  const projectDir = opts.projectDir ? normalizeInput(opts.projectDir) : defaultProjectDir(project);
  const rng = makeRng();
  const runId = `${runStamp()}-${rng.bytes(3).toString('hex')}`;
  const runDir = assertAllowedRunDir(opts.runDir ? normalizeInput(opts.runDir) : path.join(projectDir, 'gauntlet-runs', runId));
  if (exists(runDir)) throw new UsageError(`the run folder already exists: ${runDir}`);

  const material = { roots: roots.map((r) => ({ path: r.path, as: r.as, include, ...(exclude.length ? { exclude } : {}) })) };
  if (opts.notes.length) material.authorNotes = opts.notes.map((n) => String(n).replace(/\\/g, '/'));
  const draft = {
    schemaVersion: 1,
    runId,
    project,
    artifactType,
    createdAt: now(),
    projectDir,
    reviewBase: defaultReviewBase(projectDir),
    reportDir: path.join(projectDir, 'reports'),
    language: { answers: opts.answersLang || 'ru', report: 'ru' },
    ownerTarget: null,
    material,
    rebuild: null,
  };
  const key = rootsKey(draft);
  const fileHashes = materialHashes(draft);
  const same = (l) => overlaps(l.rootsKey, key) || contentOverlaps(l.fileHashes, fileHashes);

  // A second unfinished run on overlapping roots is refused whatever its project name (cheater 12).
  const index = latestIndex(dp);
  const clash = index.filter((l) => !['DONE', 'ABORTED'].includes(l.status) && same(l));
  // Every earlier run on these roots, finished or not: what it left open is carried into this run's record.
  const earlierRuns = index
    .filter((l) => same(l))
    .map((l) => {
      const left = runLeftovers(l.runDir);
      return { runId: l.runId, project: l.project, runDir: l.runDir, status: left.state ?? l.status, lastDecision: left.lastDecision, openSerious: left.openSerious, readable: left.readable };
    });
  let superseded = null;
  if (clash.length) {
    if (!opts.supersede) {
      throw new UsageError(
        `an unfinished run on the same material (same folders, or mostly the same file contents) exists: ${clash.map((c) => `${c.runId} (${c.status}) ${c.runDir}`).join('; ')}. ` +
          'Finish or abort it (on the owner\'s words), or start this run with --supersede <runId> --reason <text> --owner-quote "<the owner\'s words>" --question "<the exact question you asked the owner>".',
      );
    }
    superseded = clash.find((c) => c.runId === opts.supersede);
    if (!superseded) throw new UsageError(`--supersede ${opts.supersede} does not name the clashing run (${clash.map((c) => c.runId).join(', ')})`);
    if (clash.length > 1) throw new UsageError(`more than one unfinished run clashes: ${clash.map((c) => c.runId).join(', ')}; abort the others first`);
  }
  if (superseded || opts.supersede) draft.supersedes = [{ runId: opts.supersede, reason: opts.reason, ownerQuote: quote, ...(words?.question ? { question: words.question } : {}) }];

  // The repository templates must equal their MANIFEST before they are copied and frozen: a
  // template weakened in the repository would otherwise be frozen and pass every later hash check (r2-f12).
  const tplSrc = path.join(ctx.repoDir, 'templates');
  let manifestSha256 = null;
  let templatesApproval = null;
  if (exists(tplSrc)) {
    const cur = repoTemplates(ctx.repoDir);
    manifestSha256 = cur.manifestSha256;
    // MANIFEST.json can be regenerated by anyone who edits a template, so a version is usable only
    // with the owner's approval recorded in the data home, outside the repository (r3-f6).
    const a = findApproval(dp, manifestSha256);
    if (!a) {
      throw new UsageError(
        `the reviewer templates version ${cur.version} (${manifestSha256.slice(0, 12)}) are not approved by the owner. Show the owner what changed in templates/ (git log -p templates/) and, only on the owner's words, run: templates approve --owner-quote "<the owner's words>" --question "<the exact question you asked the owner>". Then init again.`,
      );
    }
    templatesApproval = { version: a.version, date: a.date, quote: a.quote };
  }
  const run = applyDefaults(draft);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'run.json'), run);
  const tplDst = path.join(runDir, 'templates');
  const files = exists(tplSrc) ? listFiles(tplSrc) : [];
  copyFiles(tplSrc, files, tplDst);
  const templates = {};
  for (const f of files) templates[f] = hashFile(path.join(tplDst, ...f.split('/')));
  let manifestVersion = null;
  try {
    manifestVersion = readJson(path.join(tplSrc, 'MANIFEST.json')).version ?? null;
  } catch {
    manifestVersion = null;
  }
  // Another data home has its own runs index: earlier runs recorded elsewhere are invisible here (r3-f8).
  const defaultHome = resolveDataHome({ env: {}, create: false });
  const nonDefaultHome = process.env.GAUNTLET_TEST !== '1' && path.resolve(dp.root).toLowerCase() !== path.resolve(defaultHome).toLowerCase();
  const state = initialState();
  writeState(runDir, state);
  recordEvent(runDir, 'init', { runDir, project, artifactType, roots: run.material.roots, templates, templatesManifestVersion: manifestVersion, templatesManifestSha256: manifestSha256, templatesApproval, dataHome: { path: dp.root, nonDefault: nonDefaultHome }, stateAfter: state, supersedes: run.supersedes || [], earlierRuns }, null, { dataPaths: dp, runId });
  appendChained(dp.runsIndex, { runId, project, rootsKey: key, status: 'NEW', runDir, fileHashes });

  if (superseded) {
    try {
      const orc = openRun(superseded.runDir, ctx, {});
      commitState(orc, { state: 'ABORTED', stoppedReason: `superseded by ${runId}: ${opts.reason}` }, 'supersede', { by: runId, reason: opts.reason, ownerQuote: quote });
    } catch (e) {
      appendChained(dp.runsIndex, { runId: superseded.runId, project, rootsKey: superseded.rootsKey, status: 'ABORTED', runDir: superseded.runDir, note: `superseded by ${runId}; old run folder could not be updated: ${e.message}` });
    }
  }

  const carried = earlierRuns.filter((e) => e.openSerious.length);
  const text = [
    `Run created: ${runDir}`,
    ...(nonDefaultHome ? [`WARNING: the data home is ${dp.root}, not the default ${defaultHome}; earlier runs recorded in another data home are not checked. The report says so.`] : []),
    ...(earlierRuns.length ? [`Earlier runs on this material: ${earlierRuns.map((e) => `${e.runId} (${e.status}${e.openSerious.length ? `, ${e.openSerious.length} open verified problem(s)` : ''})`).join('; ')}. The setup summary and the report list them.`] : []),
    ...(carried.length ? ['Fix or answer those problems in this run: they are shown to the owner next to its result.'] : []),
    `runId ${runId}; material roots: ${roots.map((r) => `${r.as} = ${r.path}`).join('; ')}`,
    '',
    'Next, in this order:',
    `1. Save the owner's words verbatim to a file and run: task set "${runDir}" --from <file> [--cut <lines>] --source "<who, date, where>"`,
    `2. Write sources.json (recipes you have run), strip.json and mechanical.json in the run folder; adjust run.json if needed (before the first step).`,
    `3. Run: step "${runDir}"`,
    '',
    `NEXT: task set "${runDir}" --from <file>`,
  ].join('\n');
  return { exitCode: 0, state: 'NEW', payload: { runDir, runId, state: 'NEW' }, text };
}
