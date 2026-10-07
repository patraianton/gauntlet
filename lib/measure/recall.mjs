// Statistics over the measurement ledger (SPEC 14.8): `ledger stats`, STATS.md / STATS.json,
// and the cross-run block of the owner report.
//
// Units: own-lens recall and panel recall count CANARIES (one planted error = one unit);
// pair recall counts (reviewer x canary) cells and is diagnostic only (cells of one
// canary are not independent, so no interval is printed for them).
// Every proportion with n >= 10 carries a two-sided 95 % Clopper-Pearson interval and a
// one-sided 95 % lower bound; below that it is marked "insufficient".
// Contaminated legacy rows are kept out of every number except their own table.

import { readLedger } from './mledger.mjs';
import { proportion, formatEn, HEADLINE_N, MIN_N_FOR_INTERVAL } from './stats.mjs';
import { now } from '../core/clock.mjs';

const SEV = { cosmetic: 0, major: 1, blocker: 2 };
const rank = (s) => (s in SEV ? SEV[s] : -1);

const ckey = (r) => `${r.runId}|${r.round}|${r.canary}`;

function lensIdOf(t) {
  if (!t) return null;
  return typeof t === 'string' ? t : t.id ?? null;
}

function lensTitleOf(t) {
  if (!t) return '(none)';
  if (typeof t === 'string') return t;
  return t.title || t.id || '(none)';
}

function inc(map, key, caught) {
  const k = key ?? '(unknown)';
  if (!map[k]) map[k] = { k: 0, n: 0 };
  map[k].n++;
  if (caught) map[k].k++;
}

function finishSplit(map) {
  const out = {};
  for (const [name, v] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) out[name] = proportion(v.k, v.n);
  return out;
}

function pairOnly(k, n) {
  return { k, n, rate: n ? k / n : null, ci: null, lower: null, sufficient: false, note: 'pairs are not independent; no interval' };
}

/** Core computation over already-filtered, uncontaminated rows. */
export function computeBlock({ canaries, detections, verdicts, escapes, runs, decoys = [], controls = [] }) {
  const det = new Map();
  for (const d of detections) {
    const k = ckey(d);
    if (!det.has(k)) det.set(k, []);
    det.get(k).push(d);
  }

  // 1. Own-lens recall (attention canaries, target lens, first attempt).
  let ownK = 0;
  let ownN = 0;
  let rerunK = 0;
  let rerunN = 0;
  const split = { lens: {}, type: {}, band: {}, artifactType: {}, reviewerModel: {} };
  // 2. Panel recall.
  const panel = { all: { k: 0, n: 0 }, attention: { k: 0, n: 0 }, measurement: { k: 0, n: 0 }, omission: { k: 0, n: 0 } };
  // 5. Unanimous miss.
  let unanimousK = 0;
  let unanimousN = 0;
  const unanimousList = [];

  for (const c of canaries) {
    const rows = det.get(ckey(c)) ?? [];
    const target = lensIdOf(c.targetLens);
    if (c.purpose === 'attention') {
      const first = rows.filter((r) => r.lens === target && (r.attempt ?? 1) === 1);
      const caught = first.some((r) => r.outcome === 'caught');
      ownN++;
      if (caught) ownK++;
      inc(split.lens, lensTitleOf(c.targetLens), caught);
      inc(split.type, c.type, caught);
      inc(split.band, c.band ?? '(none)', caught);
      inc(split.artifactType, c.artifactType, caught);
      inc(split.reviewerModel, first[0]?.reviewerModel ?? '(no answer)', caught);
      const reruns = rows.filter((r) => r.lens === target && (r.attempt ?? 1) > 1);
      if (reruns.length) {
        rerunN++;
        if (reruns.some((r) => r.outcome === 'caught')) rerunK++;
      }
    }
    const anyCaught = rows.some((r) => r.outcome === 'caught');
    panel.all.n++;
    if (anyCaught) panel.all.k++;
    const p = c.purpose === 'attention' ? panel.attention : panel.measurement;
    p.n++;
    if (anyCaught) p.k++;
    if (c.omission) {
      panel.omission.n++;
      if (anyCaught) panel.omission.k++;
    }
    if (rows.length) {
      unanimousN++;
      if (rows.every((r) => r.outcome === 'missed')) {
        unanimousK++;
        unanimousList.push({ runId: c.runId, round: c.round, canary: c.canary, type: c.type, description: c.description ?? '' });
      }
    }
  }

  // 3. Pair recall, 4. knows-but-passes (pair level, diagnostic).
  let pairsCaught = 0;
  let pairsUnder = 0;
  for (const d of detections) {
    if (d.outcome === 'caught') pairsCaught++;
    else if (d.outcome === 'seen_underclassified') pairsUnder++;
  }

  // 6. Verifier rejection and downgrade.
  const submitted = verdicts.filter((v) => v.claimedSeverity === 'blocker' || v.claimedSeverity === 'major');
  const dropped = submitted.filter((v) => v.finalStatus === 'dropped').length;
  const classed = submitted.filter((v) => v.finalSeverity);
  const downgraded = classed.filter((v) => rank(v.finalSeverity) < rank(v.claimedSeverity)).length;

  // 6b. Decoys (SPEC 14.11): false findings shown to verifiers. Unit = one decoy shown to one verifier
  // job that answered. "Rejected" = the verifier refuted it; the rest accepted it or could not decide.
  const decoyAnswered = decoys.filter((d) => d.outcome !== 'no-answer');
  const decoyRejected = decoyAnswered.filter((d) => d.outcome === 'rejected').length;
  const decoyConfirmed = decoyAnswered.filter((d) => d.outcome === 'confirmed').length;

  // 6c. True controls (SPEC 14.12): real, planted defects shown to verifiers. Unit = one control shown to one
  // verifier job that answered. "Dismissed" = refuted; "downgraded" = confirmed below the planted class.
  const controlAnswered = controls.filter((d) => d.outcome !== 'no-answer');
  const controlDismissed = controlAnswered.filter((d) => d.outcome === 'dismissed').length;
  const controlDowngraded = controlAnswered.filter((d) => d.outcome === 'downgraded').length;

  // 7. Escapes.
  const esc = { total: escapes.length, bySeverity: {}, byLens: {} };
  for (const e of escapes) {
    esc.bySeverity[e.severity] = (esc.bySeverity[e.severity] ?? 0) + 1;
    const l = e.lens ?? 'none';
    esc.byLens[l] = (esc.byLens[l] ?? 0) + 1;
  }

  const runIds = new Set([...canaries.map((c) => c.runId), ...runs.map((r) => r.runId)]);
  return {
    runs: runIds.size,
    canaries: canaries.length,
    seededCanaries: canaries.filter((c) => c.seeded).length,
    ownLens: proportion(ownK, ownN),
    ownLensHeadline: ownN >= HEADLINE_N ? null : `insufficient data (${ownN} of ${HEADLINE_N})`,
    ownLensReruns: proportion(rerunK, rerunN),
    ownLensBy: {
      lens: finishSplit(split.lens),
      type: finishSplit(split.type),
      band: finishSplit(split.band),
      artifactType: finishSplit(split.artifactType),
      reviewerModel: finishSplit(split.reviewerModel),
    },
    panel: {
      all: proportion(panel.all.k, panel.all.n),
      attention: proportion(panel.attention.k, panel.attention.n),
      measurement: proportion(panel.measurement.k, panel.measurement.n),
    },
    omission: panel.omission.n ? proportion(panel.omission.k, panel.omission.n) : null,
    pairs: pairOnly(pairsCaught, detections.length),
    knowsButPasses: pairOnly(pairsUnder, pairsCaught + pairsUnder),
    unanimousMiss: proportion(unanimousK, unanimousN),
    unanimousMissed: unanimousList,
    verifierRejection: proportion(dropped, submitted.length),
    verifierDowngrade: proportion(downgraded, classed.length),
    decoyRejection: proportion(decoyRejected, decoyAnswered.length),
    decoyConfirmed: proportion(decoyConfirmed, decoyAnswered.length),
    controlDismissed: proportion(controlDismissed, controlAnswered.length),
    controlDowngraded: proportion(controlDowngraded, controlAnswered.length),
    escapes: esc,
  };
}

function legacyTable(all) {
  const runs = all.runs.filter((r) => r.contaminated);
  const out = [];
  for (const r of runs) {
    const rows = all.detections.filter((d) => d.contaminated && d.runId === r.runId);
    const dets = rows.filter((d) => !d.unit);
    const agg = rows.filter((d) => d.unit);
    const cans = all.canaries.filter((c) => c.contaminated && c.runId === r.runId);
    let pairs;
    if (r.fullMatrix) {
      // Legacy prompts used other severity words; "found at any severity" is what the sources report.
      pairs = { k: dets.filter((d) => d.outcome !== 'missed').length, n: dets.length };
    } else {
      const pa = agg.filter((a) => a.unit === 'pair');
      pairs = { k: pa.reduce((s, a) => s + a.k, 0), n: pa.reduce((s, a) => s + a.n, 0) };
    }
    let own;
    const ownRows = cans
      .filter((c) => c.purpose === 'attention')
      .map((c) => dets.filter((d) => d.canary === c.canary && d.lens === lensIdOf(c.targetLens) && (d.attempt ?? 1) === 1));
    if (ownRows.length && ownRows.every((x) => x.length)) {
      own = { k: ownRows.filter((x) => x.some((d) => d.outcome === 'caught')).length, n: ownRows.length };
    } else {
      const oa = agg.filter((a) => a.unit === 'own-lens');
      own = { k: oa.reduce((s, a) => s + a.k, 0), n: oa.reduce((s, a) => s + a.n, 0) };
    }
    out.push({
      runId: r.runId,
      legacyId: r.legacyId ?? null,
      instrumentId: r.instrumentId ?? null,
      label: r.label ?? r.runId,
      pairs: pairOnly(pairs.k, pairs.n),
      ownLens: proportion(own.k, own.n),
      omission: 'no data',
    });
  }
  return out;
}

/**
 * computeStats(dataPaths, { instrumentId?, artifactType? }) -> stats
 *   { generatedAt, filters, instruments: { <id>: block }, pooled: block|null, legacy: [...] }
 */
export function computeStats(dp, filters = {}) {
  const all = readLedger(dp);
  const clean = (rows) =>
    rows.filter(
      (r) =>
        !r.contaminated &&
        (!filters.artifactType || r.artifactType === filters.artifactType) &&
        (!filters.instrumentId || r.instrumentId === filters.instrumentId),
    );
  const canaries = clean(all.canaries);
  const detections = clean(all.detections);
  const verdicts = clean(all.verdicts);
  const decoys = clean(all.decoys ?? []);
  const controls = clean(all.controls ?? []);
  const runs = clean(all.runs);

  // Escapes carry a runId only; map it to the run's instrument and artifact type.
  const runInfo = new Map();
  for (const r of [...all.runs, ...all.canaries]) {
    if (r.runId && !runInfo.has(r.runId)) runInfo.set(r.runId, { instrumentId: r.instrumentId, artifactType: r.artifactType });
  }
  const escapes = all.escapes.filter((e) => {
    if (e.contaminated) return false;
    const info = runInfo.get(e.runId) ?? {};
    if (filters.instrumentId && info.instrumentId !== filters.instrumentId) return false;
    if (filters.artifactType && info.artifactType !== filters.artifactType) return false;
    return true;
  });

  const ids = [...new Set([...canaries, ...detections, ...verdicts, ...decoys, ...controls, ...runs].map((r) => r.instrumentId ?? '(none)'))].sort();
  const instruments = {};
  for (const id of ids) {
    const pick = (rows) => rows.filter((r) => (r.instrumentId ?? '(none)') === id);
    const runIdsOf = new Set(pick(runs).map((r) => r.runId).concat(pick(canaries).map((c) => c.runId)));
    instruments[id] = computeBlock({
      canaries: pick(canaries),
      detections: pick(detections),
      verdicts: pick(verdicts),
      decoys: pick(decoys),
      controls: pick(controls),
      escapes: escapes.filter((e) => runIdsOf.has(e.runId)),
      runs: pick(runs),
    });
  }
  const pooled = ids.length > 1 ? computeBlock({ canaries, detections, verdicts, escapes, runs, decoys, controls }) : null;
  return {
    schemaVersion: 1,
    generatedAt: now(),
    filters: { instrumentId: filters.instrumentId ?? null, artifactType: filters.artifactType ?? null },
    minNForInterval: MIN_N_FOR_INTERVAL,
    headlineN: HEADLINE_N,
    instruments,
    pooled,
    legacy: legacyTable(all),
  };
}

/** The cross-run block the owner report needs for one instrument. */
export function statsForRun(dp, instrumentId) {
  const s = computeStats(dp, { instrumentId });
  const b = s.instruments[instrumentId ?? '(none)'] ?? null;
  const n = b?.ownLens?.n ?? 0;
  return {
    instrumentId: instrumentId ?? null,
    headlineN: HEADLINE_N,
    enough: n >= HEADLINE_N,
    ownLens: b?.ownLens ?? { k: 0, n: 0, rate: null, ci: null, lower: null, sufficient: false },
    panel: b?.panel?.all ?? null,
    omission: b?.omission ?? null,
    unanimousMiss: b?.unanimousMiss ?? null,
    decoyRejection: b?.decoyRejection ?? null,
    decoyConfirmed: b?.decoyConfirmed ?? null,
    controlDismissed: b?.controlDismissed ?? null,
    controlDowngraded: b?.controlDowngraded ?? null,
    runs: b?.runs ?? 0,
  };
}

// ------------------------------------------------------------------ markdown

function splitTable(title, split) {
  const names = Object.keys(split);
  if (!names.length) return `${title}: no data\n`;
  let s = `| ${title} | own-lens recall |\n|---|---|\n`;
  for (const n of names) s += `| ${n.replace(/\|/g, '/')} | ${formatEn(split[n])} |\n`;
  return s;
}

function pairText(p) {
  return `${p.k}/${p.n} (pairs are not independent; no interval)`;
}

function block(b) {
  const lines = [];
  lines.push(`Runs: ${b.runs}. Canaries: ${b.canaries}${b.seededCanaries ? ` (${b.seededCanaries} from seeded test runs)` : ''}.`);
  lines.push('');
  lines.push(`**Headline own-lens recall:** ${b.ownLensHeadline ?? formatEn(b.ownLens)}`);
  lines.push('');
  lines.push('| Measure | Value |');
  lines.push('|---|---|');
  lines.push(`| Own-lens recall (attention canary caught by its own lens, first attempt) | ${formatEn(b.ownLens)} |`);
  lines.push(`| Own-lens recall on reruns | ${formatEn(b.ownLensReruns)} |`);
  lines.push(`| Panel recall, all canaries | ${formatEn(b.panel.all)} |`);
  lines.push(`| Panel recall, attention canaries | ${formatEn(b.panel.attention)} |`);
  lines.push(`| Panel recall, measurement canaries | ${formatEn(b.panel.measurement)} |`);
  lines.push(`| Omission recall | ${b.omission ? formatEn(b.omission) : 'no data'} |`);
  lines.push(`| Pair recall (reviewer x canary, diagnostic) | ${pairText(b.pairs)} |`);
  lines.push(`| Knows-but-passes (seen but under-classified) | ${pairText(b.knowsButPasses)} |`);
  lines.push(`| Unanimous miss (no reviewer of the round saw it) | ${formatEn(b.unanimousMiss)} |`);
  lines.push(`| Verifier rejection (dropped / submitted blocker+major) | ${formatEn(b.verifierRejection)} |`);
  lines.push(`| Verifier downgrade (final class below claimed) | ${formatEn(b.verifierDowngrade)} |`);
  lines.push(`| Decoys rejected (false findings refuted by the verifier / shown to it) | ${formatEn(b.decoyRejection)} |`);
  lines.push(`| Decoys confirmed (false findings the verifier accepted) | ${formatEn(b.decoyConfirmed)} |`);
  lines.push(`| True controls dismissed (planted real defects the verifier refuted / shown to it) | ${formatEn(b.controlDismissed)} |`);
  lines.push(`| True controls downgraded (planted real defects confirmed below the planted class) | ${formatEn(b.controlDowngraded)} |`);
  const es = b.escapes;
  const bySev = Object.entries(es.bySeverity).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const byLens = Object.entries(es.byLens).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  lines.push(`| Escapes (real problems found after done) | ${es.total} (by severity: ${bySev}; by lens: ${byLens}) |`);
  lines.push('');
  lines.push(splitTable('Lens', b.ownLensBy.lens));
  lines.push(splitTable('Canary type', b.ownLensBy.type));
  lines.push(splitTable('Band', b.ownLensBy.band));
  lines.push(splitTable('Artifact type', b.ownLensBy.artifactType));
  lines.push(splitTable('Reviewer model', b.ownLensBy.reviewerModel));
  return lines.join('\n');
}

/** STATS.md (English). */
export function renderStatsMd(stats) {
  const out = [];
  out.push('# gauntlet measurement ledger');
  out.push('');
  out.push(`Generated ${stats.generatedAt}.${stats.filters.instrumentId ? ` Instrument filter: ${stats.filters.instrumentId}.` : ''}${stats.filters.artifactType ? ` Artifact type filter: ${stats.filters.artifactType}.` : ''}`);
  out.push('');
  out.push(
    `Read this first: planted errors are easier to find than real ones, so real recall is lower than these numbers. Reviewers are worst at noticing that something required is missing. A cell with fewer than ${stats.minNForInterval} units is marked "insufficient"; intervals are exact 95% Clopper-Pearson; the headline waits for ${stats.headlineN} attention canaries.`,
  );
  out.push('');
  const ids = Object.keys(stats.instruments);
  if (!ids.length) out.push('No measured runs yet (insufficient data (0 of 25)).\n');
  for (const id of ids) {
    out.push(`## Instrument ${id}`);
    out.push('');
    out.push(block(stats.instruments[id]));
    out.push('');
  }
  if (stats.pooled) {
    out.push('## Pooled view (all instruments together)');
    out.push('');
    out.push('Warning: different instruments (templates, lenses) are mixed here; read the per-instrument sections first.');
    out.push('');
    out.push(block(stats.pooled));
    out.push('');
  }
  out.push('## Legacy data (contaminated)');
  out.push('');
  if (!stats.legacy.length) out.push('No legacy rows imported.');
  else {
    out.push('Imported by hand from the 2026-10-05 experiments. The person who planted these errors also wrote the checklists, so the numbers are optimistic and are kept out of every figure above. Omission recall: no data (no omission canaries were planted).');
    out.push('');
    out.push('| Legacy run | Instrument | Pairs found (any severity) | Own-lens caught |');
    out.push('|---|---|---|---|');
    for (const l of stats.legacy) out.push(`| ${l.label} | ${l.instrumentId ?? ''} | ${pairText(l.pairs)} | ${formatEn(l.ownLens)} |`);
  }
  out.push('');
  return out.join('\n');
}
