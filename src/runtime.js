/**
 * AgentFlow runtime: template discovery, budgeted execution, tracing, artifacts.
 *
 * Ownership rule from the engine contract: the caller owns every run it starts,
 * so `run()` disposes in `finally` and never leaves a run dangling. Budget is
 * enforced twice on purpose — the script refuses to start an agent past the cap
 * (deterministic, per batch), and the host cancels on wall-clock.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  TemplateError,
  compileTemplate,
  normalizeTemplate,
  parseTemplate,
  worstCaseAgents,
} from './compile.js';
import { applyDefaults, validate } from './schema.js';
import { collectAnchors, verifyAnchors } from './anchors.js';
import { createStore } from './store.js';

const DEFAULT_TEMPLATE_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/**
 * Pull the human-readable report out of a finished script value.
 *
 * The step that writes prose is not always called `write`: the audit template's
 * last step is `report`, and hardcoding `steps.write.markdown` silently skipped
 * `result.md` for it. Accept a top-level `markdown` first, then the first step
 * that carries one.
 */
export function extractMarkdown(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.markdown === 'string' && value.markdown.trim()) return value.markdown;
  const steps = value.steps;
  if (!steps || typeof steps !== 'object') return null;
  for (const step of Object.values(steps)) {
    if (step && typeof step === 'object' && typeof step.markdown === 'string' && step.markdown.trim()) {
      return step.markdown;
    }
  }
  return null;
}


export class BudgetError extends Error {
  constructor(needed, allowed, wallClockSec) {
    super(
      `BUDGET_EXCEEDED: this template can start up to ${needed} agents, the allowed budget is ${allowed}` +
        (wallClockSec ? ` (wall clock ${wallClockSec}s)` : '') +
        '. Raise budget.maxAgents deliberately if that cost is intended.',
    );
    this.name = 'BudgetError';
    this.code = 'BUDGET_EXCEEDED';
    this.needed = needed;
    this.allowed = allowed;
  }
}

export class AgentFlow {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = {
      templateDir: typeof config.templateDir === 'string' && config.templateDir ? config.templateDir : DEFAULT_TEMPLATE_DIR,
      artifactRoot:
        typeof config.artifactRoot === 'string' && config.artifactRoot
          ? config.artifactRoot
          : join(homedir(), '.dsh', 'agentflow'),
      anchorCheck: config.anchorCheck !== false,
      // 'auto' verifies certificates first and retries without verification
      // only when the chain is untrusted (TLS-intercepting proxies), noting it.
      anchorTls: config.anchorTls === 'strict' || config.anchorTls === 'insecure' ? config.anchorTls : 'auto',
      defaultMaxAgents: Number.isInteger(config.defaultMaxAgents) ? config.defaultMaxAgents : 0,
    };
    this.store = createStore(this.config.artifactRoot);
    this.templates = new Map();
    this.loadedAt = 0;
    this.active = new Map();
    this.off = [];
    this.#subscribe();
  }

  #subscribe() {
    const on = (event, handler) => {
      const dispose = this.ctx.on(event, handler);
      if (typeof dispose === 'function') this.off.push(dispose);
    };

    on('workflow/agent-start', (info, agent) => {
      const collector = this.active.get(info?.id);
      if (!collector) return;
      collector.agents.push({
        seq: agent?.seq ?? collector.agents.length,
        label: agent?.label ?? '',
        phase: agent?.phase ?? null,
        childId: agent?.childId ?? null,
        startedAt: Date.now(),
        endedAt: null,
        outcome: null,
      });
    });

    on('workflow/agent-end', (info, agent) => {
      const collector = this.active.get(info?.id);
      if (!collector) return;
      const entry = collector.agents.find((candidate) => candidate.seq === agent?.seq);
      if (entry) {
        entry.endedAt = Date.now();
        entry.outcome = agent?.outcome ?? 'unknown';
      }
    });

    on('workflow/phase', (info, title) => {
      const collector = this.active.get(info?.id);
      if (!collector) return;
      collector.phases.push({ title: String(title), at: Date.now() });
    });

    on('workflow/log', (info, message) => {
      const collector = this.active.get(info?.id);
      if (!collector || collector.logs.length >= 200) return;
      collector.logs.push(String(message));
    });
  }

  dispose() {
    for (const off of this.off) {
      try {
        off();
      } catch {
        // A failing disposer must not block the rest.
      }
    }
    this.off = [];
    this.active.clear();
  }

  /** Load templates from disk, cached by directory mtime. */
  async loadTemplates() {
    const dir = this.config.templateDir;
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch (error) {
      // Only "no template directory" means there are no templates. A permission
      // or I/O failure must surface instead of pretending the template vanished.
      if (error?.code === 'ENOENT') {
        this.templates = new Map();
        return this.templates;
      }
      throw Object.assign(new Error(`template directory "${dir}" is unreadable: ${error?.message ?? error}`), {
        code: 'TEMPLATE_DIR_UNREADABLE',
      });
    }
    // Templates are re-read on every call: authors edit these files while the
    // profile is live, and a directory-mtime cache misses content edits.
    const files = (await readdir(dir)).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));
    const next = new Map();
    for (const file of files) {
      // Per-file isolation: one unreadable template must not take the rest down.
      let source;
      try {
        source = await readFile(join(dir, file), 'utf8');
      } catch (error) {
        const id = file.replace(/\.ya?ml$/u, '');
        next.set(id, { template: null, file, error: `cannot read template file: ${error?.message ?? error}` });
        continue;
      }
      try {
        const template = normalizeTemplate(parseTemplate(source, file), file);
        next.set(template.id, { template, file, error: null });
      } catch (error) {
        const id = file.replace(/\.ya?ml$/u, '');
        next.set(id, { template: null, file, error: error instanceof TemplateError ? error.message : String(error) });
      }
    }
    this.templates = next;
    this.loadedAt = dirStat.mtimeMs;
    return next;
  }

  async getTemplate(id) {
    const templates = await this.loadTemplates();
    const entry = templates.get(id);
    if (!entry) {
      const available = [...templates.keys()].join(', ') || '(none)';
      throw Object.assign(new Error(`unknown template "${id}". Available: ${available}`), { code: 'TEMPLATE_NOT_FOUND' });
    }
    if (entry.error) {
      throw Object.assign(new Error(`template "${id}" is invalid: ${entry.error}`), { code: 'TEMPLATE_INVALID' });
    }
    return entry.template;
  }

  async listTemplates() {
    const templates = await this.loadTemplates();
    return [...templates.entries()].map(([id, entry]) => {
      if (entry.error) {
        return { id, file: entry.file, valid: false, error: entry.error };
      }
      const template = entry.template;
      return {
        id,
        file: entry.file,
        valid: true,
        name: template.name,
        description: template.description,
        version: template.version,
        inputs: template.inputs,
        budget: template.budget,
        estimatedAgents: worstCaseAgents(template),
        steps: template.steps.map((step) => ({ id: step.id, kind: step.kind, phase: step.phase })),
      };
    });
  }

  /**
   * Run a template. Returns a run record; never throws for a failed run, only
   * for requests that cannot start (unknown template, bad params, budget).
   */
  async run(id, params, options = {}) {
    const template = await this.getTemplate(id);
    const prepared = applyDefaults(template.inputs, { ...(params ?? {}) });
    const problems = validate(template.inputs, prepared);
    if (problems.length > 0) {
      throw Object.assign(new Error(`params for "${id}" failed validation:\n- ${problems.join('\n- ')}`), {
        code: 'PARAMS_INVALID',
        details: problems,
      });
    }

    const requested = Number.isInteger(options.budget?.maxAgents) ? options.budget.maxAgents : template.budget.maxAgents;
    const allowed = Math.max(1, Math.min(template.budget.maxAgents, requested, this.config.defaultMaxAgents || Infinity));
    // Compare the uncapped worst case: capping it here would let a template
    // that cannot fit slip through and die mid-run, after spending tokens.
    const worst = worstCaseAgents(template);
    if (worst > allowed) {
      throw new BudgetError(worst, allowed, template.budget.maxWallClockSec);
    }

    const compiled = compileTemplate(template, { maxAgents: allowed });
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    let run;
    try {
      run = this.ctx.workflowEngine.start({
        script: compiled.script,
        meta: compiled.meta,
        args: { params: prepared },
        parent: options.agent,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw Object.assign(new Error(`workflow engine refused the run: ${error?.message ?? error}`), {
        code: 'ENGINE_START_FAILED',
      });
    }

    const collector = { runId: run.id, phases: [], agents: [], logs: [], timedOut: false };
    this.active.set(run.id, collector);

    const wallClockSec = template.budget.maxWallClockSec;
    const timer = Number.isFinite(wallClockSec) && wallClockSec > 0
      ? setTimeout(() => {
          collector.timedOut = true;
          try {
            run.cancel('BUDGET_WALL_CLOCK');
          } catch {
            // Cancellation is best effort; the result promise reports the truth.
          }
        }, wallClockSec * 1000)
      : null;

    let result;
    try {
      result = await run.result;
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(run.id);
      try {
        await run.dispose();
      } catch {
        // Dispose failures are reported through the record, never thrown here.
      }
    }

    // A script that finished is not a workflow that succeeded: every agent may
    // have resolved null. The compiled script reports that through `ok`.
    const scriptOk = result?.value?.ok !== false;
    const status = result?.stopReason !== 'completed'
      ? (collector.timedOut ? 'timeout' : (result?.stopReason ?? 'error'))
      : (scriptOk ? 'completed' : 'failed');
    const failedSteps = Array.isArray(result?.value?.failed) ? result.value.failed : [];

    let anchors = null;
    if (this.config.anchorCheck && result?.stopReason === 'completed' && scriptOk && result.value !== undefined) {
      try {
        const found = collectAnchors(result.value);
        if (found.length > 0) anchors = await verifyAnchors(found, { tls: this.config.anchorTls });
      } catch (error) {
        anchors = { total: 0, verified: 0, mismatch: 0, unreachable: 0, coverage: null, error: String(error?.message ?? error) };
      }
    }

    const record = {
      runId: run.id,
      template: template.id,
      templateVersion: template.version,
      params: prepared,
      status,
      stopReason: result?.stopReason ?? 'error',
      error: result?.error ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      budget: compiled.budget,
      agentsStarted: result?.agentsStarted ?? collector.agents.length,
      scriptAgents: result?.value?.usage?.agents ?? null,
      failedSteps,
      phases: collector.phases,
      agents: collector.agents,
      anchors: anchors
        ? { total: anchors.total, verified: anchors.verified, mismatch: anchors.mismatch, unreachable: anchors.unreachable, coverage: anchors.coverage }
        : null,
      result: result?.value ?? null,
    };

    const dir = this.store.dirOf(run.id);
    // Each artifact is written independently: a failing trace write must not
    // take the finished report (result.md) or the anchor details with it.
    const artifacts = [];
    artifacts.push(['run.json', () => this.store.writeRun(run.id, record)]);
    artifacts.push(['trace.jsonl', () => this.store.writeText(run.id, 'trace.jsonl', `${collector.agents.map((entry) => JSON.stringify(entry)).join('\n')}\n`)]);
    const markdown = extractMarkdown(result?.value);
    if (markdown) {
      artifacts.push(['result.md', () => this.store.writeText(run.id, 'result.md', markdown.endsWith('\n') ? markdown : `${markdown}\n`)]);
    }
    if (anchors?.details?.length) {
      artifacts.push(['anchors.json', () => this.store.writeText(run.id, 'anchors.json', `${JSON.stringify(anchors.details, null, 2)}\n`)]);
    }

    const failures = [];
    for (const [name, write] of artifacts) {
      try {
        await write();
      } catch (error) {
        failures.push(`${name}: ${error?.message ?? error}`);
      }
    }
    if (failures.length > 0) {
      record.artifactError = failures.join('; ');
      try {
        await this.store.writeRun(run.id, record);
      } catch {
        // Best effort only; the record still returns to the caller.
      }
    }

    // Indexing is independent of the artifacts above: a run whose trace write
    // failed must still show up in wf_status's recent list.
    try {
      await this.store.record({
        runId: run.id,
        template: template.id,
        status,
        startedAt,
        durationMs: record.durationMs,
        agentsStarted: record.agentsStarted,
        anchorCoverage: record.anchors?.coverage ?? null,
        dir,
      });
    } catch (error) {
      record.indexError = String(error?.message ?? error);
      // Persist the failure: a memory-only field is invisible to the next
      // reader, and the run would look like it never existed in wf_status.
      try {
        await this.store.writeRun(run.id, record);
      } catch {
        // Best effort; the artifacts themselves are already on disk.
      }
    }

    return { record, dir, value: result?.value ?? null };
  }

  async recent(limit = 10) {
    return this.store.list(limit);
  }

  async runDetail(runId) {
    return this.store.read(runId);
  }

  activeRuns() {
    return [...this.active.values()].map((collector) => ({
      runId: collector.runId,
      phases: collector.phases.map((phase) => phase.title),
      agents: collector.agents.length,
    }));
  }
}
