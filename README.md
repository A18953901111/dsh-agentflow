# AgentFlow

[![npm](https://img.shields.io/npm/v/dsh-agentflow?color=24543F)](https://www.npmjs.com/package/dsh-agentflow)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-6aa583)

DeepSeek Harness 的**声明式多智能体工作流插件**。把一套反复用的多步 AI 流程写成 YAML 模板，插件编译成编排脚本交给 Harness 的工作流引擎执行，跑完留下成品、运行轨迹和引用核查结果。

## 实测（本机，真实调用）

| 项 | 结果 |
|---|---|
| 深度调研（8 agent：拆解 → 3 路取证 → 3 路验证 → 成稿） | `completed`，335s，产出带引用的中文报告 |
| 代码库审计（`wf_run` 真入口，6 agent） | `completed`，496s，4 阶段，0 失败，产出 1 high / 2 medium / 1 low |
| 引用锚点核查 | 9 条：6 verified / 3 mismatch / 0 unreachable，覆盖率 0.667 |
| 一次 12 agent、3 波批次的运行 | 900s 被墙钟切断，状态 `timeout` |
| 最小模板试跑（`smoke`） | 2 agent，3s |
| 离线测试 | 55 个断言通过（schema / 编译器 / 锚点 / 存储 / 评测 / 路由 / 成品提取 / 端到端装配 / 全模板编译） |

那 3 条 mismatch 不是失败，是功能：它们把表格单元格拼成了句子（`CONTEXT LENGTH | 1M`），原文里并不存在这样一句。

```
agentflow/
├── index.js               # Host 入口：inject + apply，只做装配
├── src/
│   ├── compile.js         # 模板 → 编排脚本（纯函数，可单测）
│   ├── schema.js          # JSON Schema 子集校验器
│   ├── runtime.js         # 预算闸门、执行、trace、产物、锚点
│   ├── store.js           # run.json / trace.jsonl / index.json
│   ├── anchors.js         # 抓取引用原文，机械核对引文
│   ├── eval.js            # 评测：跑用例、算分、写报告
│   ├── routes.js          # 只读 HTTP 路由（面板数据源）
│   └── tools.js           # wf_list / wf_run / wf_status / wf_eval
├── client.js              # 右侧栏面板（Client 模块）
├── templates/             # research-report.yaml、codebase-audit.yaml、smoke.yaml
├── eval/cases.json        # 固定用例集
├── test/                  # 55 个离线断言
├── docs/                  # DEVNOTES（实测坑）、RESUME（简历材料）
└── cordis.patch.yml       # bundle 的插件行 + 打开 Host 作用域引擎
```

## 它解决什么

| 问题 | 做法 |
|---|---|
| 每次都要重述「先拆解、再并行查、再验证、最后写」 | 模板固化，一条 `wf_run` 跑完 |
| 扇出几十个子 agent，成本失控 | 启动前按最坏情况算账，超预算**拒绝启动**；脚本按批次再核一次；宿主墙钟兜底 |
| 「交叉验证」其实是同一个模型自说自话 | 验证步只见结论与引文（盲验），且每条结论必须带 `{url, quote}`，宿主抓原文核对 |
| 跑完只剩一段文本，说不清怎么来的 | 每次运行落 `run.json` / `trace.jsonl` / `result.md` / `anchors.json` |
| 改了提示词不知道变好还是变坏 | `wf_eval` 固定用例跑分，出 markdown 报告 |

## 工具

| 工具 | 作用 |
|---|---|
| `wf_list` | 列出模板，含输入 schema 与最坏 agent 数 |
| `wf_run` | 运行模板；`maxAgents` 可临时压预算，不够就直接拒绝 |
| `wf_status` | 最近的运行 / 单次运行详情（含每个 agent 的时间线） |
| `wf_eval` | 跑固定用例集，产出评测报告 |

## 安装与启用

已发布到 npm：**`dsh-agentflow@0.7.0`**（https://www.npmjs.com/package/dsh-agentflow）。
最初想用 `agentflow`，但 npm 以「too similar to existing package `agent-flow`」拒收（403），故改名为 `dsh-agentflow`；
插件行 id 仍是 `agentflow`。

```powershell
# 从 npm 安装（推荐）
dsh plugin --profile desktop add dsh-agentflow@0.7.0

# 本机开发：link 到源码目录
dsh plugin --profile desktop add "C:\Users\dong\agentflow-link"
```

注意路径：工作区目录名是中文，CLI 经 PowerShell 传参会把 `插件` 写成乱码，profile 里就会链接到不存在的目录、整包被跳过。
所以额外建了 ASCII junction `C:\Users\dong\agentflow-link` → `桌面\插件\agentflow`，用 ASCII 路径安装（源码仍在工作区）。

装完还差两步：

1. 在「设置 → 插件」里把 **agentflow 打开**（新发现的 bundle 默认关闭）；
2. 插件需要 **Host 作用域**的 `workflowEngine`，bundle 的 patch 已顺带打开 base 的 `workflow-ptc` 行；
   改完仍需**重启 App 或再开关一次插件**（本机实测：改文件、改 manifest、`dsh plugin add` 都不触发热重组）。

从 tarball 或 npm 安装、兼容性检查与卸载，见 [docs/PUBLISH.md](docs/PUBLISH.md)。


## 预算语义

- `budget.maxAgents`：模板级硬上限。`wf_run` 在**启动任何 agent 之前**比较最坏情况，超了抛 `BUDGET_EXCEEDED`，不留半截产物目录。
- 脚本内按批次 `__take(n)` 计数：每批启动前就知道会起几个 agent，超出即时中止（不是跑完再报）。
- `budget.maxWallClockSec`：宿主侧定时器，到点 `cancel()` 并标记 `timeout`。
- `maxItems` 是**真截断**（`items.slice(0, maxItems)`）并写一条 log，估算与运行期必须一致。

## 引用锚点

`src/anchors.js` 遍历结果里所有 `{url, quote}`，抓取页面、去标签去实体、折叠空白后做子串比对：

- `verified`：原文确实包含该句
- `mismatch`：抓到了页面但找不到该句（编造 / 表格拼接 / 改写）
- `unreachable`：网络失败、非 http(s)、超时

`verified + mismatch + unreachable == total`，报告里不会丢锚点。`run.json` 记录覆盖率，`anchors.json` 记录每条的 `reason`。

本机有 TLS 中间人代理，所以抓取策略是 `auto`：先严格校验证书，遇到不受信任的链才回退不校验，
并在该条 anchor 上记 `tls: insecure`。**「全部 unreachable」不等于引用造假**。

## 面板

三种形态，同一份数据（`GET /agentflow/runs`）：

1. **在线**：右侧栏「工作流」标签页（`client.js`，注册在 `sidebar.right.pane.tab`），列表 + 明细 + 引用核查 + 成品，5 秒刷新。实测已显示真实运行记录。
2. **独立页面**：`GET /agentflow/panel`（浏览器直接打开同一份数据）。
3. **离线快照**：`node tools/panel.mjs <artifactRoot> <out.html>` 把已有运行记录内嵌成一个自包含页面，双击即可看，也方便截图。

## 模板

| 模板 | 步骤 | 用途 |
|---|---|---|
| `research-report` | 拆解 → 3 路取证 → 3 路盲验 → 成稿 | 带可核查引用的调研报告 |
| `codebase-audit` | 盘点 → 3 路审查 → 3 路盲验 → 汇总 | 代码库审计，每条发现落到 `file:line` 并附原文 |
| `smoke` | 2 步 | 装完先跑这个，确认引擎、预算、产物、trace 都通了 |

两个业务模板走同一套机制：扇出并行、结构化输出校验、盲验环节（审的人看不到作者的自信）、
预算闸门。新增模板只要放一个 YAML 进 `templates/`，**不用重启**即可被 `wf_list` 发现。

```powershell
wf_run { template: "codebase-audit", params: { target: "src", maxFiles: 3 } }
```

审计的「锚点」不是 URL 而是代码位置：脚本要求每条 finding 带 `file`、`line`、原样 `evidence`，
核验环节再打开同一位置比对——和调研里的引用核查是同一套思路，只是证据源换成了本地文件。

## 评测

```powershell
wf_eval { template: "research-report", cases: 1 }
```

产出 `artifacts/eval/<template>-<时间>.md`：完成率、结构合法率、平均锚点覆盖率、关键词命中、每例 agent 数与耗时。
每跑完一例就落一次盘，中断也有数。不做模型自评：可机械判定的指标先跑，主观分另做盲评抽样。

## 和其他 DSH 编排插件的区别

npm 上名字带 agentflow 的包有几十个，其中和本插件同类的是下面两个 DSH 插件：

| | **dsh-agentflow（本插件）** | [dsh-plugin-agentflow](https://www.npmjs.com/package/dsh-plugin-agentflow) | [@stifer/dsh-agentflow](https://www.npmjs.com/package/@stifer/dsh-agentflow) |
|---|---|---|---|
| 入口 | YAML 模板 + `wf_*` 工具 + 右侧栏面板 | 画布拖卡片，生成 `/命令` | 外部 agentflow MCP + 技能同步 |
| 执行 | 复用 DSH `workflowEngine`（子 agent、沙箱） | 自研纯 DAG，直调 `ctx.llm` | 依赖外部 MCP 服务 |
| 治理 | **启动前预算闸门、引用锚点核查、评测报告** | 节点级模型/MCP 配置、失败不阻塞 | 概念型编排（4D 画布、Team Hub） |
| 形态 | 引擎 + 模板库 + 评测 | 可视化编辑器 | MCP 装配器 |

一句话：**他们是"可视化编排"，本插件是"可评测的编排引擎"**——流程是文本，能进仓库、能审、能跑回归。
两者并不冲突：画布适合设计流程，本插件适合把流程固化成可复现的流水线。

## 已知限制

- 后台运行（jobId）尚未接入，目前只有前台运行。
- 引擎没有 token 账本，只统计 agent 数，不报 token，也不估算成假数字。
- `wf_eval` 默认只跑 2 例：每例都是一次完整工作流，约 3 分钟。
- **刚切换或重载插件后，先等几秒再新建会话 / 跑工作流**：profile 重新组合的窗口里 preset 与服务短暂缺席，
  这时新建会话会报 `Unknown agent preset: standard`，派生 agent 也必然失败。组合稳定后重试即正常。
- 一个 agent 都没产出结果时，运行会被记成 `failed` 并在 `failedSteps` 里列出空步骤——这是刻意行为，
  避免"脚本跑完 = 成功"的假成功。

## 开发

```bash
npm install
npm test          # node --test "test/*.test.js"，55 个断言
```

单文件运行（定位失败用例时更快）：

```bash
node test/compile.test.js
```

注意：不带参数的 `node --test` 在受限沙箱里可能报 `spawn EPERM`，用上面的显式 glob 即可；普通终端和 CI 不受影响。
