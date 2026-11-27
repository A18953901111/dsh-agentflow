import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { removeDir } from './_cleanup.js';
import { scoreRun, runEval } from '../src/eval.js';

function record(overrides = {}) {
  return {
    status: 'completed',
    agentsStarted: 8,
    durationMs: 120000,
    result: { markdown: '定价按 token 计算', citations: [] },
    anchors: { total: 4, verified: 3, mismatch: 1, unreachable: 0, coverage: 0.75 },
    error: null,
    ...overrides,
  };
}

test('scoreRun reports only measured numbers', () => {
  const score = scoreRun({ id: 'c1', expect: { containsAny: ['token', '上下文'] } }, record());
  assert.equal(score.status, 'completed');
  assert.equal(score.schemaValid, true);
  assert.equal(score.anchorCoverage, 0.75);
  assert.deepEqual(score.keywords, { hits: 1, total: 2, ratio: 0.5 });
});

test('scoreRun marks missing anchors as not measured, not as zero', () => {
  const score = scoreRun({ id: 'c2' }, record({ anchors: null }));
  assert.equal(score.anchorCoverage, null);
  assert.equal(score.anchors, 'n/a');
});

test('runEval writes a report after each case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-eval-'));
  const casesPath = join(root, 'cases.json');
  await writeFile(
    casesPath,
    JSON.stringify([
      { id: 'a', template: 'smoke', params: { topic: 'x' } },
      { id: 'b', template: 'smoke', params: { topic: 'y' } },
    ]),
  );
  const flow = {
    config: { artifactRoot: join(root, 'artifacts') },
    async run() {
      return { record: record() };
    },
  };
  try {
    const result = await runEval(flow, { template: 'smoke', casesPath, limit: 2, parent: {} });
    assert.equal(result.summary.cases, 2);
    assert.equal(result.summary.completed, 2);
    assert.equal(result.summary.agents, 16);
    const report = await readFile(result.reportPath, 'utf8');
    assert.match(report, /评测报告/);
    assert.match(report, /\| a \| completed \| 8 \|/);
    assert.match(report, /平均锚点覆盖率：0.75/);
  } finally {
    await removeDir(root);
  }
});

test('a refused case is recorded without failing the whole evaluation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-eval-'));
  const casesPath = join(root, 'cases.json');
  await writeFile(casesPath, JSON.stringify([{ id: 'bad', template: 'smoke', params: {} }]));
  const flow = {
    config: { artifactRoot: join(root, 'artifacts') },
    async run() {
      throw Object.assign(new Error('BUDGET_EXCEEDED: nope'), { code: 'BUDGET_EXCEEDED' });
    },
  };
  try {
    const result = await runEval(flow, { template: 'smoke', casesPath, limit: 1, parent: {} });
    assert.equal(result.rows[0].status, 'refused');
    assert.match(result.rows[0].error, /BUDGET_EXCEEDED/);
    assert.equal(result.summary.completed, 0);
  } finally {
    await removeDir(root);
  }
});
