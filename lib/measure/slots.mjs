// Canary slot planning (SPEC 14.2). Pure code: the script chooses type, target lens,
// band and severity floor of every planted error; the planter only fills slots.
//
// Every choice is a deterministic function of the inputs and a fresh seed. The seed
// is committed (seedCommitment = sha256(seedHex)) when slots.json is written and
// revealed in the canary key, so an audit can replay the plan.
//
// Ordering used when several types fit a slot (builder's choice, documented):
//   1. in a confirm round, types used in the candidate round go last;
//   2. types already used in this round go last (spread of types inside one copy);
//   3. fewest ledger canaries of that type for (artifactType, instrumentId), plus the
//      number of times the type was used earlier in this run;
//   4. ties broken by sha256(seedHex + label).

import { sha256Hex } from '../core/hash.mjs';
import { UsageError } from '../core/errors.mjs';
import { typeUsable, attentionEligible } from './taxonomy.mjs';

export const BANDS = Object.freeze({
  start: [0, 1 / 3],
  middle: [1 / 3, 2 / 3],
  end: [2 / 3, 1],
});
export const BAND_ORDER = Object.freeze(['start', 'middle', 'end']);

export const CANARY_DEFAULTS = Object.freeze({
  attentionPerLens: 1,
  measurementWorking: 1,
  measurementConfirm: 2,
  candidatesPerSlot: 2,
  maxEditChars: 240,
  minDistanceChars: 400,
  visualAllowed: false,
});

/** Ledger omission canaries needed before measurement slots stop preferring omission types. */
export const OMISSION_PREFERENCE_UNTIL = 10;

export function canarySettings(run) {
  return { ...CANARY_DEFAULTS, ...(run?.canaries ?? {}) };
}

/** Band name for a position fraction in [0, 1]. */
export function bandOf(fraction) {
  if (typeof fraction !== 'number' || Number.isNaN(fraction)) return null;
  if (fraction < BANDS.start[1]) return 'start';
  if (fraction < BANDS.middle[1]) return 'middle';
  return 'end';
}

function tie(seedHex, label) {
  return sha256Hex(`${seedHex}\0${label}`);
}

function cmpKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function bestBy(items, keyOf) {
  let best = null;
  let bestKey = null;
  for (const it of items) {
    const k = keyOf(it);
    if (best === null || cmpKeys(k, bestKey) < 0) {
      best = it;
      bestKey = k;
    }
  }
  return best;
}

function freshSeedHex(rng) {
  if (rng && typeof rng.bytes === 'function') {
    const b = rng.bytes(16);
    return Buffer.from(b).toString('hex');
  }
  if (rng && typeof rng.seedHex === 'string') return sha256Hex(`slots\0${rng.seedHex}`).slice(0, 32);
  throw new UsageError('planSlots needs an rng with bytes(n)');
}

/**
 * planSlots({ lenses, taxonomy, positionIndex, ledgerCounts, run, roundKind, usedThisRun, rng, candidateRound? })
 *   -> { seedCommitment, seedHex, slots: [slot], unguarded: [lensId] }
 *
 * lenses        lenses.json `lenses` (order is kept; generalist included when present)
 * taxonomy      loadTaxonomy() result
 * positionIndex P2 positionIndex(copyDir, readingOrder) or null; when it reports 0 text
 *               characters only types that need a rebuild remain possible
 * ledgerCounts  mledger.ledgerCounts(...) -> { byType, byBand, omission } (may be null)
 * run           run.json (canaries settings, rebuild)
 * roundKind     'working' | 'confirm'
 * usedThisRun   slots of earlier rounds of this run: [{ round, type, band, purpose, targetLens }]
 * candidateRound  round number of the candidate (confirm rounds); default: latest round in usedThisRun
 * seedHex       optional: replay a plan from a revealed seed (audit, tests)
 */
export function planSlots(input) {
  const { lenses, taxonomy, positionIndex = null, ledgerCounts = null, run = {}, roundKind = 'working' } = input;
  if (!Array.isArray(lenses) || lenses.length === 0) throw new UsageError('planSlots: lenses must be a non-empty array');
  if (!taxonomy || typeof taxonomy.byId !== 'function') throw new UsageError('planSlots: taxonomy must come from loadTaxonomy()');
  if (roundKind !== 'working' && roundKind !== 'confirm') throw new UsageError(`planSlots: bad roundKind ${roundKind}`);
  const usedThisRun = Array.isArray(input.usedThisRun) ? input.usedThisRun : [];
  const settings = canarySettings(run);
  const seedHex = input.seedHex ? String(input.seedHex).toLowerCase() : freshSeedHex(input.rng);
  const seedCommitment = sha256Hex(seedHex);

  const usable = { visualAllowed: Boolean(settings.visualAllowed), hasRebuild: Boolean(run.rebuild) };
  const noText = positionIndex && typeof positionIndex.totalChars === 'number' && positionIndex.totalChars === 0;
  const typeOk = (t) => typeUsable(t, usable) && (!noText || t.needsRebuild);

  const ledgerByType = ledgerCounts?.byType ?? {};
  const ledgerByBand = ledgerCounts?.byBand ?? {};
  const ledgerOmission = Number(ledgerCounts?.omission ?? 0);

  const usedType = {};
  const usedBand = {};
  for (const s of usedThisRun) {
    if (s?.type) usedType[s.type] = (usedType[s.type] ?? 0) + 1;
    if (s?.band) usedBand[s.band] = (usedBand[s.band] ?? 0) + 1;
  }
  let candidateRound = input.candidateRound ?? null;
  if (roundKind === 'confirm' && candidateRound === null && usedThisRun.length) {
    candidateRound = Math.max(...usedThisRun.map((s) => Number(s.round) || 0));
  }
  const candidateSlots = roundKind === 'confirm' ? usedThisRun.filter((s) => Number(s.round) === Number(candidateRound)) : [];
  const candidateTypes = new Set(candidateSlots.map((s) => s.type));

  const roundType = {};
  const typeKey = (typeId, label) => [
    candidateTypes.has(typeId) ? 1 : 0,
    roundType[typeId] ?? 0,
    (Number(ledgerByType[typeId]) || 0) + (usedType[typeId] ?? 0),
    tie(seedHex, `${label}:${typeId}`),
  ];

  const draft = [];
  const unguarded = [];

  // 1. Attention slots: one per lens.
  const perLens = Math.max(0, Number(settings.attentionPerLens) || 0);
  for (const lens of lenses) {
    const eligible = (lens.canaryTypes ?? [])
      .map((id) => taxonomy.byId(id))
      .filter((t) => t && attentionEligible(t, lens, usable) && typeOk(t));
    if (perLens === 0 || eligible.length === 0) {
      unguarded.push(lens.id);
      continue;
    }
    for (let k = 0; k < perLens; k++) {
      const t = bestBy(eligible, (x) => typeKey(x.id, `attention:${lens.id}:${k}`));
      roundType[t.id] = (roundType[t.id] ?? 0) + 1;
      draft.push({ purpose: 'attention', targetLens: lens.id, type: t.id, floor: t.defaultFloor });
    }
  }

  // 2. Measurement slots.
  const allUsable = taxonomy.types.filter(typeOk);
  const omissionUsable = allUsable.filter((t) => t.omission);
  let nMeasure = Math.max(0, Number(roundKind === 'confirm' ? settings.measurementConfirm : settings.measurementWorking) || 0);
  const hasOmission = () => draft.some((s) => taxonomy.byId(s.type)?.omission);
  // At least one omission slot per round (SPEC 14.2, side note): add one if none is configured.
  if (nMeasure === 0 && !hasOmission() && omissionUsable.length) nMeasure = 1;
  const roundTarget = {};
  for (let i = 0; i < nMeasure; i++) {
    let pool;
    if (!hasOmission() && omissionUsable.length) pool = omissionUsable;
    else if (ledgerOmission < OMISSION_PREFERENCE_UNTIL && omissionUsable.length) pool = omissionUsable;
    else pool = allUsable;
    if (pool.length === 0) break;
    const t = bestBy(pool, (x) => typeKey(x.id, `measurement:${i}`));
    roundType[t.id] = (roundType[t.id] ?? 0) + 1;
    const owners = lenses.filter((l) => (l.canaryTypes ?? []).includes(t.id));
    let targetLens = null;
    if (owners.length) {
      const o = bestBy(owners, (l) => [roundTarget[l.id] ?? 0, tie(seedHex, `target:${i}:${l.id}`)]);
      targetLens = o.id;
      roundTarget[o.id] = (roundTarget[o.id] ?? 0) + 1;
    }
    draft.push({ purpose: 'measurement', targetLens, type: t.id, floor: t.defaultFloor });
  }

  // 3. Bands: no two slots share a band while there are 3 or fewer; otherwise spread
  //    evenly; then balance the ledger's band counts for this artifact type. In a
  //    confirm round a lens avoids the band its canary had in the candidate round.
  const roundBand = {};
  const slots = draft.map((d, idx) => {
    const slotId = `S${idx + 1}`;
    const candBand = candidateSlots.find((s) => s.purpose === d.purpose && s.targetLens === d.targetLens)?.band ?? null;
    const band = bestBy(BAND_ORDER, (b) => [
      roundBand[b] ?? 0,
      roundKind === 'confirm' && candBand === b ? 1 : 0,
      (Number(ledgerByBand[b]) || 0) + (usedBand[b] ?? 0),
      tie(seedHex, `band:${slotId}:${b}`),
    ]);
    roundBand[band] = (roundBand[band] ?? 0) + 1;
    return {
      slot: slotId,
      purpose: d.purpose,
      targetLens: d.targetLens,
      type: d.type,
      band,
      range: [BANDS[band][0], BANDS[band][1]],
      severityFloor: d.floor,
    };
  });

  return { seedCommitment, seedHex, slots, unguarded };
}

/** slots.json content for a plan (SPEC 9.10). */
export function slotsFile(plan) {
  return { schemaVersion: 1, seedCommitment: plan.seedCommitment, slots: plan.slots };
}
