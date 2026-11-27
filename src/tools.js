/**
 * The model-facing tool surface. Descriptions are deliberately concrete about
 * cost: a model that cannot see the budget will happily fan out 40 agents.
 */
import { BudgetError, extractMarkdown } from './runtime.js';
import { runEval, DEFAULT_CASES_PATH } from './eval.js';

function text(value) {
  return [{ type: 'text', text: value }];
}

function summarizeTemplates(templates) {
  const lines = templates.map((entry) => {
    if (!entry.valid) return `- ${entry.id} (invalid: ${entry.error})`;
    const inputs = Object.keys(entry.inputs?.properties ?? {}).join(', ') || 'none';
    return `- ${entry.id} — ${entry.name}｜${entry.description}｜inputs: ${inputs}｜≤${entry.estimatedAgents} agents`;
  });
  return lines.join('\n');
}

export function buildTools(flow) {
  return [
    {
      name: 'wf_list',
      description:
        'List the AgentFlow workflow templates available in this profile, with their input schema and worst-case agent budget. Call this before wf_run when you do not already know the template id.',
      parameters: {
        verbose: {
          type: 'boolean',
          description: 'Include per-step phases and budget details.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['templates'],
          properties: { templates: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        },
        render: (_args, value) => text(`AgentFlow templates:\n${summarizeTemplates(value.templates)}`),
      },
      async execute(args) {
        const templates = await flow.listTemplates();
        return { templates: args?.verbose ? templates : templates.map(({ steps, ...rest }) => rest) };
      },
    },

    {
      name: 'wf_run',
      description:
        'Run a reusable multi-agent workflow template (research report, codebase audit, …). Prefer this over writing an ad-hoc workflow script when the task matches a listed template: the template carries a hard budget, structured per-step outputs, run artifacts and citation checks. Report the returned artifacts path and the anchor coverage to the user.',
      parameters: {
        template: { type: 'string', required: true, description: 'Template id from wf_list.' },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'Template inputs as plain JSON; defaults fill in missing optional fields.',
        },
        maxAgents: {
          type: 'integer',
          description: 'Optional stricter agent cap for this call. The run is refused before starting if the template cannot fit.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['runId', 'status', 'agentsStarted', 'artifactsDir'],
          properties: {
            runId: { type: 'string' },
            status: { type: 'string' },
            agentsStarted: { type: 'integer' },
            durationMs: { type: 'integer' },
            anchorCoverage: { type: 'number' },
            artifactsDir: { type: 'string' },
            markdown: { type: 'string' },
            error: { type: 'string' },
            failedSteps: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const head = `${value.runId} ${value.status}｜agents ${value.agentsStarted}｜${Math.round((value.durationMs ?? 0) / 1000)}s`;
          const anchors =
            value.anchorCoverage === undefined || value.anchorCoverage === null
              ? 'anchors: none checked'
              : `anchor coverage: ${value.anchorCoverage} (verified / total)`;
          const body = value.markdown ? `\n\n${value.markdown}` : '';
          const problem = value.error ? `\nerror: ${value.error}` : '';
          const failed =
            Array.isArray(value.failedSteps) && value.failedSteps.length > 0
              ? `\nfailed steps: ${value.failedSteps.join(', ')}（agent 返回空，结果不可信）`
              : '';
          return text(`${head}\n${anchors}\nartifacts: ${value.artifactsDir}${failed}${problem}${body}`);
        },
      },
      async execute(args, exec) {
        if (!exec?.agent) throw new Error('wf_run requires a calling agent');
        try {
          const outcome = await flow.run(args.template, args.params ?? {}, {
            agent: exec.agent,
            signal: exec.signal,
            budget: Number.isInteger(args.maxAgents) ? { maxAgents: args.maxAgents } : undefined,
          });
          const record = outcome.record;
          const markdown = extractMarkdown(record.result) ?? undefined;
          return {
            runId: record.runId,
            status: record.status,
            agentsStarted: record.agentsStarted,
            durationMs: record.durationMs,
            ...(record.anchors?.coverage !== null && record.anchors?.coverage !== undefined
              ? { anchorCoverage: record.anchors.coverage }
              : {}),
            artifactsDir: outcome.dir,
            ...(markdown ? { markdown } : {}),
            ...(record.error ? { error: String(record.error) } : {}),
            ...(Array.isArray(record.failedSteps) && record.failedSteps.length ? { failedSteps: record.failedSteps } : {}),
          };
        } catch (error) {
          if (error instanceof BudgetError) throw error;
          throw error;
        }
      },
    },

    {
      name: 'wf_status',
      description:
        'Show recent AgentFlow runs (or one run by id) with status, agent count, duration and citation coverage. Use it to check what ran before, instead of guessing.',
      parameters: {
        runId: { type: 'string', description: 'Specific run id; omit to list recent runs.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['runs'],
          properties: { runs: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        },
        render: (_args, value) => {
          if (value.runs.length === 0) return text('No AgentFlow runs recorded yet.');
          const lines = value.runs.map((run) => {
            const seconds = Math.round((run.durationMs ?? 0) / 1000);
            const coverage = run.anchors?.coverage ?? run.anchorCoverage ?? 'n/a';
            return `- ${run.runId}｜${run.template}｜${run.status}｜${run.agentsStarted ?? '?'} agents｜${seconds}s｜anchors ${coverage}`;
          });
          return text(lines.join('\n'));
        },
      },
      async execute(args) {
        if (args?.runId) {
          const detail = await flow.runDetail(args.runId);
          if (!detail) throw Object.assign(new Error(`no run "${args.runId}"`), { code: 'RUN_NOT_FOUND' });
          return { runs: [detail] };
        }
        const recent = await flow.recent(10);
        const active = flow.activeRuns();
        return { runs: [...active.map((run) => ({ ...run, status: 'running' })), ...recent] };
      },
    },

    {
      name: 'wf_eval',
      description:
        'Run the fixed evaluation case set through a template and write a markdown report: completion, schema conformance, citation coverage and keyword hits, plus agent count and duration per case. Use it after changing a template or its prompts to get a before/after number. Costly: each case is a full workflow run, so start with one or two cases.',
      parameters: {
        template: { type: 'string', description: 'Template id to evaluate; omit to use every case in the set.' },
        cases: {
          type: 'integer',
          description: 'How many cases to run in this call (default 2). Each case is a full workflow run.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['reportPath', 'summary'],
          properties: {
            reportPath: { type: 'string' },
            summary: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => {
          const s = value.summary;
          return text(
            `eval: ${s.completed}/${s.cases} completed｜schema ${s.schemaValid}/${s.cases}｜agents ${s.agents}\n` +
              `${s.costNote}\nreport: ${value.reportPath}`,
          );
        },
      },
      async execute(args, exec) {
        if (!exec?.agent) throw new Error('wf_eval requires a calling agent');
        const result = await runEval(flow, {
          template: args?.template,
          casesPath: DEFAULT_CASES_PATH,
          limit: Number.isInteger(args?.cases) ? args.cases : 2,
          parent: exec.agent,
          signal: exec.signal,
        });
        return { reportPath: result.reportPath, summary: result.summary };
      },
    },
  ];
}
