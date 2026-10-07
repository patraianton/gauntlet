// What model and effort an agent spawned WITHOUT an explicit model gets (r3-f20). Reviewers and
// helpers run with no model unless the owner chose one, so their model is the Claude home's
// CLAUDE_CODE_SUBAGENT_MODEL (process env, else <home>/settings.json "env"), and in Agent mode their
// effort is the `effort:` of <home>/agents/general-purpose.md (Workflow mode passes effort 'high'
// itself). The setup summary claims «Sonnet, высокий уровень старания» only when both are seen here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** -> { home, model, modelFrom: 'env'|'settings'|null, effort, sonnet, effortHigh } */
export function agentDefaults({ env = process.env, homedir = os.homedir() } = {}) {
  const home = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR.trim() : path.join(homedir, '.claude');
  let model = env.CLAUDE_CODE_SUBAGENT_MODEL && env.CLAUDE_CODE_SUBAGENT_MODEL.trim() ? env.CLAUDE_CODE_SUBAGENT_MODEL.trim() : null;
  let modelFrom = model ? 'env' : null;
  if (!model) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8').replace(/^﻿/, ''));
      const m = j?.env?.CLAUDE_CODE_SUBAGENT_MODEL;
      if (typeof m === 'string' && m.trim()) {
        model = m.trim();
        modelFrom = 'settings';
      }
    } catch {
      /* no settings */
    }
  }
  let effort = null;
  try {
    const t = fs.readFileSync(path.join(home, 'agents', 'general-purpose.md'), 'utf8').replace(/^﻿/, '');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
    const e = fm ? /^effort:\s*["']?([A-Za-z]+)/m.exec(fm[1]) : null;
    effort = e ? e[1].toLowerCase() : null;
  } catch {
    /* no override */
  }
  return { home, model, modelFrom, effort, sonnet: /sonnet/i.test(model || ''), effortHigh: ['high', 'xhigh', 'max'].includes(effort || '') };
}
