export const meta = {
  name: 'gauntlet',
  description: 'Drive one gauntlet run: relay step --json through a clerk agent, verify its signature, spawn the printed jobs in parallel, repeat until the run needs the executor or the owner.',
  phases: [{ title: 'Step' }, { title: 'Agents' }],
}

// gauntlet Workflow driver (opt-in), SPEC section 17.2.
//
// Start from a Claude Code window with the Workflow tool:
//   { scriptPath: "<repo>/workflows/gauntlet.workflow.js",
//     args: { cli: "<repo>/bin/gauntlet.mjs", run: "<runDir>", maxSteps: 60 } }
//
// Allowed only when run.json.driver.mode is "workflow" with the owner's recorded quote (every step
// call passes --driver workflow, and step refuses it without that recorded opt-in). The script
// decides nothing about the material: every decision is taken by `gauntlet step`, which this
// script only relays.
//
// Constraints of the Workflow runtime this file respects: plain JavaScript, no imports, no
// filesystem, no clock and no randomness.
//
// The clerk relay is checked with a CHECKSUM, not a signature: `step --json` prints
// sig = sha256(canonical(payload)) without any key, and the script recomputes it with the pure-JS
// sha256 below (identical text to lib/core/sha256-pure.js between the markers; a test asserts it)
// and canon(). That catches a clerk that garbles or truncates the payload by accident; a clerk that
// invents a payload can compute a matching checksum. Against that the script also accepts only
// job calls of the one fixed shape (the agent-call template pointing at a PROMPT.md) and model
// names of a plain shape; anything else stops the workflow (docs/honesty-limits.md).
//
// Each agent replies "DONE <answer code>" (printed by check-answer.mjs). The script passes the
// codes to step with --answer-hash, so an answer file changed after the agent finished is rejected.

// BEGIN sha256-pure
function sha256(str) {
  var s = String(str);
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var bitLenHi = Math.floor(bytes.length / 0x20000000);
  var bitLenLo = (bytes.length * 8) >>> 0;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 8) & 255, bitLenHi & 255);
  bytes.push((bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 8) & 255, bitLenLo & 255);
  var W = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      var p = off + t * 4;
      W[t] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) | 0;
    }
    for (t = 16; t < 64; t++) {
      var w15 = W[t - 15];
      var w2 = W[t - 2];
      var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c2 = H[2], d2 = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[t] + W[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var mj = (a & b) ^ (a & c2) ^ (b & c2);
      var t2 = (S0 + mj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d2 + t1) | 0;
      d2 = c2;
      c2 = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c2) | 0;
    H[3] = (H[3] + d2) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }
  var hex = '';
  for (var k = 0; k < 8; k++) {
    var v = H[k] >>> 0;
    var part = v.toString(16);
    while (part.length < 8) part = '0' + part;
    hex += part;
  }
  return hex;
}
// END sha256-pure

// Canonical JSON, the same rules as lib/core/canon.mjs: object keys sorted recursively,
// no whitespace, numbers and strings serialised with JSON.stringify.
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : canon(x))).join(',') + ']'
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

// ---- arguments -------------------------------------------------------------------------------

const A = args && typeof args === 'object' ? args : {}
const CLI = typeof A.cli === 'string' ? A.cli.trim() : ''
// A trailing backslash would escape the closing quote of the clerk's command (r3-f31): strip it.
const RUN = typeof A.run === 'string' ? A.run.trim().replace(/[\\/]+$/, '') : ''
const UNSAFE = /["`$\r\n]/
if (!/(^|[\\/])bin[\\/]gauntlet\.mjs$/.test(CLI) || UNSAFE.test(CLI)) {
  throw new Error('args.cli must be the path of bin/gauntlet.mjs (bin\\gauntlet.mjs on Windows), without quotes, $ or backticks')
}
if (!RUN || UNSAFE.test(RUN)) {
  throw new Error('args.run must be the run folder path, without quotes, $ or backticks')
}
const MAX_STEPS = Number.isInteger(A.maxSteps) && A.maxSteps > 0 && A.maxSteps <= 500 ? A.maxSteps : 60
// A job the step prints again after it was spawned twice is given up instead of spawned a third
// time (fail-closed: a given-up job is an invalid attempt, never an approval). An agent that died
// (its agent call returned null) is not given up at once: the next step prints its call again and it is
// spawned a second time, as in Agent mode (r2-f14).
const MAX_SPAWNS_PER_JOB = 2
const JOB_ID = /^[a-z2-9]{8}$/
// The only job call step ever prints (templates/agent-call.txt with a PROMPT.md path).
const CALL_RE = /^Read the file ([^\r\n"`$]+[\\/]PROMPT\.md) and do exactly what it says\. Do not read anything else before it\. When finished, reply with DONE followed by the answer code the check printed, and nothing else\.$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/
const CODE_RE = /\bDONE\s+([0-9a-f]{12,64})\b/i

// ---- clerk relay -----------------------------------------------------------------------------

const CLERK = {
  type: 'object',
  required: ['exitCode', 'envelope'],
  properties: { exitCode: { type: 'integer' }, envelope: { type: 'object' } },
}

// The payload is acted on only at exit 10 (the jobs to spawn), so only there must the clerk's copy
// match the signature exactly. At any other exit the script just returns, and a payload the clerk
// copied with one character changed (Russian quotes, backslashes) is reported as such instead of
// failing the run (r3-f11).
function relayProblem(r) {
  if (!r || typeof r !== 'object') return 'no answer from the clerk'
  const env = r.envelope
  if (!env || typeof env !== 'object') return 'no envelope'
  if (typeof env.sig !== 'string' || !env.payload || typeof env.payload !== 'object') return 'envelope without payload or sig'
  if (!Number.isInteger(env.exitCode)) return 'envelope without an exit code'
  if (r.exitCode !== env.exitCode) return 'process exit code ' + r.exitCode + ' differs from envelope exit code ' + env.exitCode
  const signed = sha256(canon(env.payload)) === env.sig
  if (!signed && env.exitCode === 10) return 'signature does not match the payload'
  r.garbled = !signed
  if (env.exitCode === 10) {
    const jobs = env.payload.jobs
    if (!Array.isArray(jobs) || jobs.length === 0) return 'exit 10 without jobs'
    for (const j of jobs) {
      if (!j || typeof j.call !== 'string' || !j.call || typeof j.job !== 'string' || !JOB_ID.test(j.job)) return 'malformed job in the payload'
      const m = CALL_RE.exec(j.call)
      if (!m) return 'job ' + j.job + ': the call is not the fixed agent call'
      if (typeof j.promptPath === 'string' && j.promptPath !== m[1]) return 'job ' + j.job + ': the call points at another prompt than promptPath'
      if (j.model !== null && j.model !== undefined && (typeof j.model !== 'string' || !MODEL_RE.test(j.model))) return 'job ' + j.job + ': unexpected model name'
    }
  }
  return null
}

async function clerk(extra) {
  const base = 'node "' + CLI + '" step "' + RUN + '" --json'
  let cmd = base + (extra ? ' ' + extra : '')
  for (let attempt = 1; attempt <= 2; attempt++) {
    // A retry must not book the same token total or codes twice (step may have run the first time):
    // it repeats step with the driver flag only; step reprints the same calls in a waiting state.
    if (attempt === 2) cmd = base + ' --driver workflow'
    const r = await measured(() => agent(
      'You are a clerk. Run exactly this one command with the Bash tool. Return its exit code and its stdout ' +
      'parsed as JSON, unchanged. Do not run anything else, do not edit any file, do not interpret the output. ' +
      'Give the Bash call the longest timeout, 600000 ms: one step can rebuild the review copy and run every source.\n\n' +
      cmd,
      { label: 'clerk:step', phase: 'Step', schema: CLERK, effort: 'high' }))
    const problem = relayProblem(r)
    if (!problem) return r
    log('clerk relay mismatch (attempt ' + attempt + '): ' + problem)
  }
  throw new Error('clerk failed twice; run step by hand: ' + cmd)
}

function spentTokens() {
  if (budget && typeof budget.spent === 'function') {
    const n = Number(budget.spent())
    if (Number.isFinite(n) && n >= 0) return Math.round(n)
  }
  return 0
}

// Token accounting. budget.spent() is the whole TURN's counter of output tokens: this workflow's
// agents, every other workflow, and the window's own work in the same turn (an executor that coded
// for 50 minutes before starting the panel). Reporting it, as this script once did, booked the
// window's own work as panel spending (night of 06-07.10.2026: 1.5 M, 3.6 M, 5.3 M for a step that
// really cost 0.34 M). So the script never reports the counter itself: it reads it immediately before
// and after each of its own agent batches and clerk calls, and reports the sum of those differences.
// What it cannot exclude: tokens the window's main loop spends WHILE a batch runs (if the window
// works concurrently, they land in that batch's difference). docs/measurement.md.
let pendingTokens = 0
async function measured(fn) {
  const before = spentTokens()
  try {
    return await fn()
  } finally {
    const after = spentTokens()
    if (after > before) pendingTokens += after - before
  }
}
// The tokens measured since the last report; the next report starts from zero.
function takePendingTokens() {
  const n = pendingTokens
  pendingTokens = 0
  return n
}

// ---- the loop --------------------------------------------------------------------------------

const spawned = {}
let extra = '--driver workflow'
for (let i = 0; i < MAX_STEPS; i++) {
  phase('Step')
  const r = await clerk(extra)
  const env = r.envelope
  if (env.exitCode !== 10) {
    if (r.garbled) return env.exitCode + ' ' + env.state + ': the clerk did not copy the payload exactly; run "node ' + CLI + ' status ' + RUN + '" for the details'
    return env.exitCode + ' ' + env.state + ': ' + JSON.stringify(env.payload).slice(0, 2000) + '\nsig ' + env.sig
  }

  const toSpawn = []
  const giveUp = []
  for (const j of env.payload.jobs) {
    const n = spawned[j.job] || 0
    if (n >= MAX_SPAWNS_PER_JOB) {
      giveUp.push(j.job)
    } else {
      spawned[j.job] = n + 1
      toSpawn.push(j)
    }
  }
  if (giveUp.length) log('no answer after ' + MAX_SPAWNS_PER_JOB + ' spawns, giving up: ' + giveUp.join(','))

  phase('Agents')
  const results = await measured(() => parallel(toSpawn.map(j => () => {
    const model = typeof j.model === 'string' && j.model ? j.model : null
    return agent(j.call, { label: j.label || j.role || 'job', phase: 'Agents', effort: 'high', ...(model ? { model } : {}) })
  })))
  const dead = toSpawn.filter((j, k) => results[k] === null || results[k] === undefined).map(j => j.job)
  if (dead.length) log('agents that died: ' + dead.join(','))
  const codes = []
  toSpawn.forEach((j, k) => {
    const m = typeof results[k] === 'string' ? CODE_RE.exec(results[k]) : null
    if (m) codes.push(j.job + '=' + m[1].toLowerCase())
  })
  const lost = giveUp.concat(dead.filter(j => (spawned[j] || 0) >= MAX_SPAWNS_PER_JOB))
  // Report only what this invocation's own agents and clerk calls spent since the last report
  // (measured above: the clerk call that printed these jobs plus the batch), never the turn's counter.
  // The clerk call that carries this report is measured after it returns and goes into the next one;
  // the very last clerk call of an invocation is never reported (a small, known undercount).
  extra = '--driver workflow --usage-delta ' + takePendingTokens() +
    (codes.length ? ' --answer-hash ' + codes.join(',') : '') + (lost.length ? ' --give-up ' + lost.join(',') : '')
}
return 'maxSteps reached; run step again'
