// Builds synthetic run folders for the report tests (P4). Writes only under the given root.
import fs from 'node:fs';
import path from 'node:path';
import { recordEvent, runPaths } from '../../../lib/core/runstore.mjs';
import { appendChained } from '../../../lib/core/chain.mjs';
import { dataPaths } from '../../../lib/core/datahome.mjs';
import { buildManifest } from '../../../lib/material/manifest.mjs';

const w = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n');
};

export const LENSES = [
  { id: 'facts', title: 'Факты и цифры', duty: 'd', procedure: ['a', 'b', 'c'], checklist: ['1', '2', '3', '4', '5'], minimum: [], canaryTypes: ['FACT-NUM'] },
  { id: 'language', title: 'Язык', duty: 'd', procedure: ['a', 'b', 'c'], checklist: ['1', '2', '3', '4', '5'], minimum: [], canaryTypes: ['LANG'] },
  { id: 'generalist', title: 'Первый читатель', duty: 'd', procedure: ['a', 'b', 'c'], checklist: ['1', '2', '3', '4', '5'], minimum: [], canaryTypes: ['BRIEF'] },
];

const OWNER_TASK = 'Сделай контент-план на 12 постов для demo-project.\nКаждый пост ведёт на заявку.\nКрутить до 9,5 из 10 по оценке панели.\nПроверь цены по сайту.\nSource: owner, 2026-10-06, Telegram\n';
const TASK = 'Сделай контент-план на 12 постов для demo-project.\nКаждый пост ведёт на заявку.\nПроверь цены по сайту.\n';

function perLens(ownOutcome = {}, attempts = {}) {
  const out = {};
  for (const l of LENSES) {
    const o = ownOutcome[l.id] ?? 'caught';
    out[l.id] = {
      valid: o === 'caught',
      unreliable: o === 'unreliable',
      guarded: o !== 'unguarded',
      attempts: attempts[l.id] ?? 1,
      invalidReasons: [],
      ownCanary: o === 'unguarded' ? null : { canary: `C${LENSES.indexOf(l) + 1}`, outcome: o === 'unreliable' ? 'missed' : o, severityGiven: 'major', intended: 'major' },
      open: { blocker: 0, major: 0 },
      cosmetic: 0,
      unverified: 0,
      contested: 0,
    };
  }
  return out;
}

function gate(round, kind, decision, open, extra = {}) {
  return {
    schemaVersion: 1,
    round,
    kind,
    versionHash: extra.versionHash ?? `${round}`.repeat(64).slice(0, 64),
    decision,
    reasons: extra.reasons ?? [],
    perLens: extra.perLens ?? perLens(),
    open: { blocker: open[0], major: open[1], unverified: 0, contested: 0, requirements: 0 },
    pendingDisputes: 0,
    history: [],
    plateau: { stagnant: extra.stagnant ?? 0, patience: 2 },
    best: { round: 1, versionHash: 'x', blockers: 0, majors: 0 },
    limits: { rounds: round, maxRounds: 8, confirmsDone: 0, maxConfirms: 2, tokensSpent: 1, nextEstimate: 1, maxPanelTokens: 15000000 },
    band: extra.band ?? null,
    panelCatch: extra.panelCatch ?? { pairsCaught: 7, pairsTotal: 12 },
  };
}

function canariesFor(round, descriptions = {}) {
  const c = LENSES.map((l, i) => ({
    canary: `C${i + 1}`, slot: `S${i + 1}`, purpose: 'attention', targetLens: l.id, type: l.canaryTypes[0], file: 'content/plan.json', locator: `post ${i + 2}`,
    before: 'b', after: 'a', description: descriptions[`C${i + 1}`] ?? `ошибка ${i + 1}`, howProvable: 'h', intendedSeverity: 'major', validatorSeverity: 'major',
    positionFraction: 0.1 * (i + 1), band: 'start', prePlanted: false,
  }));
  c.push({ ...c[0], canary: 'C4', slot: 'S4', purpose: 'measurement', targetLens: 'language', type: 'OMIT-REQ', description: descriptions.C4 ?? 'убран призыв в посте 9' });
  return { schemaVersion: 1, runId: 'x', round, seedHex: 'ab', canaries: c };
}

function detectionsFor(round, own = { facts: 'caught', language: 'caught', generalist: 'caught' }, rerunLens = null) {
  const rows = [];
  const canaries = canariesFor(round).canaries;
  for (const c of canaries) {
    for (const l of LENSES) {
      let outcome = 'missed';
      if (c.purpose === 'attention' && c.targetLens === l.id) outcome = own[l.id] === 'caught' && rerunLens !== l.id ? 'caught' : 'missed';
      else if (c.purpose === 'attention' && c.canary === 'C1') outcome = 'caught';
      rows.push({ canary: c.canary, purpose: c.purpose, targetLens: c.targetLens, lens: l.id, job: `j${l.id.slice(0, 3)}000${round}`.slice(0, 8), attempt: 1, outcome, finding: outcome === 'missed' ? null : 1, stage: outcome === 'missed' ? null : 'code', matcherScore: null, severityGiven: outcome === 'missed' ? null : 'major' });
    }
  }
  if (rerunLens) {
    for (const c of canaries.filter((x) => x.targetLens === rerunLens && x.purpose === 'attention')) {
      rows.push({ canary: c.canary, purpose: c.purpose, targetLens: c.targetLens, lens: rerunLens, job: 'rerun001', attempt: 2, outcome: 'caught', finding: 2, stage: 'code', matcherScore: null, severityGiven: 'major' });
    }
  }
  return { schemaVersion: 1, round, detections: rows };
}

function reviewerAnswers(R, round, opts = {}) {
  const jobs = [];
  for (const l of LENSES) {
    const job = `j${l.id.slice(0, 3)}000${round}`.slice(0, 8);
    jobs.push({ job, role: 'reviewer', lens: l.id, attempt: 1, dir: 'x', promptSha256: 'y', schemaName: 'answer-reviewer', model: null, nonce: 'PL-AAAA-BBBB', status: 'answered' });
    w(path.join(R.answers, `${job}.json`), {
      schemaVersion: 1,
      nonce: 'PL-AAAA-BBBB',
      receipt: [],
      inspected: [{ minimumId: 'M1', done: l.id !== 'language' || !opts.notDone, how: opts.notDone && l.id === 'language' ? 'не успел открыть все слайды' : 'прочитал все 12 постов' }],
      sourceChecks: [],
      requirements: [],
      findings: [],
      notVerified: opts.notVerified && l.id === 'facts' ? [{ claim: 'цена доставки 600 € на сайте', whereLooked: 'curl https://demo-project/prices' }] : [],
      notChecked: opts.notChecked && l.id === 'generalist' ? [{ what: 'видео в посте 11', why: 'файл не открывается' }] : [],
    });
  }
  w(R.jobs, { schemaVersion: 1, round, jobs });
}

/**
 * makeRun(root, dataHome, variant) -> runDir
 * variants: 'done' | 'plateau' | 'edited' | 'new'
 */
export function makeRun(root, dataHome, variant = 'done', opts = {}) {
  const runId = `20260115-0930-${{ done: 'aaaaaa', plateau: 'bbbbbb', edited: 'cccccc', new: 'dddddd' }[variant]}`;
  const runDir = path.join(root, 'gauntlet-runs', runId);
  const P = runPaths(runDir);
  const dp = dataPaths(dataHome);
  const ev = (type, data, round = null) => recordEvent(runDir, type, data, round, { dataPaths: dp });
  w(P.runJson, {
    schemaVersion: 1, runId, project: 'demo', artifactType: 'marketing-plan', createdAt: '2026-10-06T09:30:00.000+03:00',
    projectDir: root, reviewBase: path.join(root, 'wc'), reportDir: path.join(root, 'reports'),
    language: { answers: 'ru', report: 'ru' }, ownerTarget: variant === 'done' ? '9,5' : null,
    material: { roots: [{ path: path.join(root, 'material'), as: 'content', include: ['**/*'] }] },
    limits: { maxRounds: 8, maxConfirms: 2, maxPanelTokens: 15000000, plateauRounds: 2, maxLensReruns: 1, verifierBatchMax: 8, roundTokenEstimate: 1800000 },
    canaries: {}, generalist: true, models: { optIn: opts.optIn ?? [] }, driver: { mode: 'agent' }, allowExecutables: ['node'],
  });
  ev('init', { runId });
  // A real material folder: the report hashes the live files again before it prints «Готово».
  w(path.join(root, 'material', 'plan.json'), { posts: 12 });
  const liveHash = buildManifest(JSON.parse(fs.readFileSync(P.runJson, 'utf8')), { countsFor: [] }).versionHash;
  if (variant === 'new') {
    w(P.state, { schemaVersion: 1, state: 'NEW', round: null });
    return runDir;
  }
  w(P.ownerTask, OWNER_TASK);
  w(P.task, opts.task ?? TASK);
  ev('task-set', { cut: [3] });
  w(P.lenses, { schemaVersion: 1, taskSha256: 'x', requirements: [], lenses: opts.lenses ?? LENSES });
  w(P.frozen, { schemaVersion: 1, frozenAt: 'x', tool: { version: '0.1.0', gitHead: null }, sha256: {}, instrumentId: 'inst-report' });
  ev('freeze', {});

  const usage = (round, tokens, estimated) => appendChained(P.usage, { job: `j${round}`, role: 'reviewer', round, tokens, estimated, source: estimated ? 'estimate' : 'agent-usage' });

  // round 1: working, FIX, rerun of the language lens
  let R = P.roundDir(1);
  w(R.roundJson, { schemaVersion: 1, round: 1, kind: 'working', seeded: Boolean(opts.seeded) });
  w(R.canaries, canariesFor(1));
  w(R.detections, detectionsFor(1, undefined, 'language'));
  reviewerAnswers(R, 1);
  w(R.gate, gate(1, 'working', 'FIX', [1, 2], { perLens: perLens({}, { language: 2 }) }));
  ev('gate', { decision: 'FIX' }, 1);
  usage(1, 1200000, false);
  if (opts.suspectUsage) appendChained(P.usage, { job: null, role: 'workflow', round: 1, tokens: 5000000, estimated: false, source: 'workflow-budget', suspect: true });

  const clusters = [
    { id: 'C-01-01', origin: 'finding', file: 'content/plan.json', locator: 'пост 4', quote: '= 21,30 €', problem: 'Сумма не сходится: должно быть 20,30 €.', members: [{ round: 1, lens: 'facts', job: 'a', n: 1, severity: 'blocker' }], claimedSeverity: 'blocker', grounded: true, status: 'closed', severity: null, verifiedOn: 'x', evidence: [{ round: 1, job: 'v', verdict: 'confirmed', severity: 'blocker', evidence: 'сложил строки: 10 190' }], history: [] },
    { id: 'C-01-02', origin: 'finding', file: 'content/page.md', locator: 'FAQ', quote: 'без обязательств', problem: 'Этого нет на сайте.', members: [{ round: 1, lens: 'language', job: 'b', n: 1, severity: 'major' }], claimedSeverity: 'major', grounded: true, status: 'dropped', severity: null, verifiedOn: 'x', evidence: [{ round: 1, job: 'v', verdict: 'refuted', severity: null, evidence: 'есть в форме подбора' }], history: [] },
    { id: 'C-01-03', origin: 'finding', file: 'content/plan.json', locator: 'пост 7', quote: 'без сюрпризов', problem: 'Похоже на гарантию.', members: [{ round: 1, lens: 'generalist', job: 'c', n: 2, severity: 'major' }], claimedSeverity: 'major', grounded: true, status: 'waived', severity: 'major', verifiedOn: 'x', evidence: [{ round: 1, job: 'v', verdict: 'confirmed', severity: 'major', evidence: 'правило плана запрещает гарантии' }], history: [] },
    { id: 'C-01-04', origin: 'finding', file: 'content/plan.json', locator: 'пост 2', quote: 'Rye  loaf', problem: 'Лишний пробел.', members: [{ round: 1, lens: 'language', job: 'b', n: 3, severity: 'cosmetic' }], claimedSeverity: 'cosmetic', grounded: true, status: 'cosmetic', severity: 'cosmetic', verifiedOn: 'x', evidence: [], history: [] },
  ];
  const decisions = opts.decisions ?? [{ id: 'O1', ts: '2026-10-06T11:00:00.000+03:00', kind: 'waive', clusters: ['C-01-03'], quote: opts.ownerQuote ?? 'это не гарантия, так и оставь, пост 7 ок', question: 'Пост 7 похож на гарантию. Оставить как есть?' }];

  if (variant === 'plateau') {
    for (const n of [2, 3]) {
      R = P.roundDir(n);
      w(R.roundJson, { schemaVersion: 1, round: n, kind: 'working' });
      w(R.canaries, canariesFor(n, { C2: 'падеж в посте 8' }));
      w(R.detections, detectionsFor(n, { facts: 'caught', language: 'missed', generalist: 'caught' }));
      reviewerAnswers(R, n, { notChecked: true, notVerified: true, notDone: true });
      w(R.sourcesCheck, [{ id: 'S1', ok: false, error: 'timeout после 30 с' }]);
      w(R.gate, gate(n, 'working', n === 3 ? 'STOP_PLATEAU' : 'FIX', [1, 2], { stagnant: n - 1, perLens: perLens({ language: 'missed' }), panelCatch: { pairsCaught: 4, pairsTotal: 12 } }));
      ev('gate', { decision: n === 3 ? 'STOP_PLATEAU' : 'FIX' }, n);
      usage(n, 1500000, n === 3);
    }
    clusters[0].status = 'open';
    clusters[0].severity = 'blocker';
    clusters.push({ id: 'C-02-01', origin: 'finding', file: 'content/plan.json', locator: 'пост 9', quote: 'доставка бесплатно', problem: 'Неясно, бесплатна ли доставка.', members: [{ round: 2, lens: 'facts', job: 'a', n: 4, severity: 'major' }], claimedSeverity: 'major', grounded: true, status: 'contested', severity: 'major', verifiedOn: 'x', evidence: [{ round: 2, job: 'v1', verdict: 'confirmed', severity: 'major', evidence: 'закон' }, { round: 2, job: 'v2', verdict: 'refuted', severity: null, evidence: 'на сайте иначе' }], history: [] });
    clusters.push({ id: 'C-03-01', origin: 'requirement', requirementId: 'R02', file: 'content/plan.json', locator: 'все посты', quote: null, problem: 'Не у всех постов есть призыв.', members: [], claimedSeverity: 'major', grounded: false, status: 'unverified', severity: 'major', verifiedOn: 'x', evidence: [{ round: 3, job: 'v', verdict: 'unverifiable', severity: null, evidence: 'не смог открыть план' }], history: [] });
    w(P.state, { schemaVersion: 1, state: 'STOPPED', round: 3, lastDecision: 'STOP_PLATEAU', best: { round: 1, versionHash: 'x', blockers: 1, majors: 2 } });
    w(P.best, { round: 1, versionHash: 'x', blockers: 1, majors: 2 });
  } else {
    R = P.roundDir(2);
    w(R.roundJson, { schemaVersion: 1, round: 2, kind: 'working' });
    w(R.canaries, canariesFor(2));
    w(R.detections, detectionsFor(2));
    reviewerAnswers(R, 2);
    w(R.gate, gate(2, 'working', 'CONFIRM', [0, 0], { versionHash: 'f'.repeat(64) }));
    ev('gate', { decision: 'CONFIRM' }, 2);
    usage(2, 1700000, false);
    R = P.roundDir(3);
    w(R.roundJson, { schemaVersion: 1, round: 3, kind: 'confirm', seeded: Boolean(opts.seeded) });
    w(R.canaries, canariesFor(3, { C4: 'убран призыв «Пишите LOAF» в посте 9' }));
    w(R.detections, detectionsFor(3));
    reviewerAnswers(R, 3);
    w(R.gate, gate(3, 'confirm', 'DONE', [0, 0], { versionHash: 'f'.repeat(64), band: { perLens: { facts: [9.8, 10], language: [9.0, 9.7], generalist: [9.8, 10] }, worst: [9.0, 9.7] } }));
    ev('gate', { decision: 'DONE' }, 3);
    usage(3, 1900000, false);
    w(P.best, { round: 2, versionHash: 'f'.repeat(64), blockers: 0, majors: 0 });
    if (variant === 'done') {
      w(P.done, { runId, round: 3, reviewedVersionHash: liveHash, finalVersionHash: liveHash, equal: true, gateSha256: 'x', at: '2026-10-06T15:00:00.000+03:00' });
      ev('done', { equal: true });
      w(P.state, { schemaVersion: 1, state: 'DONE', round: 3, lastDecision: 'DONE' });
    } else {
      ev('done', { equal: false, changed: ['content/plan.json'] });
      w(P.state, { schemaVersion: 1, state: 'STOPPED', round: 3, lastDecision: 'DONE' });
    }
  }
  w(P.clusters, { schemaVersion: 1, clusters });
  w(P.ownerDecisions, { schemaVersion: 1, decisions });
  w(P.audit, { ok: true, checks: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `check-${i}`, ok: true, details: '' })) });
  return runDir;
}
