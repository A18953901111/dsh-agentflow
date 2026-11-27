/**
 * AgentFlow sidebar panel (Client module).
 *
 * Rendering surface: the official right sidebar tab, registered in two steps —
 * a tab type through `sidebarRightTabs.register`, then the tab body through the
 * `sidebar.right.pane.tab` slot. Both services are optional, so they are polled
 * through `ctx.get` instead of declared in `inject` (a hard inject would park the
 * plugin on hosts without a right sidebar).
 *
 * Data comes from the Host's read-only routes: GET /agentflow/runs[/<id>].
 * Styling uses theme tokens with fallbacks only; no harness client package is
 * imported, and every resource is registered inside apply with its disposer.
 */
window.__ModuleLoader__.load({
  id: 'agentflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const TAB_ID = 'agentflow';
    const TAB_KIND = 'agentflow';
    const POLL_MS = 5000;
    const RETRY_MS = 250;
    const RETRY_LIMIT = 40;
    const log = (...args) => {
      try {
        console.info('[agentflow]', ...args);
      } catch {
        // console may be unavailable in some hosts
      }
    };
    log('client module loaded');
    const CSS = `
.af-root { display: flex; flex-direction: column; gap: 8px; height: 100%; padding: 10px;
  color: var(--dsw-alias-text-primary, #e6e6e6); font-size: 12px; box-sizing: border-box; }
.af-head { display: flex; align-items: center; gap: 8px; }
.af-title { font-weight: 600; font-size: 13px; flex: 1; }
.af-btn { border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.16));
  background: transparent; color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
.af-btn:hover { background: var(--dsw-alias-fill-subtle, rgba(255,255,255,.06)); }
.af-list { overflow: auto; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.af-row { border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.12)); border-radius: 8px;
  padding: 7px 9px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
.af-row:hover { background: var(--dsw-alias-fill-subtle, rgba(255,255,255,.05)); }
.af-row-top { display: flex; align-items: center; gap: 6px; }
.af-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.af-name { font-weight: 600; }
.af-meta { color: var(--dsw-alias-text-secondary, #9aa0a6); font-size: 11px; }
.af-empty { color: var(--dsw-alias-text-secondary, #9aa0a6); padding: 12px 4px; }
.af-error { color: var(--dsw-alias-text-danger, #e06c75); }
.af-chip { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.16)); margin-right: 4px; }
.af-pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; line-height: 1.55;
  background: var(--dsw-alias-fill-subtle, rgba(255,255,255,.04)); border-radius: 8px; padding: 8px;
  max-height: 46vh; overflow: auto; }
.af-agents { display: flex; flex-direction: column; gap: 2px; }
.af-agent { display: flex; gap: 6px; font-size: 11px; color: var(--dsw-alias-text-secondary, #9aa0a6); }
`;

    function statusColor(status) {
      if (status === 'completed') return 'var(--dsw-alias-text-success, #3fb950)';
      if (status === 'running') return 'var(--dsw-alias-text-info, #58a6ff)';
      if (status === 'timeout') return 'var(--dsw-alias-text-warning, #d29922)';
      return 'var(--dsw-alias-text-danger, #e06c75)';
    }

    function seconds(ms) {
      if (!Number.isFinite(ms)) return '-';
      return `${Math.round(ms / 100) / 10}s`;
    }

    function coverage(run) {
      const value = run.anchors?.coverage ?? run.anchorCoverage;
      return typeof value === 'number' ? value : null;
    }

    function detailMarkdown(run) {
      const value = run && run.result;
      if (!value || typeof value !== 'object') return '';
      if (typeof value.markdown === 'string' && value.markdown.trim()) return value.markdown;
      const steps = value.steps;
      if (steps && typeof steps === 'object') {
        for (const step of Object.values(steps)) {
          if (step && typeof step === 'object' && typeof step.markdown === 'string' && step.markdown.trim()) {
            return step.markdown;
          }
        }
      }
      return '';
    }

    function Detail({ run, onBack }) {
      const phases = Array.isArray(run.phases) ? run.phases : [];
      const agents = Array.isArray(run.agents) ? run.agents : [];
      const markdown = detailMarkdown(run);
      return h('div', { className: 'af-root' },
        h('div', { className: 'af-head' },
          h('button', { className: 'af-btn', onClick: onBack }, '←'),
          h('div', { className: 'af-title' }, run.template || run.runId),
        ),
        h('div', { className: 'af-meta' }, `${run.status} · ${run.agentsStarted ?? agents.length} agents · ${seconds(run.durationMs)}`),
        run.anchors
          ? h('div', { className: 'af-meta' },
              `引用核查 ${run.anchors.verified}/${run.anchors.total} 成立`,
              run.anchors.mismatch ? ` · ${run.anchors.mismatch} 条对不上` : '',
              run.anchors.unreachable ? ` · ${run.anchors.unreachable} 条抓不到` : '')
          : null,
        phases.length
          ? h('div', null, phases.map((phase, index) =>
              h('span', { className: 'af-chip', key: `${phase.title}-${index}` }, phase.title)))
          : null,
        h('div', { className: 'af-agents' },
          agents.slice(0, 24).map((agent, index) =>
            h('div', { className: 'af-agent', key: `${agent.seq}-${index}` },
              h('span', null, `#${agent.seq}`),
              h('span', null, agent.phase || '-'),
              h('span', null, agent.label || ''),
              h('span', null, agent.endedAt ? seconds(agent.endedAt - agent.startedAt) : '…'),
            ))),
        markdown
          ? h('pre', { className: 'af-pre' }, markdown.length > 6000 ? `${markdown.slice(0, 6000)}\n…` : markdown)
          : h('div', { className: 'af-empty' }, '这次运行没有 markdown 成品（见 run.json）'),
      );
    }

    function Panel() {
      const [state, setState] = React.useState({ loading: true, runs: [], running: [], error: null });
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/agentflow/runs', { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          setState({ loading: false, runs: body.runs || [], running: body.running || [], error: null });
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: String(error.message || error) }));
        }
      }, []);

      React.useEffect(() => {
        load();
        const timer = setInterval(load, POLL_MS);
        return () => clearInterval(timer);
      }, [load]);

      const openRun = async (runId) => {
        setSelected(runId);
        setDetail(null);
        try {
          const response = await fetch(`/agentflow/runs/${runId}`, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          setDetail(body.run);
        } catch (error) {
          setDetail({ runId, template: runId, error: String(error.message || error), agents: [], phases: [] });
        }
      };

      if (selected) {
        return h('div', null,
          h('style', null, CSS),
          detail ? h(Detail, { run: detail, onBack: () => { setSelected(null); setDetail(null); } })
                 : h('div', { className: 'af-root' }, h('div', { className: 'af-empty' }, '载入中…')),
        );
      }

      const rows = [...(state.running || []).map((run) => ({ ...run, status: 'running' })), ...(state.runs || [])];
      return h('div', null,
        h('style', null, CSS),
        h('div', { className: 'af-root' },
          h('div', { className: 'af-head' },
            h('div', { className: 'af-title' }, 'AgentFlow'),
            h('button', { className: 'af-btn', onClick: load }, '刷新'),
          ),
          state.error ? h('div', { className: 'af-error' }, `读取失败：${state.error}`) : null,
          h('div', { className: 'af-list' },
            rows.length === 0
              ? h('div', { className: 'af-empty' }, state.loading ? '载入中…' : '还没有运行记录。让模型调用 wf_run 试试。')
              : rows.map((run, index) => {
                  const cov = coverage(run);
                  // Running entries have no run.json yet; opening one would 404.
                  const open = run.status === 'running' || !run.runId ? undefined : () => openRun(run.runId);
                  return h('div', { className: 'af-row', key: run.runId || index, onClick: open },
                    h('div', { className: 'af-row-top' },
                      h('span', { className: 'af-dot', style: { background: statusColor(run.status) } }),
                      h('span', { className: 'af-name' }, run.template || 'run'),
                      h('span', { className: 'af-meta' }, run.status),
                    ),
                    h('div', { className: 'af-meta' },
                      `${run.agentsStarted ?? run.agents ?? '?'} agents · ${seconds(run.durationMs)}`,
                      cov === null ? ' · 未核查引用' : ` · 引用 ${cov}`,
                    ),
                  );
                }),
          ),
        ),
      );
    }

    function renderIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': true },
        h('path', { d: 'M4 6h16M4 12h16M4 18h10' }),
        h('circle', { cx: '19', cy: '18', r: '2.5', fill: 'currentColor', stroke: 'none' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let disposed = false;
        let attempts = 0;
        let timer = null;
        let disposeTabs = null;
        let disposeBody = null;

        const cleanup = () => {
          disposed = true;
          if (timer) clearTimeout(timer);
          try { if (disposeBody) disposeBody(); } catch { /* ignore */ }
          try { if (disposeTabs) disposeTabs(); } catch { /* ignore */ }
          disposeBody = null;
          disposeTabs = null;
        };

        const attempt = () => {
          if (disposed) return;
          const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : null;
          if (!tabs || typeof tabs.register !== 'function') {
            attempts += 1;
            if (attempts === 1) log('sidebarRightTabs not ready, retrying…', typeof ctx.get);
            if (attempts <= RETRY_LIMIT) timer = setTimeout(attempt, RETRY_MS);
            else log('giving up: sidebarRightTabs never appeared (attempts=' + attempts + ')');
            return;
          }
          try {
            disposeTabs = tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              title: () => '工作流',
              guide: [{
                id: 'runs',
                order: 100,
                title: () => 'AgentFlow',
                description: () => '多智能体工作流的运行记录与产物',
                icon: renderIcon,
              }],
            });
            disposeBody = ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              () => h(Panel, null),
            );
            log('sidebar tab registered');
          } catch (error) {
            log('tab registration failed:', String(error && error.message ? error.message : error));
            cleanup();
          }
        };

        attempt();
        return cleanup;
      },
    };
  },
});
