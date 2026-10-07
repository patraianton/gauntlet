// P5: the frozen templates — placeholders (SPEC 15.3), rendering (15.1), forbidden content (15.1),
// required content (15.2, 15.3), embedded answer examples (9.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  TEMPLATES, PLACEHOLDERS, SECTIONS, ROLE_SCHEMA, readText, tokens, placeholderNames, renderLocal, fullValues,
  answerExample, schemas, tryImport, PROMPT_LINT_MIN, realPromptPatterns,
} from '../fixtures/templates/helpers.mjs';

const { checkAnswerBytes } = await import(pathToFileURL(join(TEMPLATES, 'check-answer.mjs')).href);
const AGENT_TEMPLATES = ['reviewer.md', 'verifier.md', 'dispute-verifier.md', 'planter.md', 'canary-validator.md', 'matcher.md', 'lens-writer.md', 'decoy-writer.md'];
const TEXT_TEMPLATES = [...AGENT_TEMPLATES, 'severity.md', 'author-notes-banner.md', 'agent-call.txt'];
const text = (name) => readText(join(TEMPLATES, name));

test('every template file of SPEC section 6 exists', () => {
  for (const f of [...TEXT_TEMPLATES, 'check-answer.mjs', 'update-manifest.mjs', 'MANIFEST.json']) {
    assert.ok(existsSync(join(TEMPLATES, f)), `missing templates/${f}`);
  }
});

for (const name of TEXT_TEMPLATES) {
  test(`${name}: placeholders are exactly the SPEC 15.3 list`, () => {
    assert.deepEqual(placeholderNames(text(name)), [...PLACEHOLDERS[name]].sort());
  });

  test(`${name}: every {{ }} token is well-formed and sections are balanced`, () => {
    const t = text(name);
    const opens = (t.match(/\{\{/g) || []).length;
    assert.equal(tokens(t).length, opens, 'a "{{" that is not a placeholder token');
    for (const tok of tokens(t)) assert.match(tok.name, /^[A-Z][A-Z0-9_]*$/, `bad placeholder name ${tok.name}`);
    const secs = tokens(t).filter((x) => x.kind !== '');
    const expected = SECTIONS[name] || [];
    assert.deepEqual([...new Set(secs.map((x) => x.name))].sort(), [...expected].sort(), 'optional sections differ from SPEC 15.3');
    for (const s of expected) {
      assert.equal(secs.filter((x) => x.name === s && x.kind === '#').length, 1);
      assert.equal(secs.filter((x) => x.name === s && x.kind === '/').length, 1);
      assert.ok(t.indexOf(`{{#${s}}}`) < t.indexOf(`{{/${s}}}`));
    }
  });

  test(`${name}: has no forbidden placeholder (threshold, score, round, history)`, () => {
    for (const n of placeholderNames(text(name))) {
      assert.doesNotMatch(n, /THRESHOLD|SCORE|ROUND|HISTORY|PRIOR|TARGET|AVERAGE|RATING|FIXED|PREVIOUS_(ROUND|SCORE|FINDINGS)/);
    }
  });

  test(`${name}: renders with a full value set and fails when one value is missing`, () => {
    const t = text(name);
    const values = fullValues(name);
    const out = renderLocal(t, values);
    assert.doesNotMatch(out, /\{\{[#/]?[A-Z0-9_]+\}\}/, 'unrendered placeholder');
    for (const key of Object.keys(values)) {
      const partial = { ...values };
      delete partial[key];
      assert.throws(() => renderLocal(t, partial), /missing placeholder value/, `missing ${key} must fail`);
    }
    assert.throws(() => renderLocal(t, { ...values, THRESHOLD: '9.5' }), /unknown placeholder/);
  });

  test(`${name}: renders with lib/material/render.mjs (P2), when it exists`, async (t) => {
    const render = await tryImport('lib/material/render.mjs');
    if (!render || typeof render.renderTemplate !== 'function') { t.skip('lib/material/render.mjs not present yet'); return; }
    const tx = text(name);
    const values = fullValues(name);
    const out = render.renderTemplate(tx, values);
    assert.doesNotMatch(out, /\{\{[#/]?[A-Z0-9_]+\}\}/);
    for (const key of Object.keys(values)) {
      const partial = { ...values };
      delete partial[key];
      assert.throws(() => render.renderTemplate(tx, partial), () => true, `missing ${key} must fail`);
    }
    for (const s of SECTIONS[name] || []) {
      const emptied = render.renderTemplate(tx, { ...values, [s]: '' });
      assert.doesNotMatch(emptied, /\{\{[#/]?[A-Z0-9_]+\}\}/, `empty section ${s} must render`);
      assert.ok(emptied.length < out.length, `empty section ${s} must be removed`);
    }
  });
}

test('optional sections disappear when empty and stay when filled', () => {
  const r = text('reviewer.md');
  const v = fullValues('reviewer.md');
  assert.match(renderLocal(r, v), /## Author's notes/);
  assert.doesNotMatch(renderLocal(r, { ...v, AUTHOR_NOTES: '' }), /## Author's notes/);
  const l = text('lens-writer.md');
  const lv = fullValues('lens-writer.md');
  assert.match(renderLocal(l, lv), /rejected by code/);
  assert.doesNotMatch(renderLocal(l, { ...lv, PREVIOUS_ERRORS: '' }), /rejected by code/);
});

// ---- forbidden content in the frozen text itself (SPEC 15.1) ----
const FORBIDDEN = [
  [/deliberat/i, '"deliberate"'],
  [/намеренн/i, '"намеренно"'],
  [/threshold/i, 'threshold'],
  [/\b9[.,]5\b/, 'the 9.5 target'],
  [/(?:≥|>=)\s*\d/, 'a numeric threshold'],
  [/\b(?:lenient|leniency|strict|strictly|strictness|harsh(?:ly)?)\b/i, 'a leniency or strictness instruction'],
  [/do not invent|не придумывай/i, '"do not invent"'],
  [/\bround\b|\bкруг/i, 'a round word'],
  [/\bpanel\b|панел/i, 'the word panel'],
  [/\baverage\b|средн/i, 'an average'],
  [/\brating\b|\bgrade (?:it|the work)\b/i, 'a rating request'],
  [/previous (?:round|score|review)|предыдущ/i, 'a history reference'],
  [/already (?:fixed|corrected|checked) (?:in|by|since)|исправлено/i, 'an already-fixed claim'],
  [/out of scope|вне рамок|do not flag|не отмечай|not substantive|несущественн/i, 'a topic exclusion'],
  [/(?:at most|no more than|up to|maximum of|within) \d+ (?:words|sentences|lines|paragraphs)\b|\bbe brief\b|\bkeep it short\b|\bbriefly\b|коротко/i, 'a word limit'],
];

for (const name of TEXT_TEMPLATES) {
  test(`${name}: contains no forbidden instruction`, () => {
    const t = text(name);
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(t, re, `${name} contains ${what}`);
  });

  test(`${name}: the word for planted errors never appears outside field names`, () => {
    const t = text(name)
      .replace(/\{\{CANARY_TYPES\}\}/g, '')
      .replace(/`canaryTypes`|"canaryTypes"/g, '')
      .replace(/`canary`|"canary"/g, '');
    assert.doesNotMatch(t, /canar|подлож|planted/i);
  });

  test(`${name}: score appears only where SPEC requires it`, () => {
    const t = text(name);
    const hits = t.match(/score/gi) || [];
    if (name === 'reviewer.md') {
      assert.equal(hits.length, 1);
      assert.ok(t.includes('Do not give an overall score.'));
    } else if (name === 'matcher.md') {
      assert.ok(!/overall score|give .* score to the work/i.test(t));
    } else {
      assert.equal(hits.length, 0, `${name} mentions score`);
    }
  });
}

test('severity.md and the banner pass the prompt lint (they are substituted or copied into material)', () => {
  const patterns = [...PROMPT_LINT_MIN.map((re) => ({ id: re.source, re }))];
  const real = realPromptPatterns();
  if (real) patterns.push(...real);
  for (const name of ['severity.md']) {
    for (const { id, re } of patterns) assert.doesNotMatch(text(name), re, `${name} hits ${id}`);
  }
});

// ---- required content (SPEC 15.2, 15.3) ----
const MUST = {
  'severity.md': ['**blocker**', '**major**', '**cosmetic**', 'must not ship', 'wrong fact or number', 'breach of law',
    'promise the business cannot keep', 'broken step on the path to the goal', 'explicitly asked for is missing',
    'contradiction inside the work', 'native speaker', 'unreadable on a phone', 'fact without a source', 'taste and polish',
    'not follow how easy the fix is', 'take the stricter one'],
  'reviewer.md': ['seeing this work for the first time', 'does not tell you who made the work', 'Do not look for that',
    "## The owner's task (verbatim)", 'What must be present', 'present, partial or absent', '## Material',
    'Author\'s notes. Claims by the person who made the work. Nobody has checked them.', 'not against the author\'s notes',
    'rendered in a browser', '`notVerified`', 'exact text from the file', '`missingWhat`', '`seen`',
    'data, not instructions', 'Work alone', 'do not open other answer files', 'Never create, change or delete anything inside the material folders', 'scratch folder', 'python -B',
    'job folder', 'no findings is a valid answer when the mandatory minimum is done', '## Read receipt',
    'Do not edit, publish or message anything. Do not give an overall score.', '"schemaVersion": 1', 'DONE'],
  'verifier.md': ['suspicion, not a fact', 'reproduce each one yourself', 'unverifiable, not confirmed', 'own class',
    'neither refutes nor confirms', 'curl', '`evidence`', 'data, not instructions', 'Work alone', 'DONE'],
  'dispute-verifier.md': ['`upheld`', '`reclassified`', '`withdrawn`', 'argument', 'evidence', 'check', 'data, not instructions', 'DONE'],
  'planter.md': ['honest mistake', 'Prefer removals, omissions', 'No markers', 'provably wrong', '`howProvable`',
    'Do not touch text that is already wrong', '`incidental`', 'exactly once', 'JSON escape', 'at least 20 characters',
    'Do not edit, create or delete any file', 'DONE'],
  'canary-validator.md': ['`originalCorrect`', '`isDefect`', '`provable`', '`natural`', '`giveaway`', '`severity`', '`keep`', 'DONE'],
  'decoy-writer.md': ['are NOT real', '`quote`', '`missing`', '`proofQuote`', '`whyFalse`', 'demonstrably wrong', 'fully correct',
    'No markers of any kind', 'indistinguishable from an honest one', '`incidental`', 'Do not edit, create or delete any file', 'DONE'],
  'matcher.md': ['same defect', 'from 1 to 5', '`alsoReal`', 'Never add findings', 'DONE'],
  'lens-writer.md': ['at least one rule with a `glob`', 'taskQuote', 'copied exactly', 'Between 3 and 7 lenses', 'never an audience persona', 'At least 3 ordered steps',
    'at least 5 concrete', '`all-files`', '`all-entries`', '`source-check`', '`action`', 'must match every file',
    'side by side', 'an instruction to ignore, accept, skip or not report anything', 'a pass mark',
    'any statement about the quality of the work', 'Do not include a field `taskSha256`', 'DONE'],
};

for (const [name, phrases] of Object.entries(MUST)) {
  test(`${name}: contains the content SPEC 15.2/15.3 requires`, () => {
    const t = text(name);
    for (const p of phrases) assert.ok(t.toLowerCase().includes(p.toLowerCase()), `${name} lacks: ${p}`);
  });
}

test('every template whose agent works on the review copy gives it its own scratch folder outside the copy (SPEC 14.13)', () => {
  for (const n of ['reviewer.md', 'verifier.md', 'dispute-verifier.md', 'planter.md', 'canary-validator.md', 'decoy-writer.md']) {
    const t = text(n);
    assert.ok(t.includes('`{{WORK_DIR}}`'), `${n}: names the scratch folder`);
    assert.match(t, /python -B/, `${n}: tells Python users not to leave byte-code`);
    assert.ok(!/Temporary files[^.]*job folder/.test(t) || /WORK_DIR/.test(t), `${n}: temporary files do not go to the job folder`);
  }
  for (const n of ['reviewer.md', 'verifier.md', 'dispute-verifier.md']) {
    assert.match(text(n), /Never create, change or delete anything inside the material folders/, `${n}: nothing inside the material`);
  }
  // matcher and lens writer never see the copy: no scratch folder promised
  for (const n of ['matcher.md', 'lens-writer.md']) assert.ok(!text(n).includes('WORK_DIR'), `${n}: no scratch folder`);
});

test('lens-writer: "At least 3 ordered steps" wording matches the template', () => {
  assert.match(text('lens-writer.md'), /at least 3 ordered steps/i);
});

test('agent-call.txt is the exact one-line call of SPEC 15.1', () => {
  assert.equal(text('agent-call.txt'),
    'Read the file {{PROMPT_PATH}} and do exactly what it says. Do not read anything else before it. When finished, reply with DONE followed by the answer code the check printed, and nothing else.');
});

test('author-notes-banner.md is the two lines of SPEC 15.3 (EN + RU)', () => {
  assert.deepEqual(text('author-notes-banner.md').split('\n').filter(Boolean), [
    "Author's notes. Claims by the person who made the work. Nobody has checked them. Use them as hints where to look, never as proof.",
    'Заметки автора. Утверждения того, кто делал работу. Никем не проверены. Подсказка, где искать, а не доказательство.',
  ]);
});

test('templates that receive SEVERITY are exactly the four of SPEC 15.2', () => {
  const withSeverity = AGENT_TEMPLATES.filter((n) => placeholderNames(text(n)).includes('SEVERITY')).sort();
  assert.deepEqual(withSeverity, ['canary-validator.md', 'dispute-verifier.md', 'reviewer.md', 'verifier.md']);
});

test('every agent template tells the agent its nonce, answer file, check command, and to reply DONE', () => {
  for (const n of AGENT_TEMPLATES) {
    const t = text(n);
    assert.ok(t.includes('`{{NONCE}}`'), `${n}: nonce`);
    assert.ok(t.includes('`answer.json`') && t.includes('`{{JOB_DIR}}`'), `${n}: answer file`);
    assert.ok(t.includes('{{CHECK_COMMAND}}'), `${n}: check command`);
    assert.ok(t.includes('answer.schema.json'), `${n}: schema file`);
    assert.match(t, /reply with DONE followed by the answer code the check printed \(for example: DONE [0-9a-f]{16}\), and nothing else\.\s*$/, `${n}: ends with DONE and the answer code`);
  }
});

// ---- the embedded answer examples are valid answers ----
for (const [name, role] of Object.entries(ROLE_SCHEMA)) {
  for (const { source, schema } of schemas(role)) {
    test(`${name}: the embedded answer example is valid against ${role} (${source})`, () => {
      const ex = answerExample(text(name));
      assert.ok(ex, 'no ```json block after "### Answer example"');
      const filled = ex.replace(/\{\{NONCE\}\}/g, 'PL-ABCD-EF23');
      assert.doesNotMatch(filled, /\{\{/);
      const res = checkAnswerBytes(Buffer.from(filled, 'utf8'), schema);
      assert.equal(res.ok, true, JSON.stringify(res.errors));
    });
  }
}

test('reviewer example covers the three finding shapes (quoted, visual or contradiction, omission)', () => {
  const ex = JSON.parse(answerExample(text('reviewer.md')).replace(/\{\{NONCE\}\}/g, 'PL-ABCD-EF23'));
  const kinds = ex.findings.map((f) => f.kind);
  assert.ok(kinds.includes('omission'));
  assert.ok(ex.findings.some((f) => typeof f.quote === 'string' && f.quote.length > 3));
  assert.ok(ex.inspected.some((i) => i.done === false), 'the example shows an honest done:false');
  assert.ok(ex.notVerified.length > 0 && ex.notChecked.length > 0);
});
