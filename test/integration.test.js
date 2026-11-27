/**
 * End-to-end wiring test with a stub engine.
 *
 * The real engine needs a live Harness process, but everything AgentFlow owns —
 * tool registration, template loading, budget refusal, script execution,
 * artifact writing, run records — can be exercised with a deterministic engine
 * stub that runs the compiled script against hook stubs and emits the same
 * workflow/* events the real engine emits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { removeDir } from './_cleanup.js';
import { apply } from '../index.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

function makeBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

function makeEngine(bus, calls, canned = {}) {
  let counter = 0;
  return {
    start({ script, meta, args }) {
      counter += 1;
      const id = `run_test${String(counter).padStart(4, '0')}`;
      const result = (async () => {
        // The real engine runs the script out of process, so no agent can start
        // before start() returns. Deferring one microtask keeps the stub honest.
        await Promise.resolve();
        const agent = async (prompt, opts = {}) => {
          const seq = calls.length;
          calls.push({ prompt, label: opts.label });
          bus.emit('workflow/agent-start', { id }, { seq, label: opts.label, phase: opts.phase, childId: `child_${seq}` });
          const key = String(opts.label ?? '').split('#')[0];
          const value = Object.hasOwn(canned, key) ? structuredClone(canned[key]) : { ok: true };
          bus.emit('workflow/agent-end', { id }, { seq, outcome: 'completed' });
          return value;
        };
        const parallel = async (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));
        const pipeline = async (items) => items;
        const phase = (title) => bus.emit('workflow/phase', { id }, title);
        const log = (message) => bus.emit('workflow/log', { id }, message);
        const factory = new Function(
          'agent', 'parallel', 'pipeline', 'phase', 'log', 'args',
          `return (async () => {\n${script}\n})();`,
        );
        const value = await factory(agent, parallel, pipeline, phase, log, args);
        return { stopReason: 'completed', value, agentsStarted: calls.length };
      })();
      return {
        id,
        meta,
        result,
        cancel() {},
        async dispose() {},
      };
    },
  };
}

async function setup(canned = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-int-'));
  const calls = [];
  const registered = [];
  const bus = makeBus();
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: { section() {} },
    effect: (fn) => fn(),
    on: (event, handler) => bus.on(event, handler),
    get: () => undefined,
    workflowEngine: makeEngine(bus, calls, canned),
    logger: { warn() {} },
  };
  const config = {
    markerPath: join(root, 'smoke.json'),
    artifactRoot: join(root, 'artifacts'),
    templateDir: options.templateDir ?? TEMPLATE_DIR,
    anchorCheck: false,
  };
  await apply(ctx, config);
  return { root, calls, registered, ctx, config };
}

const CANNED = {
  plan: { questions: [1, 2].map((n) => ({ id: `q${n}`, question: `Q${n}`, keywords: [`k${n}`] })) },
  gather: { questionId: 'q1', findings: [{ claim: 'c', url: 'https://example.com', quote: 'q' }] },
  verify: { verdicts: [{ claim: 'c', support: 'strong', reason: 'r' }] },
  write: { markdown: '# report\nbody', citations: [{ n: 1, url: 'https://example.com' }] },
};

test('apply registers the tool surface and reports loaded templates', async () => {
  const { root, registered } = await setup();
  try {
    assert.deepEqual(registered.map((tool) => tool.name), ['wf_list', 'wf_run', 'wf_status', 'wf_eval']);
    for (const tool of registered) {
      assert.equal(typeof tool.execute, 'function');
      assert.equal(typeof tool.output.schema, 'object');
      assert.equal(typeof tool.output.render, 'function');
    }
    const marker = JSON.parse(await readFile(join(root, 'smoke.json'), 'utf8'));
    assert.deepEqual(marker.registered, ['wf_list', 'wf_run', 'wf_status', 'wf_eval']);
    assert.equal(marker.engine, true);
    assert.ok(
      marker.templates.every((template) => template.valid === true),
      'every shipped template must load valid',
    );
    assert.deepEqual(
      marker.templates.map((template) => template.id).sort(),
      ['codebase-audit', 'research-report', 'smoke'],
    );
    assert.equal(marker.error, null);
  } finally {
    await removeDir(root);
  }
});

test('wf_list returns template metadata with input schema', async () => {
  const { root, registered } = await setup();
  try {
    const listTool = registered.find((tool) => tool.name === 'wf_list');
    const value = await listTool.execute({ verbose: true }, {});
    const template = value.templates.find((entry) => entry.id === 'research-report');
    assert.equal(template.valid, true);
    assert.equal(template.inputs.required[0], 'topic');
    assert.equal(template.steps.length, 4);
    assert.equal(template.budget.maxAgents, 8);
  } finally {
    await removeDir(root);
  }
});

test('wf_run executes the compiled script and persists artifacts', async () => {
  const { root, registered, calls } = await setup(CANNED);
  try {
    const runTool = registered.find((tool) => tool.name === 'wf_run');
    const value = await runTool.execute(
      { template: 'research-report', params: { topic: '国产 Agent 框架' } },
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    );

    assert.equal(value.status, 'completed');
    assert.equal(value.agentsStarted, 6); // 1 plan + 2 gather + 2 verify + 1 write
    assert.equal(calls.length, 6);
    assert.match(value.markdown, /report/);
    assert.ok(value.artifactsDir.includes(value.runId));

    const files = await readdir(value.artifactsDir);
    assert.ok(files.includes('run.json'));
    assert.ok(files.includes('trace.jsonl'));
    assert.ok(files.includes('result.md'));

    const record = JSON.parse(await readFile(join(value.artifactsDir, 'run.json'), 'utf8'));
    assert.equal(record.status, 'completed');
    assert.equal(record.template, 'research-report');
    assert.equal(record.params.depth, 'quick', 'defaults applied');

    const index = JSON.parse(await readFile(join(root, 'artifacts', 'index.json'), 'utf8'));
    assert.equal(index.runs[0].runId, value.runId);
  } finally {
    await removeDir(root);
  }
});

test('a run whose agents all fail is recorded as failed, not completed', async () => {
  const allNull = { plan: null, gather: null, verify: null, write: null };
  const { root, registered, calls } = await setup(allNull);
  try {
    const runTool = registered.find((tool) => tool.name === 'wf_run');
    const value = await runTool.execute(
      { template: 'research-report', params: { topic: '国产 Agent 框架' } },
      { agent: { id: 'agent-1' } },
    );

    assert.equal(value.status, 'failed', 'two failed agents must not look like success');
    assert.deepEqual(value.failedSteps, ['plan', 'write']);

    const record = JSON.parse(await readFile(join(value.artifactsDir, 'run.json'), 'utf8'));
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.failedSteps, ['plan', 'write']);
    assert.equal(record.result.ok, false);
    assert.equal(calls.length, 2, 'fanouts had nothing to expand, so only plan and write ran');
  } finally {
    await removeDir(root);
  }
});

test('wf_run refuses an over-budget call before starting any agent', async () => {
  const { root, registered, calls } = await setup(CANNED);
  try {
    const runTool = registered.find((tool) => tool.name === 'wf_run');
    await assert.rejects(
      runTool.execute({ template: 'research-report', params: { topic: 'xy' }, maxAgents: 3 }, { agent: { id: 'a' } }),
      (error) => error.code === 'BUDGET_EXCEEDED' && /up to 8 agents/.test(error.message),
    );
    assert.equal(calls.length, 0, 'no agent may start when the budget check fails');
    assert.equal(existsSync(join(root, 'artifacts', 'runs')), false);
  } finally {
    await removeDir(root);
  }
});

test('a template that cannot fit its own budget is refused before the engine starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-int-'));
  try {
    const templateDir = join(root, 'templates');
    await mkdir(templateDir, { recursive: true });
    const source = await readFile(join(TEMPLATE_DIR, 'research-report.yaml'), 'utf8');
    const shrink = source
      .replace('id: research-report', 'id: over-budget')
      .replace('maxAgents: 8', 'maxAgents: 3');
    await writeFile(join(templateDir, 'over-budget.yaml'), shrink, 'utf8');

    const { registered, calls } = await setup(CANNED, { templateDir });
    const runTool = registered.find((tool) => tool.name === 'wf_run');
    await assert.rejects(
      runTool.execute({ template: 'over-budget', params: { topic: 'tt' } }, { agent: { id: 'a' } }),
      (error) => error.code === 'BUDGET_EXCEEDED' && /up to 8 agents/.test(error.message) && /allowed budget is 3/.test(error.message),
    );
    assert.equal(calls.length, 0, 'no agent may start for an impossible budget');
    assert.equal(existsSync(join(root, 'artifacts', 'runs')), false);
  } finally {
    await removeDir(root);
  }
});

test('wf_run rejects invalid params with a field-level message', async () => {
  const { root, registered } = await setup(CANNED);
  try {
    const runTool = registered.find((tool) => tool.name === 'wf_run');
    await assert.rejects(
      runTool.execute({ template: 'research-report', params: { topic: '' } }, { agent: { id: 'a' } }),
      (error) => error.code === 'PARAMS_INVALID' && /minLength|shorter/.test(error.message),
    );
    await assert.rejects(
      runTool.execute({ template: 'nope', params: {} }, { agent: { id: 'a' } }),
      /unknown template/,
    );
  } finally {
    await removeDir(root);
  }
});

test('wf_status lists the recorded run with its agent timeline', async () => {
  const { root, registered } = await setup(CANNED);
  try {
    const runTool = registered.find((tool) => tool.name === 'wf_run');
    const statusTool = registered.find((tool) => tool.name === 'wf_status');
    const value = await runTool.execute({ template: 'research-report', params: { topic: 'tt' } }, { agent: { id: 'a' } });
    const listed = await statusTool.execute({}, {});
    assert.equal(listed.runs[0].runId, value.runId);

    const detail = await statusTool.execute({ runId: value.runId }, {});
    assert.equal(detail.runs[0].status, 'completed');
    assert.equal(detail.runs[0].agents.length, 6);
    assert.deepEqual(detail.runs[0].phases.map((phase) => phase.title), ['拆解', '取证', '验证', '成稿']);
  } finally {
    await removeDir(root);
  }
});

