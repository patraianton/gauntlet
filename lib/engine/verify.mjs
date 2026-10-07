// Verifier items and the class rule (SPEC 12.6). Pure: no I/O; randomness comes from the passed rng.
//
// A verifier sees: item id, file, locator, the representative quote (or "missing: ..." / "visible: ..."),
// and a one-sentence claim. It never sees the reviewer's severity, lens, fix, origin, number of finders,
// or whether the item is new (old items are mixed in unlabeled, D4).

import { SEVERITY_RANK, minSeverity, maxSeverity } from './cluster.mjs';

export const OPEN_SET = Object.freeze(['open', 'unverified', 'contested']);

const SERIOUS = ['blocker', 'major'];

function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Which clusters must be verified this round. */
export function selectForVerification(clusters, { versionHash }) {
  const verify = [];
  const cosmeticOnly = [];
  for (const c of clusters || []) {
    if (c.status === 'pending') {
      if (SERIOUS.includes(c.claimedSeverity)) verify.push(c.id);
      else cosmeticOnly.push(c.id);
    } else if (OPEN_SET.includes(c.status) && !c.waived && c.verifiedOn !== versionHash) {
      verify.push(c.id); // carry-over on a changed version (D5)
    }
  }
  return { verify, cosmeticOnly };
}

/** What a verifier is shown for one cluster. */
export function itemView(c) {
  let shown;
  if (c.origin === 'requirement' || (c.kind === 'omission' && !c.quote)) shown = `missing: ${cut(c.missingWhat || c.problem, 400)}`;
  else if (c.kind === 'visual' && !c.quote) shown = `visible: ${cut(c.seen || c.problem, 400)}`;
  else shown = c.quote == null ? '' : String(c.quote);
  return {
    file: c.file || null,
    locator: c.locator || '',
    shown,
    claim: cut(c.problem, 300),
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Batch layout of one pass with extra items: [[id, ...], ...] (real ids, control ids and decoy ids; the
 * extras placed at random). Batch sizes differ by at most one and none exceeds batchMax; the extras are
 * spread over as many different batches as there are extras (round-robin over a shuffled batch order,
 * controls first, then decoys carrying on from where the controls stopped), so a verifier with a decoy or
 * a control in its batch is a test of that verifier.
 */
function layoutWithExtras(order, controlIds, decoyIds, batchMax, rng) {
  const total = order.length + controlIds.length + decoyIds.length;
  const nB = Math.max(1, Math.ceil(total / Math.max(1, batchMax)));
  const sizes = Array.from({ length: nB }, (_, b) => Math.floor(total / nB) + (b < total % nB ? 1 : 0));
  const shuffle = (a) => (rng && typeof rng.shuffle === 'function' ? rng.shuffle([...a]) : [...a]);
  const perm = shuffle(Array.from({ length: nB }, (_, b) => b));
  const mine = Array.from({ length: nB }, () => []);
  const extras = [...(controlIds.length ? shuffle(controlIds) : []), ...shuffle(decoyIds)];
  extras.forEach((d, k) => mine[perm[k % nB]].push(d));
  const out = [];
  let at = 0;
  for (let b = 0; b < nB; b++) {
    const room = Math.max(0, sizes[b] - mine[b].length);
    const real = order.slice(at, at + room);
    at += room;
    out.push(shuffle([...real, ...mine[b]]));
  }
  // anything left over (extras filled a batch beyond its share) goes to the last batch
  if (at < order.length) out[nB - 1].push(...order.slice(at));
  return out;
}

/**
 * buildItems(clusters, { roundKind, versionHash, rng, batchMax, only?, pass?, decoys? }) -> { items, batches, hiddenMap, decoyItems, controlItems }
 *  Working round: one pass (pass 1, or pass 2 when `only` lists clusters for the second verifier).
 *  Confirm round: two passes over every item, different shuffles, so each item lands in two batches.
 *  items:   [{ item: 'V3', pass, cluster, file, locator, shown, claim }]
 *  batches: [{ pass, items: ['V1', ...] }]
 *  hiddenMap: { '<pass>:<item>': clusterId }
 *  decoys: [{ id, decoy, file, locator, shown, claim }] false items mixed into every pass; `id` stands
 *    in for the cluster id (it has the format of one but names no cluster). Items of the same shape with
 *    `control` (a key like "K1") instead of `decoy` are true controls: real defects that the program planted
 *    itself (SPEC 14.12). Without either the layout is exactly the plain chunking of the shuffled ids.
 *  decoyItems: [{ pass, item, decoy, cluster }] where each decoy landed.
 *  controlItems: [{ pass, item, control, cluster }] where each true control landed.
 */
export function buildItems(clusters, { roundKind, versionHash, rng, batchMax = 8, only = null, pass = null, decoys = null } = {}) {
  const byId = new Map((clusters || []).map((c) => [c.id, c]));
  const ids = only ? [...only] : selectForVerification(clusters, { versionHash }).verify;
  const passes = pass != null ? [pass] : roundKind === 'confirm' ? [1, 2] : [1];
  const decoyList = Array.isArray(decoys) ? decoys : [];
  const decoyById = new Map(decoyList.map((d) => [d.id, d]));
  const controlIds = decoyList.filter((d) => d.control).map((d) => d.id);
  const decoyIds = decoyList.filter((d) => !d.control).map((d) => d.id);
  const items = [];
  const batches = [];
  const hiddenMap = {};
  const decoyItems = [];
  const controlItems = [];
  for (const p of passes) {
    const order = rng && typeof rng.shuffle === 'function' ? rng.shuffle([...ids]) : [...ids];
    const groups = decoyList.length && order.length ? layoutWithExtras(order, controlIds, decoyIds, Math.max(1, batchMax), rng) : chunk(order, Math.max(1, batchMax));
    let k = 0;
    for (const g of groups) {
      const names = [];
      for (const cid of g) {
        k += 1;
        const d = decoyById.get(cid);
        const view = d ? { file: d.file ?? null, locator: d.locator ?? '', shown: d.shown, claim: d.claim } : itemView(byId.get(cid) || { id: cid });
        const it = { item: `V${k}`, pass: p, cluster: cid, ...view };
        hiddenMap[`${p}:${it.item}`] = cid;
        items.push(it);
        names.push(it.item);
        if (d && d.control) controlItems.push({ pass: p, item: it.item, control: d.control, cluster: cid });
        else if (d) decoyItems.push({ pass: p, item: it.item, decoy: d.decoy, cluster: cid });
      }
      batches.push({ pass: p, items: names });
    }
  }
  return { items, batches, hiddenMap, decoyItems, controlItems };
}

/** Normalise one verdict against the cluster (confirmed without grounding -> unverifiable). */
export function normaliseVerdict(c, v) {
  if (!v) return { verdict: 'unverifiable', severity: null, missing: true };
  if (v.verdict === 'confirmed') {
    if (!v.severity) return { ...v, verdict: 'unverifiable', why: 'confirmed without a class' };
    if (!c.grounded && !v.quoteNowGrounded) return { ...v, verdict: 'unverifiable', why: 'quote not found in the copy' };
  }
  if (!['confirmed', 'refuted', 'unverifiable'].includes(v.verdict)) return { ...v, verdict: 'unverifiable' };
  return v;
}

/** Combine two verdicts (second-verifier table, also both verifiers of a confirm round). */
export function combineTwo(c, a, b, carryOver) {
  const A = normaliseVerdict(c, a);
  const B = normaliseVerdict(c, b);
  if (A.verdict === 'confirmed' && B.verdict === 'confirmed') {
    // Classes differ -> the stricter one is kept (templates/severity.md: "take the stricter one"):
    // a lenient verifier must never weaken a defect the other verifier confirmed as serious.
    const s = maxSeverity([A.severity, B.severity]);
    const why = A.severity === B.severity ? 'both verifiers confirmed' : 'both verifiers confirmed; classes differ, the stricter one kept';
    return { status: s === 'cosmetic' ? 'cosmetic' : 'open', severity: s, why };
  }
  if (A.verdict === 'refuted' && B.verdict === 'refuted') {
    return { status: carryOver ? 'closed' : 'dropped', severity: c.severity ?? null, why: 'both verifiers refuted' };
  }
  if ((A.verdict === 'confirmed' && B.verdict === 'refuted') || (A.verdict === 'refuted' && B.verdict === 'confirmed')) {
    const s = A.verdict === 'confirmed' ? A.severity : B.severity;
    return { status: 'contested', severity: minSeverity(s, 'major'), why: 'one verifier confirmed, one refuted' };
  }
  const conf = [A, B].find((x) => x.verdict === 'confirmed');
  return {
    status: 'unverified',
    severity: conf ? conf.severity : c.claimedSeverity,
    why: 'a verifier could not decide',
  };
}

/** First verifier of a working round. Returns { status, severity, why } or { needSecond: true }. */
export function firstVerdict(c, v, carryOver) {
  const V = normaliseVerdict(c, v);
  if (V.verdict === 'confirmed') {
    return { status: SERIOUS.includes(V.severity) ? 'open' : 'cosmetic', severity: V.severity, why: 'verifier confirmed' };
  }
  if (V.verdict === 'refuted') {
    if (!c.grounded && !carryOver) return { status: 'dropped', severity: null, why: 'quote not in the copy; refuted' };
    if (c.claimedSeverity === 'blocker' || carryOver) return { needSecond: true };
    return { status: 'dropped', severity: null, why: 'verifier refuted' };
  }
  return { status: 'unverified', severity: c.claimedSeverity, why: 'verifier could not decide' };
}

/**
 * applyVerdicts(clusters, verdictsByCluster, { roundKind, pass, round, versionHash, carryOverIds }) ->
 *   { clusters, needSecond: [clusterIds], changes: [{ id, from, to }] }
 *  verdictsByCluster: { clusterId: [ { verdict, severity, evidence, quoteNow, whereNow, quoteNowGrounded, job, pass } ] }
 *   (all verdicts of this round so far for that cluster; a missing verdict counts as unverifiable)
 *  pass: 1 (first verifier, working), 2 (second verifier, working), 'both' (confirm round).
 */
export function applyVerdicts(clusters, verdictsByCluster, { roundKind, pass = 1, round, versionHash, carryOverIds = [] } = {}) {
  const carry = new Set(carryOverIds);
  const needSecond = [];
  const changes = [];
  const out = (clusters || []).map((c) => {
    if (!Object.prototype.hasOwnProperty.call(verdictsByCluster || {}, c.id)) return c;
    const vs = verdictsByCluster[c.id] || [];
    const isCarry = carry.has(c.id);
    let res;
    if (roundKind === 'confirm' || pass === 'both' || pass === 2) {
      const first = vs.find((v) => v.pass === 1) || vs[0];
      const second = vs.find((v) => v.pass === 2) || vs[1];
      res = combineTwo(c, first, second, isCarry);
    } else {
      res = firstVerdict(c, vs.find((v) => v.pass === 1) || vs[0], isCarry);
    }
    const evidence = [
      ...(c.evidence || []),
      ...vs
        .filter((v) => v && !(c.evidence || []).some((e) => e.round === round && e.job === v.job))
        .map((v) => ({
          round,
          job: v.job ?? null,
          verdict: v.verdict ?? 'unverifiable',
          severity: v.severity ?? null,
          evidence: v.evidence ?? '',
          quoteNow: v.quoteNow ?? null,
        })),
    ];
    if (res.needSecond) {
      needSecond.push(c.id);
      return { ...c, evidence };
    }
    const next = {
      ...c,
      evidence,
      status: res.status,
      severity: res.severity ?? null,
      verifiedOn: versionHash ?? c.verifiedOn ?? null,
      history: [...(c.history || []), { round, from: c.status, to: res.status, why: res.why }],
    };
    changes.push({ id: c.id, from: c.status, to: res.status });
    return next;
  });
  return { clusters: out, needSecond, changes };
}

/** Clusters whose verdicts cannot be trusted or completed: settle as unverified (they stay open). */
export function settleUnverified(clusters, ids, { round, versionHash, why }) {
  const set = new Set(ids || []);
  return (clusters || []).map((c) =>
    set.has(c.id)
      ? {
          ...c,
          status: 'unverified',
          severity: c.claimedSeverity ?? c.severity ?? null,
          verifiedOn: versionHash ?? null,
          history: [...(c.history || []), { round, from: c.status, to: 'unverified', why }],
        }
      : c,
  );
}

/** Clusters claimed cosmetic and not verified: settle as cosmetic. */
export function settleCosmetic(clusters, ids, { round, versionHash }) {
  const set = new Set(ids || []);
  return (clusters || []).map((c) =>
    set.has(c.id)
      ? {
          ...c,
          status: 'cosmetic',
          severity: 'cosmetic',
          verifiedOn: versionHash ?? null,
          history: [...(c.history || []), { round, from: c.status, to: 'cosmetic', why: 'claimed cosmetic; not verified' }],
        }
      : c,
  );
}

export { SEVERITY_RANK };
