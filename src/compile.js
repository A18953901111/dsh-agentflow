/**
 * Template compilation: YAML template -> workflow script source.
 *
 * Security invariant: every template-authored string (prompt, label, phase)
 * reaches the script as a JSON string literal, and every runtime value arrives
 * through the script's `args` global. Nothing a template author writes is ever
 * interpolated into executable code.
 *
 * Execution shape (v1): steps run in dependency order, one stage at a time.
 * Parallelism happens *inside* a fanout step, in batches, so the agent budget
 * is exact: the number of agents a batch will start is known before launching.
 */
import yaml from 'js-yaml';

const STEP_KINDS = new Set(['agent', 'fanout']);

export class TemplateError extends Error {
  constructor(message, pointer) {
    super(pointer ? `${message} (at ${pointer})` : message);
    this.name = 'TemplateError';
    this.code = 'TEMPLATE_INVALID';
    this.pointer = pointer;
  }
}

/** Parse YAML text into a plain object, reporting the source file on failure. */
export function parseTemplate(text, source = '<inline>') {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (error) {
    throw new TemplateError(`${source}: invalid YAML — ${error.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TemplateError(`${source}: template must be a mapping`);
  }
  return doc;
}

function requireString(doc, key, pointer) {
  const value = doc[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TemplateError(`"${key}" must be a non-empty string`, pointer);
  }
  return value;
}

/**
 * Validate and normalize a template document.
 * Returns {id, name, description, version, inputs, budget, steps, phases}.
 */
export function normalizeTemplate(doc, source = '<inline>') {
  const id = requireString(doc, 'id', '/id');
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
    throw new TemplateError('"id" must be kebab-case (a-z, 0-9, "-")', '/id');
  }
  const name = requireString(doc, 'name', '/name');
  const description = typeof doc.description === 'string' ? doc.description : '';

  // earlyStop used to be counted in the budget estimate but never compiled into
  // the script, so it inflated the numbers without ever running. Reject it
  // instead of silently promising a feature that does not exist — but only when
  // it is actually switched on: `earlyStop: false` promises nothing.
  if (doc.earlyStop) {
    throw new TemplateError('"earlyStop" is not implemented; remove it from the template', '/earlyStop');
  }

  const inputs = doc.inputs === undefined ? { type: 'object', properties: {} } : doc.inputs;
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TemplateError('"inputs" must be a JSON Schema object', '/inputs');
  }

  const budgetDoc = doc.budget === undefined ? {} : doc.budget;
  if (budgetDoc === null || typeof budgetDoc !== 'object' || Array.isArray(budgetDoc)) {
    throw new TemplateError('"budget" must be a mapping', '/budget');
  }
  const budget = {
    maxAgents: toPositiveInt(budgetDoc.maxAgents, 12, '/budget/maxAgents'),
    maxBatches: toPositiveInt(budgetDoc.maxBatches, 3, '/budget/maxBatches'),
    maxWallClockSec: toPositiveInt(budgetDoc.maxWallClockSec, 600, '/budget/maxWallClockSec'),
  };

  const stepsDoc = doc.steps;
  if (!Array.isArray(stepsDoc) || stepsDoc.length === 0) {
    throw new TemplateError('"steps" must be a non-empty array', '/steps');
  }

  const seen = new Set();
  const steps = stepsDoc.map((raw, index) => {
    const pointer = `/steps/${index}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TemplateError('step must be a mapping', pointer);
    }
    const stepId = requireString(raw, 'id', `${pointer}/id`);
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(stepId)) {
      throw new TemplateError('"id" must match ^[a-z][a-z0-9_]*$', `${pointer}/id`);
    }
    if (seen.has(stepId)) throw new TemplateError(`duplicate step id "${stepId}"`, `${pointer}/id`);
    seen.add(stepId);

    const kind = raw.kind === undefined ? 'agent' : raw.kind;
    if (!STEP_KINDS.has(kind)) {
      throw new TemplateError(`"kind" must be one of ${[...STEP_KINDS].join('|')}`, `${pointer}/kind`);
    }
    const prompt = requireString(raw, 'prompt', `${pointer}/prompt`);
    const phase = typeof raw.phase === 'string' && raw.phase.trim() ? raw.phase : stepId;
    const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [];

    for (const dep of dependsOn) {
      if (!seen.has(dep)) {
        throw new TemplateError(`dependsOn references unknown or later step "${dep}"`, `${pointer}/dependsOn`);
      }
    }

    const step = { id: stepId, kind, phase, prompt, dependsOn, schema: raw.schema, label: raw.label };

    if (kind === 'fanout') {
      const over = requireString(raw, 'over', `${pointer}/over`);
      if (!/^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(over)) {
        throw new TemplateError('"over" must be a step id or step path like "plan.questions"', `${pointer}/over`);
      }
      const [sourceStep] = over.split('.');
      if (!seen.has(sourceStep) || sourceStep === stepId) {
        throw new TemplateError(`"over" must reference an earlier step ("${sourceStep}")`, `${pointer}/over`);
      }
      step.over = over;
      step.as = typeof raw.as === 'string' && /^[a-z][a-z0-9_]*$/.test(raw.as) ? raw.as : 'item';
      step.maxItems = toPositiveInt(raw.maxItems, 8, `${pointer}/maxItems`);
      step.subBatch = raw.subBatch === undefined ? undefined : toPositiveInt(raw.subBatch, 0, `${pointer}/subBatch`);
    }

    if (raw.provider !== undefined) step.provider = String(raw.provider);
    if (raw.model !== undefined) step.model = String(raw.model);

    return step;
  });

  const phases = [];
  const phaseSeen = new Set();
  for (const step of steps) {
    if (phaseSeen.has(step.phase)) continue;
    phaseSeen.add(step.phase);
    phases.push({ title: step.phase });
  }

  return {
    id,
    name,
    description,
    version: Number.isInteger(doc.version) ? doc.version : 1,
    inputs,
    budget,
    steps,
    phases,
    source,
  };
}

function toPositiveInt(value, fallback, pointer) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TemplateError('must be a positive integer', pointer);
  }
  return value;
}

/**
 * Worst-case agent count for a normalized template, ignoring the cap.
 *
 * This number is what the pre-flight gate compares against the budget, so it
 * must stay uncapped: capping it here would make an over-budget template look
 * like it fits and push the failure into the middle of a run, after agents
 * have already started and burned tokens.
 */
export function worstCaseAgents(template) {
  let total = 0;
  for (const step of template.steps) {
    total += step.kind === 'fanout' ? step.maxItems : 1;
  }
  return total;
}

/** Estimate shown to the user. Uncapped for the same reason as worstCaseAgents. */
export function estimateAgents(template) {
  return worstCaseAgents(template);
}

/** Validate that every dependsOn target exists; returns execution order. */
export function orderSteps(template) {
  const byId = new Map(template.steps.map((step) => [step.id, step]));
  const done = new Set();
  const order = [];
  while (order.length < template.steps.length) {
    let progressed = false;
    for (const step of template.steps) {
      if (done.has(step.id)) continue;
      const ready = step.dependsOn.every((dep) => done.has(dep));
      if (!ready) continue;
      order.push(step);
      done.add(step.id);
      progressed = true;
    }
    if (!progressed) {
      const stuck = template.steps.filter((step) => !done.has(step.id)).map((step) => step.id);
      throw new TemplateError(`dependency cycle among steps: ${stuck.join(', ')}`, '/steps');
    }
  }
  for (const step of template.steps) {
    if (!byId.has(step.id)) throw new TemplateError(`unknown step "${step.id}"`, '/steps');
  }
  return order;
}

const DANGEROUS = /\u2028|\u2029/g;

/** JSON literal that is safe to embed in generated script source. */
function lit(value) {
  return JSON.stringify(value).replace(DANGEROUS, (ch) => (ch === '\u2028' ? '\\u2028' : '\\u2029'));
}

function indent(text, pad) {
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

/**
 * Compile a normalized template into the script source the engine executes.
 * Returns {script, meta, plan, estimatedAgents}.
 */
export function compileTemplate(template, overrides = {}) {
  const budget = { ...template.budget, ...overrides };
  const order = orderSteps(template);
  const lines = [];

  lines.push('// Generated by AgentFlow. Do not edit by hand.');
  lines.push(`const __params = (typeof args === "object" && args !== null && args.params) || {};`);
  lines.push(`const __budget = ${lit(budget)};`);
  lines.push('let __used = 0;');
  lines.push('const __phases = [];');
  lines.push('const __resolve = (scope, path) => {');
  lines.push('  const parts = String(path).split(".");');
  lines.push('  let current = scope;');
  lines.push('  for (const part of parts) {');
  lines.push('    if (current === undefined || current === null) return undefined;');
  lines.push('    current = typeof current === "object" ? current[part] : undefined;');
  lines.push('  }');
  lines.push('  return current;');
  lines.push('};');
  lines.push('const __text = (tpl, scope) => String(tpl).replace(/\\{\\{\\s*([a-zA-Z0-9_.]+)\\s*\\}\\}/g, (_m, key) => {');
  lines.push('  let value = __resolve(scope, key);');
  lines.push('  if (value === undefined) value = __resolve(__params, key);');
  lines.push('  if (value === undefined) return "";');
  lines.push('  return typeof value === "string" ? value : JSON.stringify(value);');
  lines.push('});');
  lines.push('const __take = (count, label) => {');
  lines.push('  if (__used + count > __budget.maxAgents) {');
  lines.push('    throw new Error("BUDGET_EXCEEDED: " + label + " needs " + (__used + count) + " agents, budget is " + __budget.maxAgents);');
  lines.push('  }');
  lines.push('  __used += count;');
  lines.push('};');
  lines.push('const __steps = {};');
  // A step whose agent() resolves null did not produce a result. Recording it
  // keeps the run honest: a workflow where every agent failed must not report
  // success just because the script itself finished.
  lines.push('const __failed = [];');

  for (const step of order) {
    const phase = lit(step.phase);
    lines.push('');
    lines.push(`phase(${phase});`);

    const opts = [];
    opts.push(`label: ${lit(step.label || step.id)}`);
    opts.push(`phase: ${phase}`);
    if (step.schema) opts.push(`schema: ${lit(step.schema)}`);
    if (step.provider) opts.push(`provider: ${lit(step.provider)}`);
    if (step.model) opts.push(`model: ${lit(step.model)}`);
    const optsSrc = `{ ${opts.join(', ')} }`;

    if (step.kind === 'agent') {
      lines.push(`__take(1, ${lit(step.id)});`);
      lines.push(`{`);
      lines.push(`  const value = await agent(__text(${lit(step.prompt)}, __steps), ${optsSrc});`);
      lines.push(`  if (value === null || value === undefined) __failed.push(${lit(step.id)});`);
      lines.push(`  __steps[${lit(step.id)}] = value;`);
      lines.push(`}`);
      continue;
    }

    const sourceId = step.over.split('.')[0];
    const restPath = step.over.split('.').slice(1).join('.');
    const rawVar = `__raw_${step.id}`;
    const varName = `__items_${step.id}`;
    const outVar = `__out_${step.id}`;

    lines.push(`const ${rawVar} = (() => {`);
    lines.push(`  const source = __steps[${lit(sourceId)}];`);
    lines.push(restPath ? `  const list = __resolve(source, ${lit(restPath)});` : '  const list = source;');
    lines.push(`  return Array.isArray(list) ? list : [];`);
    lines.push('})();');
    // maxItems is a hard truncation, not just an estimate input: the fanout and
    // the budget must agree on how many agents a step can start.
    lines.push(`const ${varName} = ${rawVar}.slice(0, ${step.maxItems});`);
    lines.push(`if (${varName}.length < ${rawVar}.length) log(${lit(step.id)} + ": truncated " + ${rawVar}.length + " items to " + ${varName}.length + " (maxItems)");`);
    lines.push(`const ${outVar} = [];`);
    lines.push(`{`);
    lines.push(`  const total = ${varName}.length;`);
    lines.push(`  const perBatch = ${step.subBatch ? lit(step.subBatch) : 'Math.max(1, Math.ceil(total / __budget.maxBatches))'};`);
    lines.push(`  for (let start = 0; start < total; start += perBatch) {`);
    lines.push(`    const slice = ${varName}.slice(start, start + perBatch);`);
    lines.push('    __take(slice.length, ' + lit(step.id) + ');');
    lines.push(`    const batch = await parallel(slice.map((item, offset) => () => agent(`);
    lines.push(`      __text(${lit(step.prompt)}, Object.assign({}, __steps, { ${lit(step.as)}: item, index: start + offset })),`);
    lines.push(`      Object.assign({}, ${optsSrc}, { label: ${lit(step.id)} + "#" + String(start + offset) })`);
    lines.push(`    )));`);
    lines.push(`    const missed = batch.filter((entry) => entry === null || entry === undefined).length;`);
    lines.push(`    if (missed > 0) __failed.push(${lit(step.id)} + "+" + String(missed));`);
    lines.push(`    ${outVar}.push(...batch);`);
    lines.push(`  }`);
    lines.push('}');
    lines.push(`__steps[${lit(step.id)}] = ${outVar}.filter((entry) => entry !== null && entry !== undefined);`);
  }

  lines.push('');
  lines.push('return { ok: __failed.length === 0, failed: __failed, steps: __steps, usage: { agents: __used } };');

  const meta = {
    name: template.id,
    description: template.description || template.name,
    phases: template.phases,
    whenToUse: `Run the "${template.name}" workflow.`,
  };

  return {
    script: `${lines.join('\n')}\n`,
    meta,
    plan: order.map((step) => ({ id: step.id, kind: step.kind, phase: step.phase })),
    estimatedAgents: worstCaseAgents(template),
    budget,
  };
}
