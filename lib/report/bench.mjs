// The bench result (runbook 7.2 step 8), computed by code from the run files and a pass-rule file
// (bench/*.pass.json) and printed in fixed plain-Russian lines: the executor window never judges
// the bench by hand (r2-f29).

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../core/fsx.mjs';
import { runPaths } from '../core/runstore.mjs';
import { UsageError } from '../core/errors.mjs';

function readOr(p, fallback) {
  try {
    return fs.existsSync(p) ? readJson(p) : fallback;
  } catch {
    return fallback;
  }
}

/** benchResult(runDir, rule) -> { pass, rows, falseOpen, pairs, lines } */
export function benchResult(runDir, rule) {
  if (!rule || !Array.isArray(rule.comparable) || !Array.isArray(rule.hinted)) throw new UsageError('the bench rule file needs "comparable" and "hinted" lists');
  const P = runPaths(runDir);
  let names = [];
  try {
    names = fs.readdirSync(P.roundsDir).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b));
  } catch {
    names = [];
  }
  // The last round that revealed its key and matched findings.
  let round = null;
  for (const name of names) {
    const R = P.roundDir(Number(name));
    const key = readOr(R.canaries, null);
    const det = readOr(R.detections, null);
    if (key && det) round = { n: Number(name), key, det, gate: readOr(R.gate, null) };
  }
  if (!round) throw new UsageError('no round of this run has a revealed key and matched findings yet');
  const caughtOwn = (id) => {
    const c = (round.key.canaries || []).find((x) => x.canary === id);
    if (!c) return null;
    return (round.det.detections || []).some((d) => d.canary === id && d.lens === c.targetLens && d.outcome === 'caught');
  };
  const rows = [...rule.comparable, ...rule.hinted].map((id) => ({ id, hinted: rule.hinted.includes(id), caught: caughtOwn(id) }));
  const comparableOk = rows.filter((r) => !r.hinted).every((r) => r.caught === true);
  const hintedCaught = rows.filter((r) => r.hinted && r.caught === true).length;
  const hintedOk = hintedCaught >= (rule.hintedMin ?? rule.hinted.length);
  const clusters = readOr(P.clusters, { clusters: [] }).clusters || [];
  const falseOpen = (rule.falseFindings || []).filter((q) => clusters.some((c) => String(c.quote ?? '').includes(q) && ['open', 'unverified', 'contested'].includes(c.status)));
  const falseHardOpen = (rule.falseFindings || []).filter((q) => clusters.some((c) => String(c.quote ?? '').includes(q) && c.status === 'open'));
  const pairs = round.gate?.panelCatch ?? null;
  const pass = comparableOk && hintedOk && falseHardOpen.length === 0;
  const lines = [
    pass ? 'Проверочный прогон пройден.' : 'Проверочный прогон НЕ пройден: настоящие запуски — только после правки шаблонов и нового прогона.',
    `Круг ${round.n}. Сравнимые с прежним слепым прогоном подложенные ошибки, пойманные своим взглядом: ${rows.filter((r) => !r.hinted && r.caught).map((r) => r.id).join(', ') || 'ни одной'} из ${rule.comparable.join(', ')}.`,
    `Ошибки, на которые указывают пункты проверки (подсказанные): поймано своим взглядом ${hintedCaught} из ${rule.hinted.length}, нужно не меньше ${rule.hintedMin ?? rule.hinted.length}.`,
    falseHardOpen.length ? `Известные ложные находки прежнего слепого прогона остались открытыми: ${falseHardOpen.map((q) => `«${q}»`).join(', ')}.` : falseOpen.length ? `Известные ложные находки прежнего слепого прогона не закрыты окончательно (спорные или неподтверждённые): ${falseOpen.map((q) => `«${q}»`).join(', ')}.` : 'Известные ложные находки прежнего слепого прогона не остались открытыми.',
    pairs ? `Пар «проверяющий — подложенная ошибка» поймано ${pairs.pairsCaught} из ${pairs.pairsTotal} (справочно, без интервала: пары не независимы).` : 'Счёта пар нет.',
  ];
  return { pass, rows, falseOpen, falseHardOpen, pairs, round: round.n, lines };
}

export function loadBenchRule(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new UsageError(`no such bench rule file: ${p}`);
  return readJson(p);
}
