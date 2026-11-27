/**
 * Evaluation harness.
 *
 * Runs a fixed case set through a template and scores what can be measured
 * mechanically — completion, schema conformance, citation coverage, expected
 * keyword hits — so "did my prompt change help?" has a number behind it instead
 * of an opinion. Model-as-judge scoring is deliberately absent from this file:
 * the judged score is a separate, sampled, blind step (see docs/EVAL.md).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIMIT = 3;

export const DEFAULT_CASES_PATH = fileURLToPath(new URL('../eval/cases.json', import.meta.url));

function keywordScore(text, expected) {
  if (!Array.isArray(expected) || expected.length === 0) return null;
  const hits = expected.filter((word) => text.includes(word));
  return { hits: hits.length, total: expected.length, ratio: Number((hits.length / expected.length).toFixed(3)) };
}

function collectText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Score one finished run; every field is either measured or explicitly null. */
export function scoreRun(caseDef, record) {
  const text = collectText(record.result);
  return {
    caseId: caseDef.id,
    status: record.status,
    agents: record.agentsStarted,
    durationMs: record.durationMs,
    schemaValid: record.result !== null && record.result !== undefined && typeof record.result === 'object',
    anchorCoverage: record.anchors?.coverage ?? null,
    anchors: record.anchors ? `${record.anchors.verified}/${record.anchors.total}` : 'n/a',
    keywords: keywordScore(text, caseDef.expect?.containsAny),
    error: record.error ? String(record.error) : null,
  };
}

function renderReport({ template, rows, startedAt, finishedAt }) {
  const lines = [];
  lines.push(`# AgentFlow 评测报告：${template}`);
  lines.push('');
  lines.push(`- 开始：${startedAt}`);
  lines.push(`- 结束：${finishedAt}`);
  lines.push(`- 用例数：${rows.length}`);
  lines.push('');
  lines.push('| 用例 | 状态 | agent | 耗时(s) | 结构合法 | 锚点覆盖 | 关键词命中 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const kw = row.keywords ? `${row.keywords.hits}/${row.keywords.total}` : '-';
    lines.push(
      `| ${row.caseId} | ${row.status} | ${row.agents} | ${(row.durationMs / 1000).toFixed(1)} | ${
        row.schemaValid ? '是' : '否'
      } | ${row.anchorCoverage === null ? '未测' : row.anchorCoverage} | ${kw} |`,
    );
  }
  const completed = rows.filter((row) => row.status === 'completed').length;
  const valid = rows.filter((row) => row.schemaValid).length;
  const withAnchors = rows.filter((row) => typeof row.anchorCoverage === 'number');
  const coverage = withAnchors.length
    ? Number((withAnchors.reduce((sum, row) => sum + row.anchorCoverage, 0) / withAnchors.length).toFixed(3))
    : null;
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(`- 完成率：${completed}/${rows.length}`);
  lines.push(`- 结构合法率：${valid}/${rows.length}`);
  lines.push(`- 平均锚点覆盖率：${coverage === null ? '未测' : coverage}`);
  lines.push(`- 平均耗时：${(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length / 1000).toFixed(1)}s`);
  lines.push(`- 总 agent 数：${rows.reduce((sum, row) => sum + row.agents, 0)}`);
  lines.push('');
  if (coverage === 0) {
    lines.push('> 锚点覆盖率为 0 通常意味着抓取失败（网络/证书/超时），而不是引用造假；请看 anchors.json 里的 reason。');
  }
  return lines.join('\n');
}

/**
 * Run the cases in order and write a report after each one, so an interrupted
 * evaluation still leaves usable numbers behind.
 */
export async function runEval(flow, options) {
  const {
    template,
    casesPath,
    limit = DEFAULT_LIMIT,
    parent,
    signal,
    onProgress = () => {},
  } = options;

  const all = JSON.parse(await readFile(casesPath, 'utf8'));
  const cases = all
    .filter((entry) => !template || entry.template === template)
    .slice(0, Math.max(1, limit));

  if (cases.length === 0) {
    throw Object.assign(new Error(`no eval cases for template "${template}"`), { code: 'EVAL_NO_CASES' });
  }

  const startedAt = new Date().toISOString();
  const rows = [];
  const dir = join(flow.config.artifactRoot, 'eval');
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, `${template || 'all'}-${startedAt.replace(/[:.]/g, '-')}.md`);

  for (const caseDef of cases) {
    onProgress(`running ${caseDef.id}`);
    let record;
    if (signal?.aborted) break;
    try {
      const outcome = await flow.run(caseDef.template, caseDef.params, { agent: parent, signal });
      record = outcome.record;
    } catch (error) {
      record = {
        status: 'refused',
        agentsStarted: 0,
        durationMs: 0,
        result: null,
        anchors: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    rows.push(scoreRun(caseDef, record));
    await writeFile(reportPath, `${renderReport({ template, rows, startedAt, finishedAt: new Date().toISOString() })}\n`, 'utf8');
  }

  const completed = rows.filter((row) => row.status === 'completed').length;
  const valid = rows.filter((row) => row.schemaValid).length;
  return {
    reportPath,
    summary: {
      cases: rows.length,
      completed,
      schemaValid: valid,
      agents: rows.reduce((sum, row) => sum + row.agents, 0),
      costNote: 'token 用量未计量（引擎不提供子 agent token 账本）',
    },
    rows,
  };
}
