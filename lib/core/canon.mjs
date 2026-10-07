// Canonical JSON (SPEC 9): object keys sorted recursively (UTF-16 code unit order),
// no whitespace, numbers and strings serialised exactly as JSON.stringify does.
// Follows JSON.stringify for undefined/functions/symbols: dropped from objects,
// `null` inside arrays. Non-finite numbers become null (as JSON.stringify).

export function canonical(value) {
  const out = enc(value);
  return out === undefined ? 'null' : out;
}

function enc(v) {
  if (v === null) return 'null';
  if (v !== undefined && v !== null && typeof v.toJSON === 'function') v = v.toJSON();
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return JSON.stringify(v); // NaN/Infinity -> "null"
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonical: BigInt is not JSON');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const parts = v.map((x) => {
      const e = enc(x);
      return e === undefined ? 'null' : e;
    });
    return '[' + parts.join(',') + ']';
  }
  const keys = Object.keys(v).sort(cmp);
  const parts = [];
  for (const k of keys) {
    const e = enc(v[k]);
    if (e === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + e);
  }
  return '{' + parts.join(',') + '}';
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
