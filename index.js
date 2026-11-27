/**
 * AgentFlow host entry.
 *
 * `apply` only wires things together; all logic lives in `src/`. Activation
 * writes a marker file when `config.markerPath` is set (used during development
 * and in installation checks); it is off by default.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const name = 'agentflow';
// webServer is a hard dependency on purpose: as an optional service it can still
// be undefined at apply() time, and the routes would be skipped silently
// (observed: `routes: false` while the panel showed HTTP 404).
export const inject = ['tools', 'workflowEngine', 'systemPrompt', 'webServer'];
export const VERSION = '0.7.0';

const PROMPT_SECTION = `AgentFlow provides reusable multi-agent workflow templates through the wf_* tools. Use wf_list to see templates and wf_run to execute one when the user's request matches it (deep research report, codebase audit). Each template carries a hard agent budget, validates its inputs, writes run artifacts (run.json, trace.jsonl, result.md) and verifies citation anchors against their sources. Prefer wf_run over an ad-hoc workflow script when a template fits; use the built-in workflow tool for one-off orchestration.`;

async function writeMarker(markerPath, report) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) return;
  try {
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    // Never break activation because of a diagnostic write.
  }
}

export async function apply(ctx, config = {}) {
  const report = {
    plugin: 'agentflow',
    version: VERSION,
    at: new Date().toISOString(),
    toolsService: typeof ctx?.tools?.register === 'function',
    engine: typeof ctx?.workflowEngine?.start === 'function',
    registered: [],
    templates: [],
    promptSection: false,
    routes: false,
    artifactRoot: null,
    error: null,
  };

  try {
    // Deferred imports: a broken module graph must still leave a marker that
    // says why, instead of failing before this function ever runs.
    const [{ AgentFlow }, { buildTools }, { registerAgentflowRoutes }] = await Promise.all([
      import('./src/runtime.js'),
      import('./src/tools.js'),
      import('./src/routes.js'),
    ]);

    const flow = new AgentFlow(ctx, config);
    report.artifactRoot = flow.config.artifactRoot;

    const tools = buildTools(flow);
    for (const tool of tools) {
      ctx.tools.register(tool);
      report.registered.push(tool.name);
    }

    // Read-only routes for the panel; webServer is a declared dependency, so it
    // must be present here, but the lookup stays defensive.
    const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
    if (webServer && typeof webServer.register === 'function') {
      try {
        const disposeRoutes = registerAgentflowRoutes(webServer, flow);
        report.routes = true;
        if (typeof ctx.effect === 'function') ctx.effect(() => disposeRoutes);
      } catch (error) {
        report.routesError = String(error?.message ?? error);
      }
    } else {
      report.routes = false;
    }

    if (typeof ctx.systemPrompt?.section === 'function') {
      try {
        ctx.systemPrompt.section({ name: 'tool:agentflow', order: 120, text: PROMPT_SECTION });
        report.promptSection = true;
      } catch (error) {
        report.promptWarning = String(error?.message ?? error);
      }
    }

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => flow.dispose());
    }

    try {
      const templates = await flow.listTemplates();
      report.templates = templates.map((template) =>
        template.valid
          ? { id: template.id, valid: true, steps: template.steps.length, estimatedAgents: template.estimatedAgents }
          : { id: template.id, valid: false, error: template.error },
      );
    } catch (error) {
      report.templateError = String(error?.message ?? error);
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  }

  await writeMarker(config?.markerPath, report);
}

