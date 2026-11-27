import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAgentflowRoutes } from '../src/routes.js';

function harness(flow) {
  let registration = null;
  const webServer = {
    register(options) {
      registration = options;
      return () => {
        registration = null;
      };
    },
  };
  const dispose = registerAgentflowRoutes(webServer, flow);
  return { dispose, get registration() { return registration; } };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(text = '') {
      this.body += text;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function call(registration, method, url) {
  const res = fakeRes();
  await registration.handler({ method, url }, res);
  return res;
}

const FLOW = {
  async listTemplates() {
    return [
      { id: 'research-report', valid: true, name: '深度调研报告', description: 'd', estimatedAgents: 8 },
      { id: 'broken', valid: false, error: 'boom' },
    ];
  },
  async recent() {
    return [{ runId: 'run_00000001', template: 'research-report', status: 'completed', agentsStarted: 8 }];
  },
  activeRuns() {
    return [{ runId: 'run_live', phases: ['取证'], agents: 3 }];
  },
  async runDetail(id) {
    return id === 'run_00000001' ? { runId: id, status: 'completed', agents: [] } : null;
  },
};

test('routes expose templates, runs and a single run', async () => {
  const { registration } = harness(FLOW);
  assert.equal(registration.kind, 'prefix');
  assert.equal(registration.path, '/agentflow');

  const index = await call(registration, 'GET', '/agentflow');
  assert.equal(index.statusCode, 200);
  assert.deepEqual(index.json().templates.map((t) => t.id), ['research-report', 'broken']);

  const runs = await call(registration, 'GET', '/agentflow/runs');
  assert.equal(runs.statusCode, 200);
  assert.equal(runs.json().runs[0].runId, 'run_00000001');
  assert.equal(runs.json().running[0].runId, 'run_live');

  const detail = await call(registration, 'GET', '/agentflow/runs/run_00000001');
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().run.status, 'completed');
});

test('unknown run, bad id and unknown path are 404 without leaking details', async () => {
  const { registration } = harness(FLOW);
  assert.equal((await call(registration, 'GET', '/agentflow/runs/run_ffffffff')).json().error, 'run-not-found');
  assert.equal((await call(registration, 'GET', '/agentflow/runs/..%2F..%2Fetc')).statusCode, 404);
  assert.equal((await call(registration, 'GET', '/agentflow/nope')).statusCode, 404);
});

test('non-GET is refused', async () => {
  const { registration } = harness(FLOW);
  const res = await call(registration, 'POST', '/agentflow/runs');
  assert.equal(res.statusCode, 405);
});

test('a throwing flow becomes a 500, not a crash', async () => {
  const { registration } = harness({
    async listTemplates() {
      throw new Error('disk gone');
    },
  });
  const res = await call(registration, 'GET', '/agentflow');
  assert.equal(res.statusCode, 500);
  assert.match(res.json().message, /disk gone/);
});

test('the standalone panel page is served as HTML', async () => {
  const { registration } = harness(FLOW);
  const res = await call(registration, 'GET', '/agentflow/panel');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /AgentFlow 运行面板/);
  assert.match(res.body, /\/agentflow\/runs/);
});

test('dispose removes the registration', () => {
  const h = harness(FLOW);
  assert.ok(h.registration);
  h.dispose();
  assert.equal(h.registration, null);
});
