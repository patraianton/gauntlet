// Deterministic clustering of findings (SPEC 12.4) and requirement clusters (SPEC 12.5).
// Pure: no I/O. Clusters are plain objects stored in the run-level clusters.json (SPEC 9.12).

export const SEVERITY_RANK = Object.freeze({ cosmetic: 1, major: 2, blocker: 3 });

export function maxSeverity(list) {
  let best = null;
  for (const s of list) if (s && (best === null || SEVERITY_RANK[s] > SEVERITY_RANK[best])) best = s;
  return best;
}

export function minSeverity(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/** Quote normaliser, same rules as SPEC 12.3 (kept local so clustering stays pure and dependency-free). */
export function normQuote(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[   -   　]/g, ' ')
    .replace(/[“”„«»"'‘’‚]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normLocator(s) {
  return normQuote(s).toLowerCase();
}

/** Longest common substring length (dynamic programming, O(n*m); quotes are short). */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Array(m + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (ai === b.charCodeAt(j - 1)) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

export function quotesOverlap(qa, qb) {
  const a = normQuote(qa);
  const b = normQuote(qb);
  if (a.length < 4 || b.length < 4) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return true;
  return longestCommonSubstring(a, b) >= 12;
}

const REQ_RE = /\bR\d{2}\b/;

/** Requirement id named by an omission finding (in missingWhat, locator or problem). */
export function requirementIdOf(f) {
  if (!f || f.kind !== 'omission') return null;
  if (f.requirementId) return f.requirementId;
  for (const s of [f.missingWhat, f.locator, f.problem]) {
    const m = REQ_RE.exec(String(s || ''));
    if (m) return m[0];
  }
  return null;
}

function hasQuote(x) {
  return x && x.quote != null && normQuote(x.quote).length >= 4;
}

/**
 * Do two items (findings or a finding and a cluster representative) belong together?
 * Only on evidence that they are about the same text: overlapping quotes in the same file, or two
 * omissions naming the same requirement id. Never on the locator alone ("Section 3" holds many
 * problems): two unrelated findings merged into one cluster would be verified on one claim only,
 * and a blocker could vanish behind another reviewer's typo.
 */
export function belongTogether(a, b) {
  if (!a || !b) return false;
  if ((a.file || null) !== (b.file || null) || !a.file) return false;
  if (hasQuote(a) && hasQuote(b) && quotesOverlap(a.quote, b.quote)) return true;
  if (a.kind === 'omission' && b.kind === 'omission') {
    const ra = requirementIdOf(a);
    if (ra && ra === requirementIdOf(b)) return true;
  }
  return false;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function clusterId(round, n) {
  return `C-${pad2(round)}-${pad2(n)}`;
}

/**
 * Representative order: the highest claimed class first (the verifier is shown the representative's
 * claim, so a blocker is never verified as somebody else's cosmetic remark), then lens id, number, job.
 */
function compareRep(a, b) {
  const sa = SEVERITY_RANK[a.severity] || 0;
  const sb = SEVERITY_RANK[b.severity] || 0;
  if (sa !== sb) return sb - sa;
  if (a.lens !== b.lens) return String(a.lens) < String(b.lens) ? -1 : 1;
  if (a.n !== b.n) return a.n - b.n;
  return String(a.job) < String(b.job) ? -1 : String(a.job) > String(b.job) ? 1 : 0;
}

function memberOf(f) {
  return { round: f.round, lens: f.lens, job: f.job, n: f.n, severity: f.severity };
}

function clusterFrom(rep, members, id, round) {
  return {
    id,
    origin: 'finding',
    file: rep.file || null,
    locator: rep.locator || '',
    quote: rep.quote ?? null,
    problem: rep.problem || '',
    kind: rep.kind || 'other',
    missingWhat: rep.missingWhat ?? null,
    seen: rep.seen ?? null,
    fix: rep.fix ?? null,
    members: members.map(memberOf),
    claimedSeverity: maxSeverity(members.map((m) => m.severity)),
    grounded: rep.grounded !== false,
    status: 'pending',
    severity: null,
    verifiedOn: null,
    evidence: [],
    history: [{ round, from: null, to: 'pending', why: 'reported' }],
  };
}

/**
 * clusterFindings(findings, openClusters, round, { startIndex }) -> { clusters, attached }
 *  findings: [{ round, lens, job, n, severity, kind, file, locator, quote, quote2?, seen?, missingWhat?, problem, fix, grounded }]
 *  openClusters: existing clusters (open/unverified/contested) — findings overlapping one are attached to it.
 *  Returns NEW clusters (status 'pending') and `attached` = [{ clusterId, member }] for existing ones.
 *  Existing cluster objects are not mutated.
 */
export function clusterFindings(findings, openClusters = [], round, { startIndex = 1 } = {}) {
  const fs = [...(findings || [])];
  const existing = [...(openClusters || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const attached = [];
  const rest = [];
  for (const f of fs) {
    const target = existing.find((c) => c.origin !== 'requirement' && belongTogether(f, c));
    if (target) attached.push({ clusterId: target.id, member: memberOf(f), severity: f.severity });
    else rest.push(f);
  }
  // Union-find over the remaining findings.
  const parent = rest.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      if (belongTogether(rest[i], rest[j])) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map();
  rest.forEach((f, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  });
  const built = [...groups.values()].map((members) => {
    const sorted = [...members].sort(compareRep);
    return { rep: sorted[0], members: sorted };
  });
  built.sort((a, b) => {
    const fa = String(a.rep.file || '');
    const fb = String(b.rep.file || '');
    if (fa !== fb) return fa < fb ? -1 : 1;
    const la = normLocator(a.rep.locator);
    const lb = normLocator(b.rep.locator);
    if (la !== lb) return la < lb ? -1 : 1;
    return compareRep(a.rep, b.rep);
  });
  const clusters = built.map((g, k) => clusterFrom(g.rep, g.members, clusterId(round, startIndex + k), round));
  return { clusters, attached };
}

/** Apply `attached` from clusterFindings to a cluster list (returns a new list). */
export function attachMembers(clusters, attached) {
  const byId = new Map(clusters.map((c) => [c.id, { ...c, members: [...(c.members || [])] }]));
  for (const a of attached || []) {
    const c = byId.get(a.clusterId);
    if (!c) continue;
    c.members.push(a.member);
    c.claimedSeverity = maxSeverity([c.claimedSeverity, a.member.severity]);
  }
  return clusters.map((c) => byId.get(c.id));
}

/**
 * requirementClaims(answers, requirements) -> [{ requirementId, claimed, members }]
 *  answers: kept reviewer answers [{ job, lens, round, requirements: [{ id, status }] }]
 *  absent by at least one -> claimed = ifMissing; only partial -> major;
 *  cannot-tell from every reviewer that answered -> major (fail-closed).
 */
export function requirementClaims(answers, requirements) {
  const out = [];
  for (const r of requirements || []) {
    const marks = [];
    for (const a of answers || []) {
      const m = (a.requirements || []).find((x) => x.id === r.id);
      marks.push({ a, status: m ? m.status : 'cannot-tell' });
    }
    if (marks.length === 0) continue;
    const absent = marks.filter((m) => m.status === 'absent');
    const partial = marks.filter((m) => m.status === 'partial');
    const cannot = marks.filter((m) => m.status === 'cannot-tell');
    let claimed = null;
    let who = [];
    if (absent.length > 0) {
      claimed = r.ifMissing === 'blocker' ? 'blocker' : 'major';
      who = [...absent, ...partial];
    } else if (partial.length > 0) {
      claimed = 'major';
      who = partial;
    } else if (cannot.length === marks.length) {
      claimed = 'major';
      who = cannot;
    }
    if (!claimed) continue;
    out.push({
      requirementId: r.id,
      text: r.text,
      claimed,
      members: who.map((m) => ({ round: m.a.round, lens: m.a.lens, job: m.a.job, n: null, severity: claimed })),
    });
  }
  return out;
}

/**
 * requirementClusters(answers, requirements, allClusters, round, { startIndex }) ->
 *   { clusters: updated full list, created: [ids], reopened: [ids], attachedTo: [ids] }
 *  One cluster per requirement id per run, reused across rounds.
 */
export function requirementClusters(answers, requirements, allClusters, round, { startIndex = 1 } = {}) {
  const claims = requirementClaims(answers, requirements);
  const list = (allClusters || []).map((c) => ({ ...c }));
  const created = [];
  const reopened = [];
  const attachedTo = [];
  let next = startIndex;
  for (const cl of claims) {
    const idx = list.findIndex((c) => c.origin === 'requirement' && c.requirementId === cl.requirementId);
    if (idx >= 0) {
      const c = { ...list[idx], members: [...(list[idx].members || []), ...cl.members] };
      c.claimedSeverity = maxSeverity([c.claimedSeverity, cl.claimed]);
      if (['dropped', 'closed', 'cosmetic'].includes(c.status)) {
        c.history = [...(c.history || []), { round, from: c.status, to: 'pending', why: 'requirement marked missing again' }];
        c.status = 'pending';
        c.severity = null;
        c.claimedSeverity = cl.claimed;
        reopened.push(c.id);
      } else {
        attachedTo.push(c.id);
      }
      list[idx] = c;
    } else {
      const id = clusterId(round, next++);
      list.push({
        id,
        origin: 'requirement',
        requirementId: cl.requirementId,
        file: null,
        locator: 'whole work',
        quote: null,
        problem: `The work does not fully meet this requirement of the task: ${cl.text}`,
        kind: 'omission',
        missingWhat: cl.text,
        seen: null,
        fix: null,
        members: cl.members,
        claimedSeverity: cl.claimed,
        grounded: true,
        status: 'pending',
        severity: null,
        verifiedOn: null,
        evidence: [],
        history: [{ round, from: null, to: 'pending', why: 'requirement marked missing' }],
      });
      created.push(id);
    }
  }
  return { clusters: list, created, reopened, attachedTo };
}
