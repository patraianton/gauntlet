// `doctor` (SPEC 10.2): Node >= 24; repository templates match templates/MANIFEST.json; the data
// home is writable; every chained file of the data home verifies; an installed global rule file
// carries no loop internals; prints the data home path.

import fs from 'node:fs';
import path from 'node:path';
import { exists, readJson, readRaw } from '../core/fsx.mjs';
import { sha256Hex, hashFile } from '../core/hash.mjs';
import { verifyChained } from '../core/chain.mjs';
import { dataPaths as defaultDataPaths, chainedFiles } from '../core/datahome.mjs';
import os from 'node:os';
import { discoverHomes } from '../../install/install.mjs';
import { parseArgv } from './state.mjs';
import { findApproval } from './cmd-templates.mjs';
import { agentDefaults } from '../core/agenthome.mjs';

/** Words about the loop's checks of its reviewers that a global rule (read by every session) must not carry. */
export const RULE_INTERNALS = Object.freeze([/decoy/i, /canar/i, /plant/i, /подлож/i, /sealed/i, /gauntlet-data/i, /confirm/i, /recall/i, /ledger/i, /\bkey\b/i, /attention/i, /threshold/i, /9[.,]5/, /blind/i, /слеп/i]);

export function ruleInternals(text) {
  return RULE_INTERNALS.filter((re) => re.test(String(text))).map((re) => String(re));
}

export async function run(argv, ctx) {
  parseArgv(argv, {});
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node', ok: major >= 24, details: [`node ${process.versions.node}`] });

  const tplDir = path.join(ctx.repoDir, 'templates');
  const manPath = path.join(tplDir, 'MANIFEST.json');
  const tplDetails = [];
  if (!exists(manPath)) tplDetails.push('templates/MANIFEST.json is missing');
  else {
    const man = readJson(manPath);
    for (const [name, sha] of Object.entries(man.files || {})) {
      const p = path.join(tplDir, name);
      if (!exists(p)) {
        tplDetails.push(`${name} is missing`);
        continue;
      }
      if (sha !== sha256Hex(readRaw(p)) && sha !== hashFile(p)) tplDetails.push(`${name} differs from MANIFEST.json`);
    }
  }
  // What agents spawned without a model get in this window (r3-f20); informational.
  {
    const ad = agentDefaults();
    checks.push({ id: 'agents', ok: true, details: [`subagent model: ${ad.model ?? 'not set'}${ad.modelFrom ? ` (${ad.modelFrom})` : ''}; general-purpose effort: ${ad.effort ?? 'not set'} (${ad.home})${ad.sonnet && ad.effortHigh ? '' : ' - the setup summary will not claim "Sonnet, high"'}`] });
  }
  const dp = ctx.dataPaths ?? defaultDataPaths(ctx.dataHome);
  // The owner's approval of this template version (r3-f6); init refuses an unapproved one.
  if (exists(manPath)) {
    const a = findApproval(dp, sha256Hex(readRaw(manPath)));
    tplDetails.push(a ? `approved by the owner on ${a.date}: "${a.quote}"` : 'not approved by the owner yet: init will refuse (templates approve --owner-quote --question)');
  }
  checks.push({ id: 'templates', ok: tplDetails.every((d) => /^approved by the owner|^not approved/.test(d)), details: tplDetails });

  // Probe without creating anything: an existing data home gets a write probe; a missing one is
  // checked through its nearest existing parent (it is created on first use).
  let writable = true;
  let note = dp.root;
  try {
    if (exists(dp.root)) {
      const probe = path.join(dp.root, `.doctor-${process.pid}.tmp`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } else {
      let up = path.dirname(dp.root);
      while (!exists(up) && path.dirname(up) !== up) up = path.dirname(up);
      fs.accessSync(up, fs.constants.W_OK);
      note = `${dp.root} (not created yet; ${up} is writable)`;
    }
  } catch {
    writable = false;
  }
  checks.push({ id: 'data-home', ok: writable, details: [note] });

  const chainDetails = [];
  for (const f of chainedFiles(dp)) {
    if (!exists(f)) continue;
    const v = verifyChained(f);
    if (!v.ok) chainDetails.push(`${f}: broken at line ${v.firstBrokenSeq}`);
  }
  checks.push({ id: 'chains', ok: chainDetails.length === 0, details: chainDetails });

  // Installed global rule files are read by every Claude session, the run's reviewers included:
  // they must not tell a reviewer how the loop checks reviewers (failure point 1 / SPEC 5.2).
  const ruleDetails = [];
  const home = os.homedir();
  const ruleFiles = [path.join(home, '.claude', 'rules', 'gauntlet.md')];
  const extraHomes = discoverHomes(home).filter((h) => !h.main).map((h) => h.dir);
  for (const d of extraHomes) ruleFiles.push(path.join(d, 'rules', 'gauntlet.md'));
  for (const f of ruleFiles) {
    if (!exists(f)) continue;
    const hits = ruleInternals(fs.readFileSync(f, 'utf8'));
    if (hits.length) ruleDetails.push(`${f} mentions ${hits.join(', ')}; reinstall the rule from the repository`);
  }
  const installedRules = ruleFiles.filter((f) => exists(f));
  if (!installedRules.length) ruleDetails.push('not installed (no rules/gauntlet.md in any home); run install/install.mjs by hand when the owner asks');
  checks.push({ id: 'global-rule', ok: ruleDetails.filter((d) => !d.startsWith('not installed')).length === 0, details: ruleDetails });

  // The installed skill must point at this repository (its CLI path is rendered at install time).
  const skillDetails = [];
  const repoFwd = path.resolve(ctx.repoDir).split(path.sep).join('/');
  const skillFiles = [path.join(home, '.claude', 'skills', 'gauntlet', 'SKILL.md')];
  for (const d of extraHomes) skillFiles.push(path.join(d, 'skills', 'gauntlet', 'SKILL.md'));
  let skillsFound = 0;
  const seenReal = new Set();
  for (const f of skillFiles) {
    if (!exists(f)) continue;
    let real = f;
    try {
      real = fs.realpathSync(f);
    } catch {
      real = f;
    }
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seenReal.has(key)) continue;
    seenReal.add(key);
    skillsFound++;
    const t = fs.readFileSync(f, 'utf8');
    const hit = process.platform === 'win32' ? t.toLowerCase().includes(`${repoFwd.toLowerCase()}/bin/gauntlet.mjs`) : t.includes(`${repoFwd}/bin/gauntlet.mjs`);
    if (!hit) skillDetails.push(`${f} points at another repository; reinstall from ${repoFwd}`);
  }
  if (!skillsFound) skillDetails.push('skill not installed');
  checks.push({ id: 'skill', ok: skillDetails.filter((d) => d !== 'skill not installed').length === 0, details: skillDetails });

  const ok = checks.every((c) => c.ok);
  const lines = checks.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.id}${c.details.length ? ': ' + c.details.join(' | ') : ''}`);
  lines.push(`Data home: ${dp.root}`);
  lines.push('');
  lines.push(ok ? 'NEXT: nothing' : 'NEXT: fix the failed checks');
  return { exitCode: ok ? 0 : 3, state: null, payload: { ok, checks, dataHome: dp.root }, text: lines.join('\n') };
}
