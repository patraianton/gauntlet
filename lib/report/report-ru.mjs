// The owner report REPORT.ru.md (SPEC 16) and the five-line summary (16.3).
//
// Built only from run files (run.json, state, ledger, rounds/*, clusters, decisions,
// usage, DONE, AUDIT) and, for section 9, the measurement ledger. Our own sentences come
// from phrases.ru.json; every text written by someone else (owner task, quotes,
// reviewers' and verifiers' words, owner quotes) goes into ">" quotation lines.
// The band appears only for confirm rounds. No average is computed anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readText } from '../core/fsx.mjs';
import { readChained } from '../core/chain.mjs';
import { runPaths } from '../core/runstore.mjs';
import { clopperPearson } from '../measure/stats.mjs';
import { statsForRun } from '../measure/recall.mjs';
import { summariseResults } from '../measure/decoys.mjs';
import { summariseControls } from '../measure/controls.mjs';
import { lintReportText } from './report-lint.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { looserLimits } from '../core/config.mjs';
import { quoteArg, sizeRu } from '../engine/setup.mjs';
import { summariseSourceAttempts, sourceMinimumRescue } from '../engine/ingest.mjs';
import { callFor } from '../material/jobs.mjs';
import { loadTaxonomy } from '../measure/taxonomy.mjs';
import { quoteFlags } from '../core/owner.mjs';
import { realRoundNumbers, roundLabelRu, isAttemptDecision, folderPart } from '../core/roundnum.mjs';
import { readRows } from '../measure/mledger.mjs';
import { tamperLinesRu, scratchLineRu } from '../engine/copy-tamper.mjs';

const PHRASES_PATH = fileURLToPath(new URL('./phrases.ru.json', import.meta.url));
let phrasesCache = null;

export function loadPhrases() {
  if (!phrasesCache) phrasesCache = readJson(PHRASES_PATH);
  return phrasesCache;
}

// ------------------------------------------------------------------ formatting

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Fill {X} and {X|one|few|many} placeholders. Unknown placeholders throw (a bug). */
export function fill(template, values = {}) {
  return String(template).replace(/\{([A-Z_]+)(?:\|([^|}]*)\|([^|}]*)\|([^|}]*))?\}/g, (m, name, one, few, many) => {
    if (!(name in values)) throw new Error(`report phrase placeholder {${name}} has no value`);
    const v = values[name];
    if (one !== undefined) return `${v} ${plural(Number(v), one, few, many)}`;
    return String(v);
  });
}

function decimalRu(x) {
  const r = Math.round(x * 10) / 10;
  return (r === 10 ? '10' : r.toFixed(1)).replace('.', ',');
}

function pct(x) {
  return String(Math.round(x * 100));
}

function quoteLines(text, prefix = '') {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!t) return [];
  return t.split('\n').map((l) => `> ${prefix}${l}`.trimEnd());
}

/** Hide any part of an external string that the report lint would flag in our own lines. */
function lintSafe(s, keep = []) {
  let t = String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  for (let i = 0; i < 5; i++) {
    const hits = lintReportText(t).filter((h) => !keep.includes(h.patternId));
    if (!hits.length) break;
    for (const h of hits) t = t.split(h.text).join('…');
  }
  return t;
}

function inline(s) {
  // External short strings (lens titles, locators) printed in our own lines.
  return `«${lintSafe(s).replace(/[«»]/g, '"')}»`;
}

function code(s) {
  return '`' + lintSafe(s).replace(/`/g, "'") + '`';
}

function tokensRu(n) {
  if (n >= 1e6) return `${decimalRu(n / 1e6)} млн`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс.`;
  return String(n);
}

function durationRu(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return `${h} ч ${min % 60} мин`;
}

function dateRu(ts) {
  if (!ts) return 'дата неизвестна';
  return String(ts).replace('T', ' ').slice(0, 16);
}

// ------------------------------------------------------------------ loading

function readJsonOr(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return readJson(p);
  } catch {
    return fallback;
  }
}

function readTextOr(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return readText(p);
  } catch {
    return fallback;
  }
}

function readChainOr(p) {
  try {
    if (!fs.existsSync(p)) return [];
    return readChained(p);
  } catch {
    return [];
  }
}

function listJson(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ name: f.slice(0, -5), value: readJsonOr(path.join(dir, f), null) }))
      .filter((x) => x.value);
  } catch {
    return [];
  }
}

/** Everything the report reads, from run files only. */
export function loadRunFiles(runDir) {
  const P = runPaths(runDir);
  const ledger = readChainOr(P.ledger);
  const rounds = [];
  let names = [];
  try {
    names = fs.readdirSync(P.roundsDir).filter((n) => /^\d+$/.test(n));
  } catch {
    names = [];
  }
  for (const name of names.sort((a, b) => Number(a) - Number(b))) {
    const n = Number(name);
    if (!Number.isInteger(n) || n < 1) continue;
    const R = P.roundDir(n);
    const jobs = readJsonOr(R.jobs, { jobs: [] }).jobs ?? [];
    const answers = listJson(R.answers);
    const gateEvent = [...ledger].reverse().find((e) => e.type === 'gate' && e.round === n);
    rounds.push({
      n,
      round: readJsonOr(R.roundJson, {}),
      gate: readJsonOr(R.gate, null),
      detections: readJsonOr(R.detections, null)?.detections ?? null,
      canaries: readJsonOr(R.canaries, null)?.canaries ?? null,
      // false findings mixed into the verifiers' batches (revealed when the round closed)
      decoyKey: readJsonOr(path.join(R.dir, 'decoys.json'), null),
      decoyResults: readJsonOr(path.join(R.dir, 'decoy-results.json'), null),
      // real planted defects mixed into the verifiers' batches (revealed when the round closed)
      controlKey: readJsonOr(path.join(R.dir, 'controls.json'), null),
      controlResults: readJsonOr(path.join(R.dir, 'control-results.json'), null),
      sourcesCheck: readJsonOr(R.sourcesCheck, null),
      copy: readJsonOr(R.copy, null),
      // which files changed in the copy while reviewers worked (INVALID_ROUND), when the engine could tell
      tamper: readJsonOr(R.copyTamper, null),
      sample: readJsonOr(path.join(R.dir, 'sample.json'), null),
      jobs,
      answers,
      gateTs: gateEvent?.ts ?? null,
    });
  }
  // Real round numbers for the owner (bug 14): a BLOCKED_* attempt holds a folder number but is no round.
  const realMap = realRoundNumbers(rounds.map((r) => ({ n: r.n, blocked: !!r.gate && isAttemptDecision(r.gate.decision) })));
  for (const r of rounds) r.real = realMap.get(r.n) ?? null;
  const run = readJsonOr(P.runJson, {});
  const done = readJsonOr(P.done, null);
  // «Готово» is never printed from DONE.json alone: the live material is hashed again on every
  // render, so an edit after done turns the headline into «edited» (failure point 15).
  let liveVersionHash = null;
  if (done) {
    try {
      liveVersionHash = buildManifest(run, { countsFor: [] }).versionHash;
    } catch {
      liveVersionHash = null;
    }
  }
  return {
    P,
    run,
    liveVersionHash,
    realMap,
    state: readJsonOr(P.state, null),
    frozen: readJsonOr(P.frozen, null),
    lenses: readJsonOr(P.lenses, null),
    ownerTask: readTextOr(P.ownerTask, null),
    task: readTextOr(P.task, null),
    clusters: readJsonOr(P.clusters, { clusters: [] }).clusters ?? [],
    decisions: readJsonOr(P.ownerDecisions, { decisions: [] }).decisions ?? [],
    best: readJsonOr(P.best, null),
    done,
    auditFile: readJsonOr(P.audit, null),
    usage: readChainOr(P.usage),
    comment: readTextOr(path.join(P.dir, 'REPORT-COMMENT.md'), null),
    sources: readJsonOr(P.sources, { sources: [] }).sources ?? [],
    stripPreview: readJsonOr(P.stripPreview, null),
    disputes: readJsonOr(P.disputes, { disputes: [] }).disputes ?? [],
    ledger,
    rounds,
  };
}

// ------------------------------------------------------------------ derived facts

// A BLOCKED_* attempt never reached the reviewers: it holds a folder number but is not a round. It is
// left out of every count, of the open problems, of the best version and of the last reviewed round.
const isBlocked = (r) => !!r.gate && ['BLOCKED_PRECHECK', 'BLOCKED_TRACE'].includes(r.gate.decision);
const GATED = (r) => r.gate && !isBlocked(r);

function lastGateRound(f) {
  return [...f.rounds].reverse().find(GATED) ?? null;
}

/** The round as the owner reads it: «3» or «3 (папка 04)» when the folder number differs (bug 14). */
function RL(f, n) {
  return roundLabelRu(n, f.realMap);
}

function folderName(n) {
  return 'rounds\\' + String(n).padStart(2, '0');
}

/**
 * Russian words for the reasons the gate recorded for a rejected answer (`answer: <reason>`).
 * Unknown reasons are printed as the program wrote them, in a quotation mark pair.
 */
function answerReasonsRu(reasons, ph) {
  const R = ph.canaries.reasons;
  const out = [];
  for (const raw of reasons ?? []) {
    const x = String(raw).replace(/^answer:\s*/, '');
    let t;
    if (x === 'missing') t = R.missing;
    else if (x === 'talks about the check itself') t = R.meta;
    else if (x === 'schema-invalid') t = R.schema;
    else if (x === 'nonce-mismatch') t = R.nonce;
    else if (x === 'prompt-edited') t = R.prompt;
    else if (x === 'answer-hash-mismatch') t = R.hash;
    else if (/^receipts/.test(x)) t = R.receipts;
    else if (/^minimum not recorded/.test(x)) t = R.minRecorded;
    else if (/^minimum not done/.test(x)) t = R.minDone;
    else if (/^requirements not marked/.test(x)) t = R.requirements;
    else t = `${R.other}: «${lintSafe(x).replace(/[«»]/g, '"')}»`;
    if (!out.includes(t)) out.push(t);
  }
  return out.length ? out.join('; ') : R.other;
}

function lensTitle(f, id) {
  const l = (f.lenses?.lenses ?? []).find((x) => x.id === id);
  return l?.title || id || 'без названия';
}

function doneEvent(f) {
  return [...f.ledger].reverse().find((e) => e.type === 'done') ?? null;
}

function changedFiles(f) {
  const ev = doneEvent(f);
  const d = ev?.data ?? {};
  const list = d.changed ?? d.changedFiles ?? f.done?.changedFiles ?? null;
  return Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.rel ?? JSON.stringify(x))) : null;
}

/** 'done' | 'edited' | 'awaitingDone' | 'aborted' | 'stopped' | 'inProgress' */
export function runOutcome(f) {
  const st = f.state?.state ?? null;
  if (st === 'ABORTED') return { kind: 'aborted', why: f.state?.stoppedReason ?? null };
  const ev = doneEvent(f);
  // The newest done event wins over DONE.json; then the live files are compared again.
  if ((f.done && f.done.equal === false) || ev?.data?.equal === false) return { kind: 'edited' };
  if (f.done && f.done.equal === true) {
    if (f.liveVersionHash && f.liveVersionHash === f.done.finalVersionHash) return { kind: 'done' };
    return { kind: 'edited', live: true };
  }
  const last = lastGateRound(f);
  const decision = f.state?.lastDecision ?? last?.gate?.decision ?? null;
  if (decision === 'DONE') return { kind: 'awaitingDone' };
  if (decision && decision.startsWith('STOP_')) {
    const out = { kind: 'stopped', decision, gate: last?.gate ?? null };
    if (decision === 'STOP_OWNER') out.before = stopBeforeOwner(f);
    return out;
  }
  if (st === 'STOPPED' && f.state?.stoppedReason) return { kind: 'stopped', decision: 'STOP_INCONCLUSIVE', why: f.state.stoppedReason };
  return { kind: 'inProgress', state: st ?? 'NEW' };
}

/**
 * The owner can say «stop» after the program has already stopped the run (a limit, a plateau, an attention
 * failure). The state then only remembers the last word (STOP_OWNER), so the first stop is read back from the
 * ledger: walk back over the trailing events that left the run STOPPED by the owner and look at the state
 * before them. -> { decision, gate, why } when that state was a program stop, otherwise null.
 */
function stopBeforeOwner(f) {
  const led = f.ledger ?? [];
  for (let i = led.length - 1; i >= 0; i--) {
    const sa = led[i].data?.stateAfter;
    if (!sa) continue;
    if (sa.state === 'STOPPED' && sa.lastDecision === 'STOP_OWNER') continue;
    if (sa.state === 'STOPPED' && String(sa.lastDecision ?? '').startsWith('STOP_')) {
      const round = led[i].round ?? sa.round ?? null;
      const gate = f.rounds.find((r) => r.n === round && r.gate && r.gate.decision === sa.lastDecision)?.gate
        ?? { decision: sa.lastDecision, reasons: led[i].data.reasons ?? (sa.stoppedReason ? [sa.stoppedReason] : []) };
      return { decision: sa.lastDecision, gate, why: sa.stoppedReason ?? '' };
    }
    return null;
  }
  return null;
}

function limitWhat(gate, ph) {
  const reasons = (gate?.reasons ?? []).join(' ').toLowerCase();
  const l = gate?.limits ?? {};
  if (/confirm/.test(reasons)) return ph.headline.limitWhat.confirms;
  if (/token/.test(reasons) || (l.maxPanelTokens && l.tokensSpent + (l.nextEstimate ?? 0) > l.maxPanelTokens)) return ph.headline.limitWhat.tokens;
  if (/round/.test(reasons) || (l.maxRounds && l.rounds >= l.maxRounds)) return ph.headline.limitWhat.rounds;
  return ph.headline.limitWhat.unknown;
}

function inconclusiveWhat(o, f, ph) {
  const why = String(o.why ?? f.state?.stoppedReason ?? (o.gate?.reasons ?? []).join(' ')).toLowerCase();
  if (why.includes('lens-writer')) return ph.headline.inconclusiveWhat['lens-writer'];
  if (why.includes('planter')) return ph.headline.inconclusiveWhat.planter;
  return ph.headline.inconclusiveWhat.lenses;
}

export function headline(f, ph = loadPhrases()) {
  const o = runOutcome(f);
  const H = ph.headline;
  if (o.kind === 'done') {
    const x = ownerExceptions(f);
    return x.any ? fill(H.doneWithExceptions, { N: x.waivedSerious, D: x.decisions }) : H.done;
  }
  if (o.kind === 'awaitingDone') return H.awaitingDone;
  if (o.kind === 'inProgress') return fill(H.inProgress, { STATE: H.states[o.state] ?? H.states.other });
  const programReason = (x) => {
    if (x.decision === 'STOP_PLATEAU') return fill(H.reasons.STOP_PLATEAU, { N: x.gate?.plateau?.patience ?? f.run?.limits?.plateauRounds ?? 2 });
    if (x.decision === 'STOP_LIMIT') return fill(H.reasons.STOP_LIMIT, { WHAT: limitWhat(x.gate, ph) });
    return fill(H.reasons.STOP_INCONCLUSIVE, { WHAT: inconclusiveWhat(x, f, ph) });
  };
  let reason;
  if (o.kind === 'edited') reason = H.reasons.edited;
  else if (o.kind === 'aborted') reason = fill(H.reasons.aborted, { WHAT: o.why ? String(o.why).slice(0, 120) : 'причина не записана' });
  else if (o.decision === 'STOP_OWNER') {
    // Both stops happened, in this order: say both (the program first, then the owner).
    reason = o.before ? fill(H.reasons.ownerAfter, { BEFORE: programReason(o.before) }) : H.reasons.STOP_OWNER;
  } else reason = programReason(o);
  return fill(H.notDone, { REASON: reason });
}

function openClusters(f) {
  return f.clusters.filter((c) => c.status === 'open' && (c.severity === 'blocker' || c.severity === 'major'));
}

function openCounts(f) {
  const last = lastGateRound(f);
  if (last?.gate?.open) return { blocker: last.gate.open.blocker ?? 0, major: last.gate.open.major ?? 0 };
  const open = f.clusters.filter((c) => ['open', 'unverified', 'contested'].includes(c.status));
  return { blocker: open.filter((c) => c.severity === 'blocker').length, major: open.filter((c) => c.severity === 'major').length };
}

/**
 * The attention check of the last round that has lens facts. `failing` = lenses that missed their own
 * planted error or had none; `rejected` = lenses that found it but whose answer was rejected (so they
 * cannot certify a clean round). The two are never mixed up.
 */
function attentionStatus(f) {
  const last = [...f.rounds].reverse().find((r) => r.gate?.perLens && Object.keys(r.gate.perLens).length);
  if (!last) return null;
  const failing = [];
  const rejected = [];
  for (const [id, pl] of Object.entries(last.gate.perLens)) {
    if (!pl.guarded || pl.ownCanary?.outcome !== 'caught') failing.push(lensTitle(f, id));
    else if (pl.valid === false) rejected.push(lensTitle(f, id));
  }
  return { round: last.n, failing, rejected };
}

/**
 * What the owner decided or allowed that weakens a plain «Готово»: waived problems, every owner
 * decision (waive, amend, raise-limit, model opt-in, continue), task lines cut on the owner's words,
 * limits or planted-error settings looser than the defaults, a reviewer model chosen in run.json on
 * the owner's words (r3-f9). -> { any, waivedSerious, decisions, requirementCuts, looseLimits, modelOptIns, firstQuote }
 */
export function ownerExceptions(f) {
  const waived = f.clusters.filter((c) => c.status === 'waived' || c.waived);
  const waivedSerious = waived.filter((c) => ['blocker', 'major'].includes(c.severity ?? c.claimedSeverity)).length;
  const decisions = f.decisions.filter((d) => !['stop', 'restore-best'].includes(d.kind)).length;
  const req = taskCutInfo(f);
  const looseLimits = looserLimits(f.run ?? {});
  // a model opt-in written into run.json before freeze (not through owner --kind model-opt-in)
  const decided = new Set(f.decisions.filter((d) => d.kind === 'model-opt-in').map((d) => d.set?.role ?? d.role ?? null));
  const modelOptIns = (f.run?.models?.optIn ?? []).filter((o) => !decided.has(o.role)).length;
  const firstQuote = f.decisions.find((d) => d.quote)?.quote ?? req.quote ?? f.run?.limitsOptIn?.quote ?? f.run?.models?.optIn?.[0]?.quote ?? null;
  const any = waivedSerious > 0 || decisions > 0 || req.requirementCuts > 0 || looseLimits.length > 0 || modelOptIns > 0;
  return { any, waivedSerious, decisions: decisions + modelOptIns, requirementCuts: req.requirementCuts, looseLimits, modelOptIns, firstQuote };
}

/** The last task-set / amend --what task event: which cut lines were requirements, and the owner's words. */
function taskCutInfo(f) {
  const ev = [...f.ledger].reverse().find((e) => e.type === 'task-set' || (e.type === 'amend' && e.data?.what === 'task'));
  const cut = ev?.data?.cut ?? ev?.data?.diff?.task?.cut ?? [];
  const list = Array.isArray(cut) ? cut.filter((c) => c && typeof c === 'object' && c.control === false) : [];
  return { requirementCuts: list.length, lines: list.map((c) => c.line), quote: ev?.data?.ownerQuote ?? null };
}

const LIMIT_RU = Object.freeze({
  maxRounds: 'кругов',
  maxConfirms: 'подтверждающих кругов',
  maxPanelTokens: 'токенов',
  plateauRounds: 'кругов без улучшения до остановки',
  maxLensReruns: 'повторов одного взгляда',
  verifierBatchMax: 'находок на одного агента-перепроверки',
  roundTokenEstimate: 'оценка токенов на круг',
  sampleThresholdBytes: 'размер файла с данными, с которого проверка идёт по выборке, байт',
  sampleThresholdRows: 'число строк в файле, с которого проверка идёт по выборке',
  sampleRows: 'строк в выборке из большого файла',
  sampleMaxBytes: 'наибольший объём выборки из одного файла, знаков',
  sampleTotalBytes: 'наибольший объём выборок из всех больших файлов вместе, знаков',
  'canaries.attentionPerLens': 'подложенных ошибок на один взгляд',
  'canaries.measurementWorking': 'ошибок для замера в рабочем круге',
  'canaries.measurementConfirm': 'ошибок для замера в подтверждающем круге',
  'canaries.candidatesPerSlot': 'вариантов на одну подложенную ошибку',
  'canaries.maxEditChars': 'наибольшая длина подложенной правки, знаков',
  'canaries.minDistanceChars': 'наименьшее расстояние между подложенными ошибками, знаков',
  'canaries.decoysPerRound': 'заведомо ложных замечаний в круге',
  'canaries.controlsPerRound': 'известных настоящих проблем, подмешиваемых к перепроверке, в круге',
});

// ------------------------------------------------------------------ sections

function sectionVersion(f, ph) {
  const V = ph.version;
  const out = [];
  const lastGated = [...f.rounds].reverse().find(GATED);
  const confirm = [...f.rounds].reverse().find((r) => r.gate?.kind === 'confirm');
  const ref = f.done ? { hash: f.done.reviewedVersionHash, ts: f.done.at } : confirm ? { hash: confirm.gate.versionHash, ts: confirm.gateTs } : lastGated ? { hash: lastGated.gate.versionHash, ts: lastGated.gateTs } : null;
  if (!ref) out.push(V.none);
  else {
    out.push(fill(V.line, { HASH: code(String(ref.hash ?? '').slice(0, 16)), DATE: dateRu(ref.ts) }));
    const changed = changedFiles(f);
    if (runOutcome(f).kind === 'done') out.push(V.unchanged);
    else if (changed && changed.length) {
      out.push(V.changed);
      for (const c of changed) out.push(`- ${code(c)}`);
    } else if (runOutcome(f).kind === 'edited') out.push(V.changed);
    else out.push(V.notCompared);
  }
  const roots = f.run?.material?.roots ?? [];
  if (roots.length) {
    out.push('');
    out.push(V.roots);
    for (const r of roots) out.push(`- ${code(r.path)}${r.as ? ` (как ${code(r.as)})` : ''}`);
  }
  if ((f.ledger ?? []).find((l) => l.type === 'init')?.data?.dataHome?.nonDefault) {
    out.push('');
    out.push(V.dataHomeNonDefault);
  }
  // Which reviewer templates the run used and whether the owner approved that version (r3-f6).
  const initEv = (f.ledger ?? []).find((l) => l.type === 'init');
  if (initEv?.data?.templatesManifestVersion != null) {
    const a = initEv.data.templatesApproval;
    out.push('');
    out.push(a ? fill(V.templates, { V: initEv.data.templatesManifestVersion, DATE: a.date, QUOTE: String(a.quote).replace(/[«»]/g, '"') }) : fill(V.templatesUnapproved, { V: initEv.data.templatesManifestVersion }));
  }
  out.push('');
  out.push(V.sourcesTitle);
  if (!f.sources.length) out.push(V.noSources);
  for (const s of f.sources) {
    const recipe = s.kind === 'command' ? [s.cmd, ...(s.args || [])].map(quoteArg).join(' ') : s.path;
    const strip = (x) => String(x || '').replace(/[.\s]+$/, '');
    // the executor's own words, quoted as such (they may be in English, r3-f19)
    const q = (x) => `«${String(x).replace(/[«»]/g, '"')}»`;
    out.push(`- ${s.id}: ${q(inline(strip(s.what)))} (${V.executorWords}). ${V.origin}: ${strip(s.origin) ? q(inline(strip(s.origin))) : V.originMissing}. ${V.recipe}: ${code(recipe)}`);
  }
  const pv = f.stripPreview;
  out.push('');
  out.push(V.stripTitle);
  if (!pv) out.push(V.noStrip);
  else {
    const ex = pv.excluded ?? [];
    out.push(ex.length ? fill(V.excluded, { N: ex.length, M: ex.filter((e) => !e.trace).length }) : V.noneExcluded);
    for (const e of ex.slice(0, 30)) out.push(`  - ${code(e.file)}${e.trace ? '' : ` (${V.noTrace})`}`);
    for (const r of pv.rules ?? []) out.push(`- ${fill(V.rule, { N: r.index + 1, MATCHES: r.matches, FILES: (r.files ?? []).length })}: ${code(JSON.stringify(String(r.pattern)).slice(1, -1))} — ${V.why}: «${String(inline(r.why)).replace(/[«»]/g, '"')}»${r.nonTrace ? ` (${fill(V.ruleNonTrace, { K: r.nonTrace })})` : ''}`);
    const allow = pv.allow ?? [];
    if (!allow.length) out.push(V.noAllow);
    for (const a of allow) out.push(`- ${fill(V.allow, { PHRASE: String(a.phrase).replace(/[«»]/g, '"'), MATCHES: a.matches ?? 0, FILES: a.files ?? 0, WHY: String(a.why).replace(/[«»]/g, '"') })}`);
    const tc = pv.traceCoverage;
    if (tc && tc.dataFiles > 0) {
      out.push(fill(V.traceData, { N: tc.dataFiles, K: tc.fullDataFiles ?? 0 }));
      const red = tc.reducedFiles ?? [];
      if (red.length) {
        out.push(fill(V.traceDataReduced, { N: red.length, P: red[0].patternsReduced ?? 0 }));
        for (const x of red.slice(0, 10)) out.push(`  - ${fill(V.traceDataFile, { FILE: code(x.file), ROWS: x.rows, SHORT: x.shortValues, PROSE: x.proseValues })}`);
        if (red.length > 10) out.push(`  - …`);
      }
    }
    if (pv.rebuild) out.push(`- ${V.rebuild}: ${code(pv.rebuild.cmd)}${(pv.rebuild.differsFromMaterial ?? []).length ? ` — ${V.rebuildDiffers}: ${pv.rebuild.differsFromMaterial.slice(0, 10).map(code).join(', ')}` : ''}`);
  }
  return out;
}

/** Owner lines that TASK.md does not keep (TASK.md = OWNER-TASK.md with whole lines deleted). */
export function cutLines(ownerTask, task) {
  if (ownerTask === null || task === null) return [];
  const owner = ownerTask.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (owner.length && /^Source:/.test(owner[owner.length - 1])) owner.pop();
  const kept = task.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const cut = [];
  let j = 0;
  owner.forEach((line, i) => {
    if (j < kept.length && kept[j] === line) j++;
    else cut.push({ n: i + 1, text: line });
  });
  return cut.filter((c) => c.text.trim() !== '');
}

function sectionTask(f, ph) {
  const T = ph.task;
  const out = [];
  if (f.task === null) return [T.missing];
  out.push(...quoteLines(f.task));
  out.push('');
  out.push(`**${T.cutTitle}**`);
  out.push('');
  const cut = cutLines(f.ownerTask, f.task);
  if (!cut.length) out.push(T.noCut);
  else {
    const info = taskCutInfo(f);
    const byOwner = new Set(info.lines);
    const control = cut.filter((c) => !byOwner.has(c.n));
    const owner = cut.filter((c) => byOwner.has(c.n));
    if (control.length) {
      for (const c of control) out.push(...quoteLines(c.text, `строка ${c.n}: `));
      out.push('');
      out.push(T.cutReason);
    }
    if (owner.length) {
      if (control.length) out.push('');
      for (const c of owner) out.push(...quoteLines(c.text, `строка ${c.n}: `));
      out.push('');
      out.push(T.cutByOwner);
      out.push(...quoteLines(info.quote ?? ''));
    }
  }
  return out;
}

function sevRu(s, ph) {
  return ph.issues[s] ?? s;
}

function clusterLines(c, ph, idx) {
  const I = ph.issues;
  const out = [];
  out.push(`${idx}. **${sevRu(c.severity ?? c.claimedSeverity, ph)}** — ${I.where}: ${code(c.file)}${c.locator ? `, ${inline(c.locator)}` : ''}`);
  if (c.quote) out.push(...quoteLines(c.quote, `${I.quote}: `).map((l) => `   ${l}`));
  out.push(...quoteLines(c.problem, `${I.problem}: `).map((l) => `   ${l}`));
  const ev = [...(c.evidence ?? [])].reverse().find((e) => e && e.evidence);
  if (ev) out.push(...quoteLines(String(ev.evidence).slice(0, 600), `${I.evidence}: `).map((l) => `   ${l}`));
  return out;
}

function sectionIssues(f, ph, outcome) {
  const out = [];
  const open = openClusters(f).sort((a, b) => (a.severity === b.severity ? String(a.id).localeCompare(String(b.id)) : a.severity === 'blocker' ? -1 : 1));
  if (!open.length) out.push(ph.issues.none);
  else open.forEach((c, i) => out.push(...clusterLines(c, ph, i + 1)));
  const cosmetic = f.clusters.filter((c) => c.status === 'cosmetic').length;
  if (cosmetic) {
    out.push('');
    out.push(fill(ph.issues.cosmeticCount, { N: cosmetic }));
  }
  const serious = f.clusters.filter((c) => (c.claimedSeverity === 'blocker' || c.claimedSeverity === 'major') && (c.evidence ?? []).length);
  if (serious.length) {
    const dropped = serious.filter((c) => c.status === 'dropped').length;
    out.push('');
    out.push(fill(ph.fixed.falseAlarms, { N: serious.length, M: dropped }));
  }
  if (outcome.kind === 'done') {
    out.push('');
    out.push(ph.fixed.atDone);
  }
  return out;
}

function sectionDoubtful(f, ph) {
  const I = ph.issues;
  const list = f.clusters.filter((c) => (c.status === 'contested' || c.status === 'unverified') && (c.severity ?? c.claimedSeverity) !== 'cosmetic');
  if (!list.length) return [I.noneContested];
  const out = [];
  list.forEach((c, i) => {
    const lines = clusterLines(c, ph, i + 1);
    lines[0] = `${lines[0]} — ${c.status === 'contested' ? I.contested : I.unverified}.`;
    out.push(...lines);
  });
  out.push('');
  out.push(I.question);
  return out;
}

/**
 * Escapes the owner recorded in the cross-run ledger for this run (ledger add-escape), shaped like
 * decisions so that their quotes are printed and checked for reuse with the rest. -> [] without a data home.
 */
export function escapesOfRun(f, dataPaths) {
  const runId = f.run?.runId;
  if (!dataPaths || !runId) return [];
  let rows = [];
  try {
    rows = readRows(dataPaths.measurements.escapes);
  } catch {
    return [];
  }
  return rows
    .filter((e) => e.runId === runId && typeof e.ownerQuote === 'string')
    .map((e) => ({ id: `escape-${e.seq}`, ts: e.ts, kind: 'escape', quote: e.ownerQuote, question: e.question ?? null }));
}

/** Decisions of the run and escapes recorded for it, in time order. */
function decisionsAndEscapes(f) {
  return [...f.decisions, ...(f.escapes ?? [])].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
}

function sectionDecisions(f, ph) {
  const D = ph.decisions;
  const disputes = disputeLines(f, ph);
  const all = decisionsAndEscapes(f);
  if (!all.length) return disputes.length ? [D.none, '', ...disputes] : [D.none];
  const out = [];
  all.forEach((d, i) => {
    const what = D[d.kind] ?? d.kind;
    const extra = d.clusters?.length ? ` (${d.clusters.map(code).join(', ')})` : '';
    const set = d.set && Object.keys(d.set).length ? ` — ${Object.entries(d.set).map(([k, v]) => `${code(k)} = ${code(v)}`).join(', ')}` : '';
    out.push(`${i + 1}. ${what}${extra}${set}, ${dateRu(d.ts)}. ${D.yourWords[0].toUpperCase()}${D.yourWords.slice(1)}:`);
    out.push(...quoteLines(d.quote).map((l) => `   ${l}`));
    // the question each quote answered is printed under it; a decision without one is said so
    if (d.question) out.push(...quoteLines(d.question, `${D.question}: `).map((l) => `   ${l}`));
    else if (d.quote) out.push(`   ${D.noQuestion}`);
    if (d.kind === 'waive') {
      for (const id of d.clusters ?? []) {
        const c = f.clusters.find((x) => x.id === id);
        if (c?.problem) out.push(...quoteLines(c.problem, `${ph.issues.problem}: `).map((l) => `   ${l}`));
      }
    }
  });
  const flags = ownerQuoteFlags(f);
  for (const r of flags.reuse) {
    const list = r.decisions.map((x) => fill(D.reuseItem, { ID: x.id, WHAT: subjectRu(x.subject, D) })).join(', ');
    out.push('', fill(D.reuse, { LIST: list }));
    out.push(...quoteLines(r.quote).map((l) => `   ${l}`));
  }
  for (const x of flags.predates) out.push('', fill(D.predates, { CLUSTER: code(x.cluster), ID: x.id, SINCE: dateRu(x.quoteSince), WHEN: dateRu(x.problemSince) }));
  if (disputes.length) out.push('', ...disputes);
  return out;
}

function subjectRu(subject, D) {
  const [kind, what] = String(subject).split(':');
  const base = D[kind] ?? kind;
  return what ? `${base}: ${D.amendWhat[what] ?? what}` : base;
}

/**
 * The flags of quoteFlags (core/owner.mjs) for a run: one quote behind decisions of different
 * kinds, and words recorded before the problem they were used for existed. The moment a problem
 * appeared is the ledger event that created its cluster (else the opening of its first round).
 */
export function ownerQuoteFlags(f) {
  const born = new Map();
  for (const e of f.ledger) if (e.type === 'cluster') for (const id of e.data?.newClusters ?? []) if (!born.has(id)) born.set(id, e.ts);
  const opened = new Map();
  for (const e of f.ledger) if (e.type === 'round-open' && e.round != null && !opened.has(e.round)) opened.set(e.round, e.ts);
  const clusterBorn = (id) => {
    if (born.has(id)) return born.get(id);
    const m = /^C-(\d+)-/.exec(String(id));
    return m ? opened.get(Number(m[1])) ?? null : null;
  };
  const dated = [f.run?.limitsOptIn, f.run?.driver?.workflowOptIn, ...(f.run?.models?.optIn ?? [])].filter((x) => x && x.quote && x.date).map((x) => ({ quote: x.quote, date: x.date }));
  return quoteFlags(decisionsAndEscapes(f), { clusterBorn, datedQuotes: dated });
}

/** Every dispute the executor raised, with its outcome (two dispute verifiers decide each). */
function disputeLines(f, ph) {
  const D = ph.disputes;
  if (!f.disputes.length) return [];
  const out = [D.title];
  f.disputes.forEach((d, i) => {
    const outcome = D.outcome[d.status] ?? d.status;
    out.push(`${i + 1}. ${fill(D.line, { ID: code(d.cluster) })} ${outcome}.`);
    out.push(...quoteLines(d.argument, `${D.argument}: `).map((l) => `   ${l}`));
  });
  return out;
}

function lastReviewedRound(f) {
  return [...f.rounds].reverse().find((r) => r.answers.some((a) => isReviewerAnswer(r, a))) ?? null;
}

function isReviewerAnswer(r, a) {
  const job = r.jobs.find((j) => j.job === a.name);
  if (job) return job.role === 'reviewer';
  return Array.isArray(a.value?.inspected);
}

/** Large data files reviewed through a sample: how many rows the reviewers saw out of how many (SPEC 14.10). */
function sampleCoverageLines(f, ph) {
  const N = ph.notChecked;
  const reviewed = f.rounds.filter((r) => r.answers.some((a) => isReviewerAnswer(r, a)));
  const rounds = reviewed.filter((r) => r.sample?.files?.length);
  const bigRounds = reviewed.filter((r) => r.sample?.unsampled?.length);
  const out = [];
  if (rounds.length) {
    out.push(N.sampleIntro, '');
    const all = [];
    for (const r of rounds) {
      for (const e of r.sample.files) {
        const g = e.grouped ? ` ${fill(N.sampleGroup, { G: e.grouped.files, TOTAL: sizeRu(e.grouped.bytes) })}` : '';
        all.push(`- ${fill(N.sampleLine, { R: RL(f, r.n), FILE: code(e.file), N: e.chosen.length, M: e.rows })}${g}`);
      }
    }
    out.push(...all.slice(0, 30));
    if (all.length > 30) out.push(`- ${fill(N.sampleMore, { K: all.length - 30 })}`);
    out.push('', N.sampleLimit);
  }
  if (bigRounds.length) {
    if (out.length) out.push('');
    out.push(N.unsampledIntro, '');
    const all = [];
    for (const r of bigRounds) {
      for (const u of r.sample.unsampled) {
        all.push(`- ${fill(u.grouped ? N.unsampledGroupLine : N.unsampledLine, { R: RL(f, r.n), FILE: code(u.file), SIZE: sizeRu(u.bytes), G: u.grouped?.files, TOTAL: u.grouped ? sizeRu(u.grouped.bytes) : '' })}`);
      }
    }
    out.push(...all.slice(0, 30));
    if (all.length > 30) out.push(`- ${fill(N.sampleMore, { K: all.length - 30 })}`);
    out.push('', N.unsampledLimit);
  }
  return out;
}

function sectionNotChecked(f, ph) {
  const N = ph.notChecked;
  const out = sampleCoverageLines(f, ph);
  if (out.length) out.push('');
  const usedNoSources = f.ledger.some((e) => e.type === 'sources-check' && e.data && (e.data.noSources === true || e.data.skipped === true));
  if (usedNoSources) out.push(N.noSources);
  // A source the reviewers could not reach: the last event of each round, every round of the run.
  const lastUnavailable = new Map();
  for (const e of f.ledger) if (e.type === 'source-unavailable' && Number.isInteger(e.round)) lastUnavailable.set(e.round, e);
  for (const [round, e] of [...lastUnavailable.entries()].sort((a, b) => a[0] - b[0])) {
    for (const s of e.data?.sources ?? []) {
      const phrase = s.state === 'unavailable' ? N.sourceUnavailable : N.sourcePartial;
      out.push(fill(phrase, { ID: code(s.sourceId), N: RL(f, round), U: s.unavailable, A: s.attempts }));
      if (s.excerpt) out.push(...quoteLines(s.excerpt, 'ответ источника: '));
      if (s.suspicious) out.push(fill(N.sourceSuspicious, { ID: code(s.sourceId) }));
    }
  }
  const r = lastReviewedRound(f);
  if (r) {
    for (const a of r.answers.filter((x) => isReviewerAnswer(r, x))) {
      const job = r.jobs.find((j) => j.job === a.name);
      const title = inline(lensTitle(f, job?.lens));
      const v = a.value;
      for (const x of v.notChecked ?? []) out.push(...quoteLines(`${x.what} — ${x.why}`, `${title}, ${N.notChecked}: `));
      // An item the source's refusal made impossible is reported as "source unavailable" above, not as "not done".
      const lens = (f.lenses?.lenses ?? []).find((l) => l.id === job?.lens);
      const attemptsOf = new Map(summariseSourceAttempts(v.sourceChecks).map((x) => [x.sourceId, x]));
      for (const x of v.inspected ?? []) {
        if (!x || x.done !== false) continue;
        if (sourceMinimumRescue((lens?.minimum ?? []).find((m) => m.id === x.minimumId), attemptsOf)) continue;
        out.push(...quoteLines(`${x.minimumId}: ${x.how}`, `${title}, ${N.minimumNotDone}: `));
      }
      for (const x of v.notVerified ?? []) out.push(...quoteLines(`${x.claim} (${x.whereLooked})`, `${title}, ${N.notVerified}: `));
    }
    const sc = r.sourcesCheck;
    const list = Array.isArray(sc) ? sc : sc?.results ?? sc?.sources ?? [];
    for (const s of list) if (s && s.ok === false) out.push(...quoteLines(`${s.id}: ${s.error ?? 'ошибка'}`, `${N.brokenSource}: `));
  }
  if (!out.length) out.push(N.none);
  return out;
}

/**
 * What one round says about the planted errors. «Caught» follows the gate's own fact for the lens (the
 * certifying attempt, SPEC 13.1) when the gate has it, so every line of the report agrees with the lens
 * line; otherwise it is read from the detections. `rejected` = lenses that caught their own error but
 * whose answer was not accepted (the gate says the lens is not valid).
 */
function roundCanaryFacts(r) {
  const canaries = r.canaries ?? [];
  const dets = r.detections ?? [];
  const perLens = r.gate?.perLens ?? {};
  const attention = canaries.filter((c) => c.purpose === 'attention');
  const caughtBy = (c) => {
    const pl = perLens[c.targetLens];
    if (pl && pl.ownCanary) return pl.guarded !== false && pl.ownCanary.outcome === 'caught';
    return dets.some((d) => d.canary === c.canary && d.lens === c.targetLens && d.outcome === 'caught');
  };
  const ownCaught = attention.filter(caughtBy);
  const rejected = ownCaught.filter((c) => perLens[c.targetLens]?.valid === false).map((c) => c.targetLens);
  const pairsCaught = r.gate?.panelCatch?.pairsCaught ?? dets.filter((d) => d.outcome === 'caught').length;
  const pairsTotal = r.gate?.panelCatch?.pairsTotal ?? dets.length;
  const unanimous = canaries.filter((c) => {
    const rows = dets.filter((d) => d.canary === c.canary);
    return rows.length > 0 && rows.every((d) => d.outcome === 'missed');
  });
  return { canaries, attention, ownCaught, rejected, pairsCaught, pairsTotal, unanimous };
}

/** True when a round planted at least one omission canary ("something required is missing"). */
function hasOmissionCanary(r) {
  let tax = null;
  try {
    tax = loadTaxonomy();
  } catch {
    return true;
  }
  return (r.canaries ?? []).some((c) => tax.byId(c.type)?.omission);
}

function sectionCanaries(f, ph) {
  const C = ph.canaries;
  const out = [];
  const withCanaries = f.rounds.filter((r) => (r.canaries ?? []).length && r.detections);
  if (!withCanaries.length) {
    out.push(C.none);
  } else {
    const last = withCanaries[withCanaries.length - 1];
    const facts = roundCanaryFacts(last);
    out.push(fill(C.lastRound, { R: RL(f, last.n) }));
    // Reviewers are worst at noticing that something required is missing: say so when a round had
    // no planted omission at all (its slot could not be filled), r2-f45.
    if (!hasOmissionCanary(last)) {
      out.push('');
      out.push(C.noOmission);
    }
    out.push('');
    out.push(fill(ph.fixed.grossCheck, { N: facts.attention.length }));
    // the measurement errors are planted too (r3-f22): say how many
    const measured = facts.canaries.length - facts.attention.length;
    if (measured > 0) out.push(fill(C.measurementExtra, { M: measured }));
    out.push('');
    const perLens = last.gate?.perLens ?? {};
    const lensIds = Object.keys(perLens).length ? Object.keys(perLens) : [...new Set(facts.attention.map((c) => c.targetLens))];
    for (const id of lensIds) {
      const pl = perLens[id] ?? {};
      let state;
      if (pl.guarded === false || (!pl.ownCanary && !facts.attention.some((c) => c.targetLens === id))) state = C.lensUnguarded;
      else if (facts.rejected.includes(id)) state = fill(C.lensCaughtRejected, { WHY: answerReasonsRu(pl.invalidReasons, ph) });
      else if (pl.unreliable) state = C.lensUnreliable;
      else {
        const rows = (last.detections ?? []).filter((d) => d.lens === id && facts.attention.some((c) => c.canary === d.canary && c.targetLens === id));
        const first = rows.filter((d) => (d.attempt ?? 1) === 1);
        const anyCaught = rows.some((d) => d.outcome === 'caught');
        const outcomeNow = pl.ownCanary?.outcome ?? (anyCaught ? 'caught' : rows.some((d) => d.outcome === 'seen_underclassified') ? 'seen_underclassified' : 'missed');
        if (outcomeNow === 'caught' && first.length && !first.some((d) => d.outcome === 'caught') && (pl.attempts ?? 1) > 1) state = C.lensCaughtRerun;
        else if (outcomeNow === 'caught') state = C.lensCaught;
        else if (outcomeNow === 'seen_underclassified') state = C.lensUnder;
        else state = C.lensMissed;
      }
      out.push(`- ${inline(lensTitle(f, id))}: ${state}.`);
    }
    out.push('');
    // Each planted error targets one lens, so the pair share is a diagnostic, not a verdict; the
    // verdict rests on the lenses' own attention checks (r3-f22).
    out.push(fill(C.pairs, { X: facts.pairsCaught, Y: facts.pairsTotal }));
    if (facts.attention.length > 0 && facts.ownCaught.length * 2 < facts.attention.length) out.push(C.panelBad);
    if (facts.attention.length) {
      const [lo, hi] = clopperPearson(facts.ownCaught.length, facts.attention.length);
      out.push(fill(ph.fixed.smallN, { K: facts.ownCaught.length, N: facts.attention.length, LO: pct(lo), HI: pct(hi) }));
      if (facts.rejected.length) out.push(fill(C.rejectedNote, { R: facts.rejected.length, LIST: facts.rejected.map((id) => inline(lensTitle(f, id))).join(', ') }));
    }
    for (const c of facts.unanimous) {
      out.push('');
      out.push(fill(ph.fixed.unanimousMiss, { TEXT: lintSafe(c.description || c.canary).replace(/[«»]/g, '"') }));
    }
    if (withCanaries.length > 1) {
      out.push('');
      for (const r of withCanaries.slice(0, -1)) {
        const x = roundCanaryFacts(r);
        out.push(`- ${fill(x.rejected.length ? C.roundLineRejected : C.roundLine, { R: RL(f, r.n), X: x.pairsCaught, Y: x.pairsTotal, K: x.ownCaught.length, L: x.attention.length, Q: x.rejected.length })}`);
      }
    }
  }
  out.push(...sectionDecoys(f, ph));
  out.push(...sectionControls(f, ph));
  if (f.rounds.some((r) => r.round?.seeded === true)) {
    out.push('');
    out.push(ph.fixed.seeded);
  }
  return out;
}

/**
 * Facts about the decoys (false findings shown to verifiers) of a run, or null when the run had none
 * switched on: per round how many were shown and refuted, and the rounds where none could be mixed in.
 */
export function decoyFacts(f) {
  const events = f.ledger.filter((e) => e.type === 'decoys-ingested');
  if (!events.length) return null;
  const rounds = [];
  const empty = [];
  for (const r of f.rounds) {
    const ev = events.filter((e) => e.round === r.n).pop();
    if (!ev) continue;
    // no decoys in this round: the writer failed, or nothing it proposed passed the checks
    if (ev.data?.ok === false || ev.data?.chosen === 0) {
      empty.push(r.n);
      continue;
    }
    // decoys of a round that is still open are sealed: nothing to report yet
    if (!r.decoyKey) continue;
    const s = summariseResults(r.decoyResults?.results ?? []);
    if (s.presented > 0) rounds.push({ n: r.n, ...s });
  }
  const sum = (k) => rounds.reduce((a, x) => a + x[k], 0);
  return {
    rounds,
    empty,
    answered: sum('answered'),
    rejected: sum('rejected'),
    confirmed: sum('confirmed'),
    undecided: sum('undecided'),
    taintedJobs: rounds.reduce((a, x) => a + x.taintedJobs.length, 0),
  };
}

function sectionDecoys(f, ph) {
  const D = ph.decoys;
  const x = decoyFacts(f);
  if (!x) return [];
  const out = [''];
  if (!x.answered) {
    out.push(D.none);
  } else {
    out.push(fill(D.line, { X: x.rejected, Y: x.answered }));
    if (x.confirmed) {
      out.push('');
      out.push(fill(D.confirmed, { N: x.confirmed }));
    }
    if (x.rounds.length > 1) {
      out.push('');
      for (const r of x.rounds) out.push(`- ${fill(D.roundLine, { R: RL(f, r.n), X: r.rejected, Y: r.answered })}`);
    }
  }
  if (x.answered) {
    for (const n of x.empty) {
      out.push('');
      out.push(fill(D.emptyRound, { R: RL(f, n) }));
    }
  }
  return out;
}

/**
 * Facts about the true controls (real planted defects shown to verifiers) of a run, or null when no round
 * tried to mix any in: per round how many were shown and wrongly dismissed or played down, and the rounds
 * where none could be mixed in.
 */
export function controlFacts(f) {
  const events = f.ledger.filter((e) => e.type === 'controls-sealed');
  if (!events.length) return null;
  const rounds = [];
  const empty = [];
  for (const r of f.rounds) {
    const ev = events.filter((e) => e.round === r.n).pop();
    if (!ev) continue;
    if (!ev.data?.chosen) {
      empty.push(r.n);
      continue;
    }
    // controls of a round that is still open are sealed: nothing to report yet
    if (!r.controlKey) continue;
    const s = summariseControls(r.controlResults?.results ?? []);
    if (s.presented > 0) rounds.push({ n: r.n, ...s });
  }
  const sum = (k) => rounds.reduce((a, x) => a + x[k], 0);
  return {
    rounds,
    empty,
    answered: sum('answered'),
    kept: sum('kept'),
    dismissed: sum('dismissed'),
    downgraded: sum('downgraded'),
    undecided: sum('undecided'),
    failedJobs: rounds.reduce((a, x) => a + x.failedJobs.length, 0),
  };
}

function sectionControls(f, ph) {
  const C = ph.controls;
  const x = controlFacts(f);
  if (!x) return [];
  const out = [''];
  if (!x.answered) {
    out.push(C.none);
  } else {
    out.push(fill(C.line, { Y: x.answered, X: x.dismissed, Z: x.downgraded }));
    if (x.dismissed + x.downgraded) {
      out.push('');
      out.push(C.failed);
    }
    if (x.rounds.length > 1) {
      out.push('');
      for (const r of x.rounds) out.push(`- ${fill(C.roundLine, { R: RL(f, r.n), Y: r.answered, X: r.dismissed, Z: r.downgraded })}`);
    }
  }
  if (x.answered) {
    for (const n of x.empty) {
      out.push('');
      out.push(fill(C.emptyRound, { R: RL(f, n) }));
    }
  }
  return out;
}

function allReviewersDefault(f) {
  const opt = f.run?.models?.optIn ?? [];
  if (opt.some((o) => o && (o.role === 'reviewer' || o.role === 'confirm-extra'))) return false;
  let reviewers = 0;
  for (const r of f.rounds) {
    for (const j of r.jobs) {
      if (j.role !== 'reviewer') continue;
      reviewers++;
      if (j.model) return false;
    }
  }
  return reviewers > 0;
}

function sectionLedger(f, ph, dataPaths) {
  const L = ph.ledger;
  const out = [];
  let s = null;
  if (dataPaths) {
    try {
      s = statsForRun(dataPaths, f.frozen?.instrumentId ?? null);
    } catch {
      s = null;
    }
  }
  const T = s?.headlineN ?? 25;
  if (!s || !s.enough) out.push(fill(L.few, { N: s?.ownLens?.n ?? 0, T }));
  else {
    const [lo, hi] = s.ownLens.ci ?? clopperPearson(s.ownLens.k, s.ownLens.n);
    out.push(fill(L.enough, { K: s.ownLens.k, N: s.ownLens.n, LO: pct(lo), HI: pct(hi) }));
  }
  if (s?.omission && s.omission.n) {
    const v = s.omission.sufficient
      ? `${s.omission.k} из ${s.omission.n} (где-то от ${pct(s.omission.ci[0])} до ${pct(s.omission.ci[1])} из 100)`
      : `${s.omission.k} из ${s.omission.n} — мало данных`;
    out.push(fill(L.omission, { VALUE: v }));
  } else out.push(L.omissionNone);
  if (s?.decoyRejection && s.decoyRejection.n) {
    const d = s.decoyRejection;
    out.push(
      d.sufficient
        ? fill(L.decoys, { K: d.k, N: d.n, LO: pct(d.ci[0]), HI: pct(d.ci[1]) })
        : fill(L.decoysFew, { K: d.k, N: d.n }),
    );
  }
  if (s?.controlDismissed && s.controlDismissed.n) {
    const d = s.controlDismissed;
    out.push(
      d.sufficient
        ? fill(L.controls, { K: d.k, N: d.n, LO: pct(d.ci[0]), HI: pct(d.ci[1]) })
        : fill(L.controlsFew, { K: d.k, N: d.n }),
    );
  }
  out.push('');
  out.push(ph.fixed.alwaysSection9);
  if (allReviewersDefault(f)) {
    // name Sonnet only when the window's Claude home said so at freeze (r3-f20)
    const ad = [...(f.ledger ?? [])].reverse().find((e) => e.type === 'freeze')?.data?.agentDefaults;
    out.push('');
    out.push(ad && !ad.sonnet ? fill(ph.fixed.sameModelUnchecked, { MODEL: ad.model ?? 'не указана' }) : ph.fixed.sameModel);
  }
  return out;
}

function sectionBand(f, ph) {
  const confirm = [...f.rounds].reverse().find((r) => r.gate?.kind === 'confirm' && r.gate?.band?.worst);
  if (!confirm) return [ph.band.none];
  const [a, b] = confirm.gate.band.worst;
  return [fill(ph.fixed.band, { A: decimalRu(a), B: decimalRu(b) })];
}

/** Where the program's own look at the findings disagreed with the matcher (SPEC 14.6a): plain lines for the round. */
function crossCheckLinesRu(cc, ph) {
  if (!cc) return [];
  const R = ph.rounds;
  const list = (items, withCanary = true) => items.slice(0, 12).map((x) => code(withCanary ? fill(R.crossItem, { ID: x.id, C: x.canary }) : x.id)).join(', ') + (items.length > 12 ? ', …' : '');
  const out = [];
  if (cc.hits?.length) out.push(fill(R.crossHit, { N: cc.hits.length, LIST: list(cc.hits) }));
  if (cc.keptReal?.length) out.push(fill(R.crossKept, { N: cc.keptReal.length, LIST: list(cc.keptReal) }));
  if (cc.alsoRealIgnored?.length) out.push(fill(R.crossIgnored, { N: new Set(cc.alsoRealIgnored.map((x) => x.id)).size, LIST: list([...new Map(cc.alsoRealIgnored.map((x) => [x.id, x])).values()], false) }));
  return out;
}

function sectionRounds(f, ph) {
  const R = ph.rounds;
  const out = [];
  const gated = f.rounds.filter((r) => r.gate);
  if (!gated.length) out.push(R.none);
  if (gated.some(isBlocked)) {
    out.push(R.numbering);
    out.push('');
  }
  for (const r of gated) {
    const g = r.gate;
    if (isBlocked(r)) {
      // An attempt that never reached the reviewers: no problem counts, only the reason (the program's
      // own English words, quoted).
      const why = fill(R.blockedWhy[g.decision], { N: (g.reasons ?? []).length });
      out.push(`- ${fill(R.blockedLine, { FOLDER: code(folderName(r.n)), WHY: why })}`);
      for (const x of (g.reasons ?? []).slice(0, 3)) out.push(...quoteLines(String(x).slice(0, 300)).map((l) => `  ${l}`));
      continue;
    }
    out.push(
      `- ${fill(R.line, {
        R: r.real ?? r.n,
        FOLDER: r.real != null && r.real !== r.n ? fill(R.folderIn, { FOLDER: folderPart(r.n) }) : '',
        KIND: g.kind === 'confirm' ? R.confirm : R.working,
        B: g.open?.blocker ?? 0,
        M: g.open?.major ?? 0,
        DECISION: R.decisions[g.decision] ?? g.decision,
      })}`,
    );
    // What strip removed from this round's copy (r2-f40): reviewers never saw these files.
    const ex = r.copy?.stripExcluded ?? [];
    if (ex.length) out.push(`  - ${fill(R.excluded, { N: ex.length, M: ex.filter((e) => !e.trace).length })}: ${ex.slice(0, 10).map((e) => code(e.file)).join(', ')}${ex.length > 10 ? ', …' : ''}`);
    if (r.copy?.rebuiltAfterTamper) out.push(`  - ${R.copyTampered}`);
    if (r.tamper) for (const l of tamperLinesRu(r.tamper, ph, fill, { filesPath: code(`${folderName(r.n)}\\copy-tamper.json`) })) out.push(`  - ${l}`);
    if (r.round?.copyScratchRemoved) out.push(`  - ${scratchLineRu(r.round.copyScratchRemoved, ph, fill)}`);
    out.push(...crossCheckLinesRu(r.round?.crossCheck, ph).map((l) => `  - ${l}`));
  }
  const H = ph.history;
  const init = f.ledger.find((e) => e.type === 'init');
  for (const e of init?.data?.earlierRuns ?? []) {
    out.push(`- ${fill(H.earlier, { RUN: code(e.runId), STATUS: code(e.lastDecision || e.status || '?'), N: (e.openSerious ?? []).length })}`);
    for (const c of (e.openSerious ?? []).slice(0, 10)) out.push(...quoteLines(`${c.file ?? '?'}: ${c.problem}`, `${sevRu(c.severity, ph)}: `).map((l) => `  ${l}`));
  }
  const issued = f.ledger.filter((e) => e.type === 'lens-writer-issued').length;
  const resets = f.ledger.filter((e) => e.type === 'setup-reset').length;
  if (issued > 1 || resets) out.push(`- ${fill(H.lensWriter, { N: issued, R: resets })}`);
  const amends = f.ledger.filter((e) => e.type === 'amend');
  for (const e of amends) {
    out.push(`- ${fill(R.amend, { WHAT: e.data?.what ?? '?' })}`);
    out.push(...quoteLines(e.data?.reason ?? '').map((l) => `  ${l}`));
  }
  return out;
}

function sectionCost(f, ph) {
  const C = ph.cost;
  const out = [];
  const total = f.usage.reduce((s, u) => s + (Number(u.tokens) || 0), 0);
  const estimated = f.usage.some((u) => u.estimated);
  out.push(fill(C.tokens, { T: tokensRu(total) }).replace(/\.\.$/, '.') + (estimated ? ` ${C.estimated}` : ''));
  const suspect = f.usage.filter((u) => u.suspect).length;
  if (suspect) out.push(fill(C.suspect, { N: suspect }));
  out.push(fill(C.rounds, { N: f.rounds.filter(GATED).length }));
  const blocked = f.rounds.filter(isBlocked);
  if (blocked.length) out.push(fill(C.blocked, { N: blocked.length, LIST: blocked.map((r) => folderPart(r.n)).join(', ') }));
  const start = f.run?.createdAt ?? f.ledger[0]?.ts ?? null;
  const end = f.ledger.length ? f.ledger[f.ledger.length - 1].ts : null;
  if (start && end) {
    const ms = Date.parse(end) - Date.parse(start);
    if (Number.isFinite(ms)) out.push(fill(C.time, { TIME: durationRu(ms) }));
  }
  out.push(f.run?.driver?.mode === 'workflow' ? C.workflow : C.agent);
  return out;
}

function toolLabel(t, A) {
  if (!t || (!t.version && !t.gitHead)) return A.unknownVersion;
  return [t.version, t.gitHead ? `сборка ${String(t.gitHead).slice(0, 7)}` : null].filter(Boolean).join(', ');
}

/**
 * The comparisons the audit could not make, in the owner's words (one line each). They are never failures
 * and never silent: «another version of the program rebuilt this report», «the report on disk is older than
 * the last events», «the report was written with another set of numbers».
 */
export function notComparedLines(a, ph = loadPhrases()) {
  const A = ph.audit;
  const out = [];
  for (const n of a?.notCompared ?? []) {
    if (n.id === 'frozen') {
      const list = (n.files ?? []).map((x) => A.files?.[x] ?? x).join('; ');
      out.push(fill(A.notCompared.toolVersion, { FROZEN: toolLabel(n.frozenTool, A), NOW: toolLabel(n.nowTool, A), LIST: list || A.unknownVersion }));
    } else if (n.id === 'report' && n.kind === 'stale') out.push(fill(A.notCompared.reportStale, { N: n.events ?? 0 }));
    else if (n.id === 'report' && n.kind === 'fields') out.push(fill(A.notCompared.reportFields, { LIST: (n.fields ?? []).join(', ') }));
  }
  return out;
}

function sectionAudit(f, ph, audit) {
  const A = ph.audit;
  const a = audit ?? f.auditFile;
  const facts = auditFacts(f, ph);
  if (!a) return [A.none, ...facts];
  const checks = a.checks ?? [];
  const unc = notComparedLines(a, ph);
  if (a.ok) {
    if (!unc.length) return [fill(A.ok, { N: checks.length }), ...facts];
    return [A.okPartial, ...unc.map((l) => `- ${l}`), ...facts];
  }
  const out = [A.failed];
  for (const c of checks.filter((x) => !x.ok)) out.push(`- ${A.checkNames?.[c.id] ?? c.id}`);
  if (unc.length) out.push('', A.notComparedHead, ...unc.map((l) => `- ${l}`));
  return [...out, ...facts];
}

/** Answers bound to the agents' codes, rejected codes, given-up jobs, interrupted commands. */
function auditFacts(f, ph) {
  const A = ph.audit;
  const ing = f.ledger.filter((e) => e.type === 'answer-ingested');
  const bound = ing.filter((e) => e.data?.boundByAgentCode).length;
  const mismatch = ing.filter((e) => (e.data?.reasons ?? []).some((x) => x === 'answer-hash-mismatch' || x === 'prompt-edited')).length;
  const givenUp = f.ledger.filter((e) => e.type === 'job-given-up').length;
  const recovered = f.ledger.filter((e) => e.type === 'guard' && e.data?.recovered).length;
  // In Agent mode the window itself relays the codes (and could compute them): say so (r2-f11).
  const out = ['', fill(f.run?.driver?.mode === 'workflow' ? A.bound : A.boundAgent, { B: bound, N: ing.length })];
  if (mismatch) out.push(fill(A.mismatch, { N: mismatch }));
  if (givenUp) out.push(fill(A.givenUp, { N: givenUp }));
  // Meta words ("honeypot", ...) that the engine found in the material or in a source output and did not count against the reviewer.
  const metaIgn = ing.filter((e) => Number(e.data?.metaIgnored) > 0);
  if (metaIgn.length) out.push(fill(A.metaIgnored, { N: metaIgn.reduce((s, e) => s + Number(e.data.metaIgnored), 0), M: metaIgn.length }));
  if (recovered) out.push(fill(A.recovered, { N: recovered }));
  // r3-f10: reviewers whose copy of the spawn message differs from the fixed call
  const echoed = ing.filter((e) => e.data?.spawnEcho);
  const differing = echoed.filter((e) => e.data.spawnEcho !== 'same');
  if (differing.length) {
    out.push(fill(A.spawnDiffers, { N: differing.length, M: echoed.length }));
    for (const e of differing) out.push(...spawnEchoLines(f, ph, e));
  }
  return out;
}

/** Collapse path separators and spaces, so «only the slashes differ» can be told from «words were added». */
function squash(x) {
  return String(x ?? '').toLowerCase().replace(/[\s\\/]+/g, '');
}

/**
 * Which reviewer, round and job had a start message that differed, and how: from the stored answer
 * (`instructionReceived`) and the call the program issued (rebuilt from the job's folder and the run's
 * frozen template). Both texts are quoted; our own line says what kind of difference it was.
 */
function spawnEchoLines(f, ph, ev) {
  const A = ph.audit;
  const r = f.rounds.find((x) => x.n === ev.round);
  const job = r?.jobs.find((j) => j.job === ev.data.job) ?? null;
  const answer = r?.answers.find((a) => a.name === ev.data.job)?.value ?? null;
  const got = typeof answer?.instructionReceived === 'string' ? answer.instructionReceived.trim() : '';
  let want = null;
  try {
    want = job?.dir ? callFor({ dir: job.dir }, f.P.templatesDir) : null;
  } catch {
    want = null;
  }
  let kind;
  if (ev.data.spawnEcho === 'missing' || !got) kind = 'missing';
  else if (want === null) kind = 'unknown';
  else if (squash(got) === squash(want)) kind = 'separators';
  else if (squash(got).includes(squash(want))) kind = 'extra';
  else kind = 'other';
  const lens = ev.data.lens ?? job?.lens ?? null;
  const head = fill(A.spawnWho, { LENS: lens ? inline(lensTitle(f, lens)) : 'без названия', R: ev.round == null ? '?' : RL(f, ev.round), JOB: code(ev.data.job ?? '?'), A: ev.data.attempt ?? job?.attempt ?? 1, WHAT: A.spawnWhat[kind] });
  const out = [`  - ${head}`];
  if (got) out.push(...quoteLines(got.slice(0, 400), `${A.spawnGot}: `).map((l) => `    ${l}`));
  if (want && kind !== 'missing') out.push(...quoteLines(want.slice(0, 400), `${A.spawnWant}: `).map((l) => `    ${l}`));
  return out;
}

// ------------------------------------------------------------------ public API

/**
 * buildReport(runDir, { dataPaths, audit, comment }) -> markdown
 *   dataPaths  data-home paths (for the cross-run block); null -> «данных пока мало»
 *   audit      audit result { ok, checks } (default: AUDIT.json of the run)
 *   comment    executor comment text (default: REPORT-COMMENT.md in the run folder, if any)
 * Throws if the generated text fails the report lint (that would be a bug).
 */
/** Longest executor comment the report shows (characters). */
export const COMMENT_MAX_CHARS = 2000;

export function buildReport(runDir, opts = {}) {
  const ph = loadPhrases();
  const f = loadRunFiles(runDir);
  f.escapes = escapesOfRun(f, opts.dataPaths ?? null);
  const S = ph.sections;
  const outcome = runOutcome(f);
  const lines = [];
  const section = (n, body) => {
    lines.push(`## ${n}. ${S[`s${n}`]}`);
    lines.push('');
    lines.push(...body);
    lines.push('');
  };
  lines.push(`# ${fill(ph.title, { RUN_ID: f.run?.runId ?? path.basename(f.P.dir) })}`);
  lines.push('');
  lines.push(ph.lensDefinition);
  lines.push('');
  const s1 = [headline(f, ph)];
  if (f.run?.ownerTarget) {
    s1.push('');
    s1.push(fill(ph.headline.ownerTarget, { TARGET: lintSafe(f.run.ownerTarget, ['R-BARE-SCORE']).replace(/[«»]/g, '"') }));
  }
  section(1, s1);
  section(2, sectionVersion(f, ph));
  section(3, sectionTask(f, ph));
  section(4, sectionIssues(f, ph, outcome));
  section(5, sectionDoubtful(f, ph));
  section(6, sectionDecisions(f, ph));
  section(7, sectionNotChecked(f, ph));
  section(8, sectionCanaries(f, ph));
  section(9, sectionLedger(f, ph, opts.dataPaths ?? null));
  section(10, sectionBand(f, ph));
  section(11, sectionRounds(f, ph));
  section(12, sectionCost(f, ph));
  section(13, sectionAudit(f, ph, opts.audit ?? null));
  const comment = opts.comment ?? f.comment;
  if (comment && String(comment).trim()) {
    // Checked like the report itself (quotes included) and capped; a comment that fails is left out
    // with a line saying so, and it is never part of the five-line summary.
    const c = String(comment);
    if (c.length > COMMENT_MAX_CHARS || lintReportText(c, { includeQuotes: true }).length) section(14, [ph.comment?.refused ?? 'Комментарий исполнителя не показан: в нём оценка или вердикт панели, либо он слишком длинный.']);
    else section(14, [ph.comment?.unchecked ?? 'Это слова исполнителя. Программа их не проверяла.', '', ...quoteLines(c)]);
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  const hits = lintReportText(text);
  if (hits.length) {
    const e = new Error(`owner report failed its own lint: ${hits.map((h) => `line ${h.line} ${h.patternId} "${h.text}"`).join('; ')}`);
    e.hits = hits;
    throw e;
  }
  return text;
}

/** «Best version» line: the round, and a caveat when not every lens of that round was fully checked. */
function bestLine(f, best, S) {
  if (!best || !best.round) {
    // Runs written before the best version counted every reviewed round never recorded one when no
    // round had all its lenses fully checked; say so instead of «no round was held».
    const reviewed = f.rounds.some((r) => GATED(r) && r.gate.perLens && Object.keys(r.gate.perLens).length);
    return reviewed ? S.noBestOldRule : S.noBest;
  }
  const pl = f.rounds.find((r) => r.n === best.round)?.gate?.perLens;
  const lensesValid = best.lensesValid ?? (pl && Object.keys(pl).length ? Object.values(pl).every((x) => x.valid) : true);
  return fill(lensesValid === false ? S.bestLensCaveat : S.best, { R: RL(f, best.round) });
}

function attentionLine(att, S) {
  if (!att) return 'Проверка внимания: кругов с проверкой ещё не было.';
  const rejected = att.rejected.map(inline).join(', ');
  if (att.failing.length) {
    const base = `Проверка внимания: не пройдена (проверяющие по темам: ${att.failing.map(inline).join(', ')}).`;
    return att.rejected.length ? `${base} ${fill(S.attentionRejectedMore, { LIST: rejected })}` : base;
  }
  if (att.rejected.length) return fill(S.attentionRejectedOnly, { LIST: rejected });
  return 'Проверка внимания: пройдена.';
}

/**
 * The plain-Russian lines of `report --summary` (SPEC 16.3): five fixed lines, plus a line for
 * each caveat that applies (a bench run, the owner's exceptions, looser limits, answers without
 * an agent code) and always the audit result. opts.audit: { ok, checks } (default AUDIT.json).
 */
export function summaryLines(runDir, opts = {}) {
  const ph = loadPhrases();
  const f = loadRunFiles(runDir);
  f.escapes = escapesOfRun(f, opts.dataPaths ?? null);
  const S = ph.summary;
  const open = openCounts(f);
  const best = f.best ?? f.state?.best ?? null;
  const att = attentionStatus(f);
  const extra = [];
  const blockedAttempts = f.rounds.filter(isBlocked);
  if (blockedAttempts.length) extra.push(fill(S.blockedAttempts, { N: blockedAttempts.length }));
  if (f.run?.canaries?.fixedKey) extra.push(S.bench);
  const x = ownerExceptions(f);
  if (x.waivedSerious || x.decisions || x.requirementCuts) {
    const q = x.firstQuote ? ` ${fill(S.firstQuote, { Q: lintSafe(x.firstQuote).replace(/[«»]/g, '"').slice(0, 160) })}` : '';
    extra.push(fill(S.exceptions, { N: x.waivedSerious, D: x.decisions, K: x.requirementCuts }) + q);
  }
  const qf = ownerQuoteFlags(f);
  if (qf.reuse.length || qf.predates.length) extra.push(fill(S.quoteFlags, { R: qf.reuse.length, P: qf.predates.length }));
  const init = f.ledger.find((e) => e.type === 'init');
  const carried = (init?.data?.earlierRuns ?? []).reduce((s, e) => s + (e.openSerious ?? []).length, 0);
  if (carried) extra.push(fill(S.earlier, { N: carried, R: (init.data.earlierRuns ?? []).filter((e) => (e.openSerious ?? []).length).length }));
  if (x.looseLimits.length) extra.push(fill(S.looseLimits, { LIST: x.looseLimits.map((l) => `${LIMIT_RU[l.key] ?? l.key} ${l.value} (обычно ${l.default})`).join(', ') }));
  const ing = f.ledger.filter((e) => e.type === 'answer-ingested');
  const unbound = ing.filter((e) => !e.data?.boundByAgentCode).length;
  if (unbound) extra.push(fill(S.unbound, { U: unbound, N: ing.length }));
  const rejected = ing.filter((e) => e.data && e.data.kept === false).length + f.ledger.filter((e) => e.type === 'job-given-up').length;
  if (rejected) extra.push(fill(S.rejected, { N: rejected }));
  const dx = decoyFacts(f);
  if (dx && dx.confirmed) extra.push(fill(S.decoyConfirmed, { N: dx.confirmed, M: dx.answered }));
  const cx = controlFacts(f);
  if (cx && cx.dismissed + cx.downgraded) extra.push(fill(S.controlDismissed, { N: cx.dismissed + cx.downgraded, M: cx.answered }));
  const confirm = [...f.rounds].reverse().find((r) => r.gate?.kind === 'confirm');
  const confirmEx = confirm?.copy?.stripExcluded ?? [];
  if (confirmEx.length) extra.push(fill(S.confirmExcluded, { N: confirmEx.length, R: RL(f, confirm.n) }));
  if (confirm && (confirm.canaries ?? []).length && !hasOmissionCanary(confirm)) extra.push(fill(S.confirmNoOmission, { R: RL(f, confirm.n) }));
  const bigOnes = [...f.rounds].reverse().find((r) => r.sample?.unsampled?.length && r.answers.some((a) => isReviewerAnswer(r, a)));
  if (bigOnes) extra.push(fill(S.unsampled, { K: bigOnes.sample.unsampled.length, R: RL(f, bigOnes.n), FILE: code(bigOnes.sample.unsampled[0].file) }));
  const sampled = [...f.rounds].reverse().find((r) => r.sample?.files?.length && r.answers.some((a) => isReviewerAnswer(r, a)));
  if (sampled) {
    const e = sampled.sample.files[0];
    extra.push(fill(S.sample, { K: sampled.sample.files.length, R: RL(f, sampled.n), FILE: code(e.file), N: e.chosen.length, M: e.rows }));
  }
  const a = opts.audit ?? f.auditFile;
  if (!a) extra.push(S.auditNone);
  else {
    const unc = notComparedLines(a, ph);
    if (a.ok) extra.push(unc.length ? S.auditOkPartial : S.auditOk);
    else extra.push(fill(S.auditFailed, { LIST: (a.checks ?? []).filter((c) => !c.ok).map((c) => ph.audit.checkNames?.[c.id] ?? c.id).join('; ') }));
    extra.push(...unc);
  }
  return [
    headline(f, ph),
    `Открытых подтверждённых проблем: блокеров ${open.blocker}, существенных ${open.major}.`,
    bestLine(f, best, S),
    attentionLine(att, S),
    ...extra,
    `Отчёт: ${f.P.report}`,
  ];
}
