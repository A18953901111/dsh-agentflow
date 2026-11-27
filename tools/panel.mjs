/**
 * Offline panel snapshot.
 *
 * Reads the recorded runs and writes one self-contained HTML file with the data
 * embedded, so the panel is viewable without a running Harness (and doubles as a
 * screenshot-able artifact). The live version of the same view is served by
 * `GET /agentflow/panel` in `src/routes.js`.
 *
 * Usage: node tools/panel.mjs [artifactRoot] [outFile]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(process.argv[2] ?? join(homedir(), '.dsh', 'agentflow'));
const out = resolve(process.argv[3] ?? join(root, 'panel.html'));
const runsDir = join(root, 'runs');

/** The step that writes prose is not always named `write` (the audit uses `report`). */
function pickMarkdown(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.markdown === 'string' && value.markdown.trim()) return value.markdown;
  if (value.steps && typeof value.steps === 'object') {
    for (const step of Object.values(value.steps)) {
      if (step && typeof step === 'object' && typeof step.markdown === 'string' && step.markdown.trim()) {
        return step.markdown;
      }
    }
  }
  return null;
}

async function collect() {
  if (!existsSync(runsDir)) return [];
  const dirs = (await readdir(runsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const runs = [];
  for (const dir of dirs) {
    try {
      const record = JSON.parse(await readFile(join(runsDir, dir.name, 'run.json'), 'utf8'));
      let anchors = null;
      try {
        const details = JSON.parse(await readFile(join(runsDir, dir.name, 'anchors.json'), 'utf8'));
        anchors = details.map((entry) => ({
          status: entry.status,
          reason: entry.reason ?? null,
          url: entry.url,
          quote: String(entry.quote ?? '').slice(0, 160),
        }));
      } catch {
        anchors = null;
      }
      runs.push({
        runId: record.runId ?? dir.name,
        template: record.template,
        status: record.status,
        durationMs: record.durationMs,
        agentsStarted: record.agentsStarted,
        phases: record.phases ?? [],
        agents: (record.agents ?? []).map((agent) => ({
          seq: agent.seq,
          phase: agent.phase,
          label: agent.label,
          startedAt: agent.startedAt,
          endedAt: agent.endedAt,
          outcome: agent.outcome,
        })),
        anchors: record.anchors ?? null,
        anchorDetails: anchors,
        error: record.error ?? null,
        markdown: pickMarkdown(record.result),
      });
    } catch {
      // A half-written or foreign directory is skipped rather than failing the page.
    }
  }
  runs.sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
  return runs;
}

const runs = await collect();
const generatedAt = new Date().toISOString();
// Escaping "<" keeps a "</script>" inside a model-written report from ending
// the embedded data block.
const dataJson = JSON.stringify(runs).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>AgentFlow 运行面板（离线快照）</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#12141a;color:#e6e6e6}
header{padding:16px 22px;border-bottom:1px solid #262a35;display:flex;gap:12px;align-items:baseline}
h1{font-size:16px;margin:0}
.sub{color:#8b93a7;font-size:12px}
main{display:grid;grid-template-columns:360px 1fr;height:calc(100vh - 60px)}
#list{border-right:1px solid #262a35;overflow:auto;padding:10px}
#detail{overflow:auto;padding:18px 22px}
.row{border:1px solid #262a35;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.row:hover{background:#191d26}
.row.active{border-color:#3b82f6;background:#18202e}
.top{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%}
.name{font-weight:600}
.meta{color:#8b93a7;font-size:12px}
.badge{display:inline-block;border:1px solid #2f3646;border-radius:999px;padding:1px 8px;font-size:11px;margin:0 6px 6px 0}
h2{font-size:15px;margin:14px 0 6px}
pre{background:#171b23;border:1px solid #262a35;border-radius:10px;padding:12px;white-space:pre-wrap;word-break:break-word}
table{border-collapse:collapse;width:100%;font-size:12px}
td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #22262f}
.err{color:#e06c75}.ok{color:#3fb950}.warn{color:#d29922}.empty{color:#8b93a7;padding:20px 6px}
</style></head><body>
<header><h1>AgentFlow 运行面板</h1><span class="sub">离线快照 · 生成于 ${generatedAt} · ${runs.length} 次运行</span></header>
<main><div id="list"></div><div id="detail"><div class="empty">选择左侧一次运行</div></div></main>
<script>
const RUNS = ${dataJson};
const COLORS = { completed:'#3fb950', running:'#58a6ff', timeout:'#d29922', failed:'#e06c75', cancelled:'#8b93a7', error:'#e06c75' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const secs = (ms) => (Number.isFinite(ms) ? (Math.round(ms/100)/10) + 's' : '-');
function renderList() {
  const list = document.getElementById('list');
  if (!RUNS.length) { list.innerHTML = '<div class="empty">没有运行记录</div>'; return; }
  list.innerHTML = RUNS.map((r) => {
    const cov = r.anchors ? r.anchors.coverage : null;
    return '<div class="row" data-id="' + esc(r.runId) + '">'
      + '<div class="top"><span class="dot" style="background:' + (COLORS[r.status]||'#888') + '"></span>'
      + '<span class="name">' + esc(r.template || 'run') + '</span>'
      + '<span class="meta">' + esc(r.status) + '</span></div>'
      + '<div class="meta">' + (r.agentsStarted ?? (r.agents||[]).length) + ' agents · ' + secs(r.durationMs)
      + (typeof cov === 'number' ? ' · 引用 ' + cov : '') + '</div></div>';
  }).join('');
  list.querySelectorAll('.row').forEach((el) => el.addEventListener('click', () => show(el.dataset.id)));
}
function show(id) {
  document.querySelectorAll('.row').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  const run = RUNS.find((r) => r.runId === id);
  const detail = document.getElementById('detail');
  if (!run) { detail.innerHTML = '<div class="empty">找不到该运行</div>'; return; }
  const agents = (run.agents || []).map((a) => '<tr><td>#' + a.seq + '</td><td>' + esc(a.phase) + '</td><td>'
    + esc(a.label) + '</td><td>' + (a.endedAt ? secs(a.endedAt - a.startedAt) : '…') + '</td><td>' + esc(a.outcome||'') + '</td></tr>').join('');
  const anchors = (run.anchorDetails || []).map((a) => '<tr><td class="' + (a.status === 'verified' ? 'ok' : a.status === 'mismatch' ? 'warn' : 'err')
    + '">' + esc(a.status) + '</td><td>' + esc(a.url) + '</td><td>' + esc(a.quote) + '</td><td>' + esc(a.reason || '') + '</td></tr>').join('');
  detail.innerHTML = '<h2>' + esc(run.template || run.runId) + '</h2>'
    + '<div class="meta">' + esc(run.runId) + '</div>'
    + '<div class="meta">' + esc(run.status) + ' · ' + (run.agentsStarted ?? (run.agents||[]).length) + ' agents · ' + secs(run.durationMs) + '</div>'
    + (run.anchors ? '<p>引用核查：<span class="ok">' + run.anchors.verified + ' 成立</span> · <span class="warn">'
        + run.anchors.mismatch + ' 对不上</span> · <span class="err">' + run.anchors.unreachable + ' 抓不到</span></p>' : '<p class="meta">引用未核查</p>')
    + '<div>' + (run.phases || []).map((p) => '<span class="badge">' + esc(p.title) + '</span>').join('') + '</div>'
    + (agents ? '<table><tr><th>#</th><th>阶段</th><th>标签</th><th>耗时</th><th>结果</th></tr>' + agents + '</table>' : '')
    + (run.error ? '<p class="err">' + esc(run.error) + '</p>' : '')
    + (anchors ? '<h2>引用明细</h2><table><tr><th>状态</th><th>来源</th><th>引文</th><th>原因</th></tr>' + anchors + '</table>' : '')
    + (run.markdown ? '<h2>成品</h2><pre>' + esc(run.markdown) + '</pre>' : '');
}
renderList();
if (RUNS.length) show(RUNS[0].runId);
</script></body></html>
`;

await writeFile(out, html, 'utf8');
console.log(`wrote ${out} (${runs.length} runs)`);
