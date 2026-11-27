/**
 * Read-only HTTP routes for the sidebar panel.
 *
 * The panel is a Client module; it can only see run data if the Host exposes it.
 * Everything here is GET/HEAD, same-origin, and answers JSON: no mutation, no
 * path traversal (run ids are validated), no template authoring.
 */
const BASE = '/agentflow';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

const PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentFlow 运行面板</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #12141a; color: #e6e6e6; }
header { padding: 18px 22px; border-bottom: 1px solid #262a35; display: flex; gap: 12px; align-items: baseline; }
h1 { font-size: 16px; margin: 0; }
.sub { color: #8b93a7; font-size: 12px; }
main { display: grid; grid-template-columns: 360px 1fr; height: calc(100vh - 62px); }
#list { border-right: 1px solid #262a35; overflow: auto; padding: 10px; }
#detail { overflow: auto; padding: 18px 22px; }
.row { border: 1px solid #262a35; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
.row:hover { background: #191d26; }
.row.active { border-color: #3b82f6; background: #18202e; }
.top { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.name { font-weight: 600; }
.meta { color: #8b93a7; font-size: 12px; }
.badge { display: inline-block; border: 1px solid #2f3646; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin: 0 6px 6px 0; }
h2 { font-size: 15px; margin: 0 0 6px; }
pre { background: #171b23; border: 1px solid #262a35; border-radius: 10px; padding: 12px; white-space: pre-wrap; word-break: break-word; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #22262f; }
.err { color: #e06c75; }
.empty { color: #8b93a7; padding: 30px 6px; }
button { background: #1d2330; color: #e6e6e6; border: 1px solid #2f3646; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
</style></head>
<body>
<header><h1>AgentFlow 运行面板</h1><span class="sub" id="sub">读取中…</span>
<button id="refresh">刷新</button></header>
<main><div id="list"><div class="empty">载入中…</div></div><div id="detail"><div class="empty">选择左侧一次运行</div></div></main>
<script>
const COLORS = { completed: '#3fb950', running: '#58a6ff', timeout: '#d29922', failed: '#e06c75', cancelled: '#8b93a7', error: '#e06c75' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const secs = (ms) => (Number.isFinite(ms) ? (Math.round(ms / 100) / 10) + 's' : '-');
// The prose step is not always named "write" (the audit uses "report").
function pickMarkdown(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.markdown === 'string' && value.markdown.trim()) return value.markdown;
  const steps = value.steps;
  if (steps && typeof steps === 'object') {
    for (const step of Object.values(steps)) {
      if (step && typeof step === 'object' && typeof step.markdown === 'string' && step.markdown.trim()) return step.markdown;
    }
  }
  return null;
}

async function loadList() {
  const sub = document.getElementById('sub');
  try {
    const res = await fetch('/agentflow/runs', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const rows = [...(body.running || []).map((r) => ({ ...r, status: 'running' })), ...(body.runs || [])];
    sub.textContent = rows.length + ' 次运行';
    const list = document.getElementById('list');
    if (!rows.length) { list.innerHTML = '<div class="empty">还没有运行记录</div>'; return; }
    list.innerHTML = rows.map((r) => {
      const cov = r.anchors ? r.anchors.coverage : r.anchorCoverage;
      // A running entry has no run.json yet, so opening it would 404.
      const clickable = r.status !== 'running' && !!r.runId;
      return '<div class="row" data-id="' + esc(clickable ? r.runId : '') + '"' + (clickable ? '' : ' style="cursor:default"') + '>'
        + '<div class="top"><span class="dot" style="background:' + (COLORS[r.status] || '#888') + '"></span>'
        + '<span class="name">' + esc(r.template || 'run') + '</span>'
        + '<span class="meta">' + esc(r.status) + '</span></div>'
        + '<div class="meta">' + (r.agentsStarted ?? r.agents ?? '?') + ' agents · ' + secs(r.durationMs)
        + (typeof cov === 'number' ? ' · 引用 ' + cov : '') + '</div></div>';
    }).join('');
    list.querySelectorAll('.row').forEach((el) => {
      if (!el.dataset.id) return;
      el.addEventListener('click', () => openRun(el.dataset.id));
    });
  } catch (e) {
    sub.innerHTML = '<span class="err">读取失败：' + esc(e.message) + '</span>';
  }
}

async function openRun(id) {
  if (!id) return;
  document.querySelectorAll('.row').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  const detail = document.getElementById('detail');
  detail.innerHTML = '<div class="empty">载入中…</div>';
  try {
    const res = await fetch('/agentflow/runs/' + encodeURIComponent(id), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const run = body.run;
    if (!run) throw new Error(body.error || 'not found');
    const md = pickMarkdown(run.result);
    const agents = (run.agents || []).map((a) => '<tr><td>#' + a.seq + '</td><td>' + esc(a.phase) + '</td><td>'
      + esc(a.label) + '</td><td>' + (a.endedAt ? secs(a.endedAt - a.startedAt) : '…') + '</td><td>' + esc(a.outcome || '') + '</td></tr>').join('');
    const anchors = run.anchors ? ('引用核查：' + run.anchors.verified + '/' + run.anchors.total + ' 成立 · '
      + run.anchors.mismatch + ' 条对不上 · ' + run.anchors.unreachable + ' 条抓不到') : '引用未核查';
    detail.innerHTML = '<h2>' + esc(run.template || run.runId) + '</h2>'
      + '<div class="meta">' + esc(run.status) + ' · ' + (run.agentsStarted ?? (run.agents || []).length) + ' agents · ' + secs(run.durationMs) + '</div>'
      + '<p>' + esc(anchors) + '</p>'
      + '<div>' + (run.phases || []).map((p) => '<span class="badge">' + esc(p.title) + '</span>').join('') + '</div>'
      + (agents ? '<table><tr><th>#</th><th>阶段</th><th>标签</th><th>耗时</th><th>结果</th></tr>' + agents + '</table>' : '')
      + (run.error ? '<p class="err">' + esc(run.error) + '</p>' : '')
      + (md ? '<h2 style="margin-top:18px">成品</h2><pre>' + esc(md.length > 8000 ? md.slice(0, 8000) + '…' : md) + '</pre>' : '');
  } catch (e) {
    detail.innerHTML = '<div class="empty err">' + esc(e.message) + '</div>';
  }
}

document.getElementById('refresh').addEventListener('click', loadList);
loadList();
setInterval(loadList, 5000);
</script>
</body></html>`;


function sendJson(res, status, body) {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/**
 * Register the routes on the harness web server.
 * @returns a disposer function (or a no-op when the server lacks `register`).
 */
export function registerAgentflowRoutes(webServer, flow, { base = BASE } = {}) {
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const handler = async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    } catch {
      sendJson(res, 400, { error: 'bad-url' });
      return;
    }

    const rest = pathname.slice(base.length).replace(/^\/+|\/+$/g, '');
    const parts = rest.split('/').filter(Boolean);

    try {
      if (parts.length === 0) {
        const templates = await flow.listTemplates();
        sendJson(res, 200, {
          ok: true,
          templates: templates.map((entry) =>
            entry.valid
              ? { id: entry.id, name: entry.name, description: entry.description, estimatedAgents: entry.estimatedAgents }
              : { id: entry.id, error: entry.error },
          ),
        });
        return;
      }

      if (parts[0] === 'panel' && parts.length === 1) {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(method === 'HEAD' ? '' : PANEL_HTML);
        return;
      }

      if (parts[0] === 'runs' && parts.length === 1) {
        const runs = await flow.recent(20);
        sendJson(res, 200, { ok: true, running: flow.activeRuns(), runs });
        return;
      }

      if (parts[0] === 'runs' && parts.length === 2 && RUN_ID.test(parts[1])) {
        const detail = await flow.runDetail(parts[1]);
        if (!detail) {
          sendJson(res, 404, { error: 'run-not-found' });
          return;
        }
        sendJson(res, 200, { ok: true, run: detail });
        return;
      }

      sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      sendJson(res, 500, { error: 'internal', message: String(error?.message ?? error) });
    }
  };

  return webServer.register({ kind: 'prefix', path: base, handler });
}
