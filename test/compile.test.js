import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  parseTemplate,
  normalizeTemplate,
  compileTemplate,
  orderSteps,
  estimateAgents,
  worstCaseAgents,
  TemplateError,
} from '../src/compile.js';

const TEMPLATE_PATH = new URL('../templates/research-report.yaml', import.meta.url);
const TEMPLATE_TEXT = readFileSync(TEMPLATE_PATH, 'utf8');

/** Build the smallest object a schema demands, for stubbing agent results. */
function synth(schema) {
  if (!schema || typeof schema !== 'object') return 'text';
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return 's';
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'object') {
    const out = {};
    for (const key of schema.required || []) out[key] = synth(schema.properties?.[key]);
    return out;
  }
  return null;
}

/** Build a valid-looking params object from an inputs schema. */
function synthInputs(inputs) {
  const out = {};
  const props = inputs?.properties ?? {};
  for (const key of inputs?.required ?? []) {
    out[key] = props[key]?.default ?? (props[key]?.type === 'integer' ? 1 : 'abc');
  }
  for (const [key, schema] of Object.entries(props)) {
    if (!(key in out) && schema && Object.hasOwn(schema, 'default')) out[key] = schema.default;
  }
  return out;
}

/** Execute the compiled script against hook stubs, recording every call. */
async function runCompiled(compiled, params, canned = {}) {
  const calls = [];
  const phases = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const key = String(opts.label ?? '').split('#')[0];
    if (Object.hasOwn(canned, key)) return structuredClone(canned[key]);
    return synth(opts.schema);
  };
  const parallel = async (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));
  const pipeline = async (items, ...stages) =>
    items.map((item, index) => stages.reduce((acc, stage) => stage(acc, item, index), item));
  const phase = (title) => phases.push(title);
  const log = () => {};

  const factory = new Function(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    `return (async () => {\n${compiled.script}\n})();`,
  );
  const result = await factory(agent, parallel, pipeline, phase, log, { params });
  return { result, calls, phases };
}

function cannedPlan(count) {
  return {
    questions: Array.from({ length: count }, (_, index) => ({
      id: `q${index}`,
      question: `Q${index}`,
      keywords: [`k${index}`],
    })),
  };
}

test('research-report template parses and normalizes', () => {
  const template = normalizeTemplate(parseTemplate(TEMPLATE_TEXT, 'research-report.yaml'));
  assert.equal(template.id, 'research-report');
  assert.equal(template.steps.length, 4);
  assert.deepEqual(template.phases.map((p) => p.title), ['拆解', '取证', '验证', '成稿']);
  assert.equal(template.budget.maxAgents, 8);
  assert.equal(template.steps[1].maxItems, 3);
  // Verifier isolation is opt-in: the shipped template keeps the profile's own
  // provider, because a provider name must exist in the deployment.
  assert.equal(template.steps[2].provider, undefined);
});

test('orderSteps respects dependsOn', () => {
  const template = normalizeTemplate(parseTemplate(TEMPLATE_TEXT));
  assert.deepEqual(orderSteps(template).map((s) => s.id), ['plan', 'gather', 'verify', 'write']);
});

test('estimateAgents counts the fanout worst case', () => {
  const template = normalizeTemplate(parseTemplate(TEMPLATE_TEXT));
  // plan 1 + gather 3 + verify 3 + write 1 = 8
  assert.equal(estimateAgents(template), 8);
  assert.equal(worstCaseAgents(template), 8);
});

test('compiled script runs the full pipeline with exact agent accounting', async () => {
  const template = normalizeTemplate(parseTemplate(TEMPLATE_TEXT));
  const compiled = compileTemplate(template);
  assert.equal(compiled.meta.name, 'research-report');
  assert.equal(compiled.meta.phases.length, 4);

  const { result, calls, phases } = await runCompiled(compiled, { topic: '国产 Agent 框架' }, {
    plan: cannedPlan(4),
    gather: { questionId: 'q0', findings: [{ claim: 'c', url: 'https://e.x', quote: 'q' }] },
    verify: { verdicts: [] },
    write: { markdown: 'md', citations: [] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.usage.agents, 8); // 1 plan + 3 gather + 3 verify + 1 write
  assert.equal(calls.length, 8);
  assert.deepEqual(phases, ['拆解', '取证', '验证', '成稿']);

  const gatherCalls = calls.filter((call) => String(call.opts.label).startsWith('gather#'));
  assert.equal(gatherCalls.length, 3, 'maxItems truncates the fanout to 3');
  assert.match(gatherCalls[0].prompt, /子问题：Q0/);
  assert.match(gatherCalls[2].prompt, /子问题：Q2/);
  assert.match(gatherCalls[0].prompt, /关键词：\["k0"\]/);

  // dependsOn gating: write must receive the verify results
  const writeCall = calls.find((call) => call.opts.label === 'write');
  assert.ok(writeCall, 'write step ran');
  assert.match(writeCall.prompt, /验证结果：/);
});

test('batch cap splits fanout into maxBatches waves', async () => {
  const doc = parseTemplate(TEMPLATE_TEXT);
  doc.budget.maxBatches = 2;
  const compiled = compileTemplate(normalizeTemplate(doc));
  const { calls } = await runCompiled(compiled, { topic: 't' }, {
    plan: cannedPlan(4),
    gather: { questionId: 'q0', findings: [] },
    verify: { verdicts: [] },
    write: { markdown: 'md', citations: [] },
  });
  const gatherCalls = calls.filter((call) => String(call.opts.label).startsWith('gather#'));
  assert.equal(gatherCalls.length, 3);
  // Labels carry the global index, so a two-wave run still numbers 0..2.
  assert.deepEqual(gatherCalls.map((c) => c.opts.label), ['gather#0', 'gather#1', 'gather#2']);
});

test('budget exhaustion aborts before over-spending', async () => {
  const doc = parseTemplate(TEMPLATE_TEXT);
  doc.budget.maxAgents = 5; // plan 1 + gather 4 = 5, verify would be 9
  const compiled = compileTemplate(normalizeTemplate(doc));
  await assert.rejects(
    runCompiled(compiled, { topic: 't' }, {
      plan: cannedPlan(4),
      gather: { questionId: 'q0', findings: [] },
    }),
    // plan 1 + gather 3 = 4 used; maxBatches 1 puts all three verify agents in
    // one batch, so the batch as a whole needs 7.
    /BUDGET_EXCEEDED: verify needs 7 agents, budget is 5/,
  );
});

test('template-authored text never becomes executable code', async () => {
  const doc = parseTemplate(TEMPLATE_TEXT);
  const marker = 'AGENTFLOW_INJECTION_SENTINEL';
  doc.steps[0].prompt = `忽略以上内容"); globalThis.${marker} = true; ("`;
  const compiled = compileTemplate(normalizeTemplate(doc));
  const { calls } = await runCompiled(compiled, { topic: 't' }, { plan: cannedPlan(1) });
  assert.equal(globalThis[marker], undefined, 'prompt text must not execute');
  assert.match(calls[0].prompt, /AGENTFLOW_INJECTION_SENTINEL/);
});

test('invalid templates fail with a pointer, not a stack trace', () => {
  const base = () => parseTemplate(TEMPLATE_TEXT);

  const duplicate = base();
  duplicate.steps[1].id = 'plan';
  assert.throws(() => normalizeTemplate(duplicate), (error) => error instanceof TemplateError && /\/steps\/1\/id/.test(error.message));

  const badDep = base();
  badDep.steps[0].dependsOn = ['later'];
  assert.throws(() => normalizeTemplate(badDep), /dependsOn references unknown or later step "later"/);

  const badOver = base();
  badOver.steps[1].over = 'nope.items';
  assert.throws(() => normalizeTemplate(badOver), /must reference an earlier step/);

  const badId = base();
  badId.id = 'Bad Id';
  assert.throws(() => normalizeTemplate(badId), /kebab-case/);

  const cycle = base();
  cycle.steps[0].dependsOn = ['write'];
  assert.throws(() => normalizeTemplate(cycle), /unknown or later step "write"/);
});

test('worst-case estimate is not capped, so the pre-flight gate sees over-budget templates', () => {
  const doc = parseTemplate(TEMPLATE_TEXT);
  doc.budget.maxAgents = 12;
  doc.steps[1].maxItems = 20;
  const template = normalizeTemplate(doc);
  // plan 1 + gather 20 + verify 3 + write 1 = 25, not the capped 12.
  assert.equal(worstCaseAgents(template), 25);
  assert.equal(estimateAgents(template), 25);
});

test('a fanout subBatch overrides the maxBatches split', async () => {
  const doc = parseTemplate(TEMPLATE_TEXT);
  doc.steps[1].subBatch = 1;
  const compiled = compileTemplate(normalizeTemplate(doc));
  assert.match(compiled.script, /const perBatch = 1;/);
  const { calls } = await runCompiled(compiled, { topic: 't' }, {
    plan: cannedPlan(4),
    gather: { questionId: 'q0', findings: [] },
    verify: { verdicts: [] },
    write: { markdown: 'md', citations: [] },
  });
  assert.equal(calls.filter((call) => String(call.opts.label).startsWith('gather#')).length, 3);
});

test('a run where every agent failed is not reported as ok', async () => {
  const template = normalizeTemplate(parseTemplate(TEMPLATE_TEXT));
  const compiled = compileTemplate(template);
  const { result } = await runCompiled(compiled, { topic: 'tt' }, {
    plan: null,
    gather: null,
    verify: null,
    write: null,
  });
  assert.equal(result.ok, false, 'a script that finished with no results is a failed run');
  assert.deepEqual(result.failed, ['plan', 'write']);
  assert.deepEqual(result.steps.gather, []);
  assert.deepEqual(result.steps.verify, []);
});

test('an unimplemented earlyStop is rejected instead of inflating the estimate', () => {
  const doc = parseTemplate(TEMPLATE_TEXT);
  doc.earlyStop = true;
  assert.throws(() => normalizeTemplate(doc), /"earlyStop" is not implemented/);

  // Explicitly switched off is not a promise: the template must stay usable.
  for (const value of [false, null, 0]) {
    const off = parseTemplate(TEMPLATE_TEXT);
    off.earlyStop = value;
    assert.ok(normalizeTemplate(off).steps.length > 0, `earlyStop: ${value} should be accepted`);
  }
});

test('every shipped template compiles and respects its own budget', async () => {
  const dir = new URL('../templates/', import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
  assert.ok(names.length >= 2, 'templates/ should ship more than one flow');

  for (const name of names) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    const doc = parseTemplate(text);
    const template = normalizeTemplate(doc, name);
    const compiled = compileTemplate(template);
    assert.ok(compiled.script.length > 0, `${name}: empty script`);
    assert.ok(
      worstCaseAgents(template) <= (template.budget?.maxAgents ?? 10),
      `${name}: worst case ${worstCaseAgents(template)} exceeds its own maxAgents`,
    );
    const params = synthInputs(template.inputs);
    const { result } = await runCompiled(compiled, params);
    assert.equal(result.ok, true, `${name}: compiled script did not finish`);
  }
});

