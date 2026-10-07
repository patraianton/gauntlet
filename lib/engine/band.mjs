// Reference score band (SPEC 13.5). Report only, confirm rounds only.
// The band never feeds the gate; it is derived from verified counts of one lens.
// No average of anything is computed here: the panel band is the WORST lens.

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * bandFor({ blockers, majors, cosmetics }) -> [lo, hi]
 *  b >= 1 blockers -> [max(1, 6.0 - (b - 1)) - 0.5, 6.0 - (b - 1)]   (hi never below 1)
 *  else m >= 3     -> [6.5, 7.5]
 *  else m in {1,2} -> [7.6, 8.9]
 *  else c >= 1     -> [9.0, 9.7]
 *  else            -> [9.8, 10]
 */
export function bandFor({ blockers = 0, majors = 0, cosmetics = 0 } = {}) {
  const b = Number(blockers) || 0;
  const m = Number(majors) || 0;
  const c = Number(cosmetics) || 0;
  if (b >= 1) {
    const hi = Math.max(1, 6.0 - (b - 1));
    return [round1(Math.max(0.5, hi - 0.5)), round1(hi)];
  }
  if (m >= 3) return [6.5, 7.5];
  if (m >= 1) return [7.6, 8.9];
  if (c >= 1) return [9.0, 9.7];
  return [9.8, 10];
}

/**
 * panelBand(perLens) -> [lo, hi] of the worst lens (lowest hi, then lowest lo).
 * perLens: { lensId: [lo, hi] } or an array of [lo, hi].
 */
export function panelBand(perLens) {
  const bands = Array.isArray(perLens) ? perLens : Object.values(perLens || {});
  if (bands.length === 0) return null;
  let worst = bands[0];
  for (const b of bands) {
    if (b[1] < worst[1] || (b[1] === worst[1] && b[0] < worst[0])) worst = b;
  }
  return [worst[0], worst[1]];
}
