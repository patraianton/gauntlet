// The only clock of gauntlet (SPEC 9: timestamps are taken by scripts, agents never
// supply times). ISO 8601 in local time with an explicit offset, e.g.
// 2026-10-06T09:30:00.123+03:00. Tests can replace the clock.

let override = null;

/** fn: () => Date | number | string. Pass null to restore the real clock. */
export function setClockForTests(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('setClockForTests expects a function or null');
  override = fn;
}

/** Current time as a Date (honours the test clock). */
export function nowDate() {
  if (!override) return new Date();
  const v = override();
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError('test clock returned an invalid time');
  return d;
}

/** Current time as ISO 8601 with the local offset. */
export function now() {
  return isoLocal(nowDate());
}

const p2 = (n) => String(n).padStart(2, '0');

export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
  );
}

/** "YYYYMMDD-HHMM" in local time, the date part of a runId (SPEC 8). */
export function runStamp(d = nowDate()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

/** "YYYY-MM-DD" in local time. */
export function localDate(d = nowDate()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
