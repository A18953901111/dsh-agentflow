# 简历材料（实测数据版）

所有数字来自本机真实运行，产物在 `插件/.agentflow/runs/` 与 `插件/.agentflow/eval/`，可复跑。

## 一句话

独立设计并实现 DeepSeek Harness 的声明式多智能体工作流插件：YAML 模板编译为编排脚本、启动前预算闸门与运行期截断、宿主级引用锚点核查、运行产物与 trace 落盘、可复现的评测报告。

## 三条 bullet（可直接用）

1. **设计并实现插件式多 agent 编排引擎**：YAML 模板 → 编排脚本编译（纯函数、可单测），支持扇出批处理、结构化输出 schema 校验、依赖 DAG；55 个离线测试覆盖编译器 / 校验器 / 锚点 / 存储 / 评测 / 路由 / 成品提取 / 端到端装配 / 全模板编译；已打包为 tarball，并在独立 profile 里验证安装与组合生效。
2. **同一机制支撑两类业务**：调研报告与代码库审计共用扇出、盲验、预算闸门；审计把「引用核查」从 URL 换成代码位置（`file:line` + 原样 `evidence`），说明锚点核查是与任务无关的引擎能力，而不是为演示写死的逻辑。用这套审计跑自己的代码五轮：第一轮确认 4 条真实缺陷（1 high：预算估算被 `min` 静默封顶）；修复后每轮都只暴露"上一轮修复里的残留"，第三轮 `result.md` 漏写、第四轮锁心跳/rebuild/产物连坐 3 high、第五轮心跳路径续命 1 high，全部修复并各补回归用例。三轮真入口运行（6 / 8 / 8 agent）均 `completed`、`failedSteps` 为空。
3. **真入口验证抓到"假成功"与"假失败"两面**：早期一次运行 8 个 agent 全挂却记为 `completed`，定位到"脚本跑完即成功"的判定缺陷，改为脚本记录空步骤、runtime 映射为 `failed` 并写 `failedSteps`；另一次失败被误判成宿主委派深度限制，随后用同深度的成功运行证伪，真因是切换插件后的重组合窗口，写进已知限制而不是归咎于框架。
4. **把成本做成硬约束**：启动前按最坏情况拒绝超预算请求（0 个 agent 启动、不留半截产物）；脚本内按批次计数中止；宿主侧墙钟定时器兜底。三种触发路径都实测过：启动前拒绝、运行期 `BUDGET_EXCEEDED`、900s `timeout`。
5. **引用可机械核查，而不是模型自证**：每条结论带 `{url, quote}`，宿主抓原文做规范化子串比对，区分 `verified / mismatch / unreachable`；实测 9 条引用 → 6 核实、3 条「表格拼接式」引用被判定不成立、0 抓取失败，覆盖率 0.667。
6. **双端交付**：Host 工具 + 只读 HTTP 路由 + 右侧栏面板（Client 模块，`sidebar.right.pane.tab`），另有独立页面与自包含离线快照两种兜底形态；Client 加载问题靠临时信标定位（定位完即移除），不依赖浏览器控制台。

## 面试可讲的技术判断（都有踩坑记录）

- **服务作用域**：`workflowEngine` 在 agent preset 的 isolate 域里，Host 插件拿不到 → 在 Host 配置里显式启用引擎（官方文档也要求「被 Host 消费的服务放在 Host 配置」）。
- **估算不等于约束**：`maxItems` 只进估算不截断，导致运行期预算与估算不一致（`verify needs 11 agents, budget is 8`）→ 在编译产物里真正截断并记 log。
- **不可达不等于造假**：本机有 TLS 中间人，抓取全部 `fetch-failed`；改成 `auto` 策略（严格失败才回退、并在 anchor 上标注）后覆盖率才可信。
- **并行不等于更快**：12 agent、3 波批次跑 900s 被墙钟切断；改单波 8 agent 后 188s / 335s 完成。瓶颈是单个慢 agent 与批次串行，不是并发数。

## 可迁移映射（对非 DSH 岗位）

| 本项目 | 业界等价物 |
|---|---|
| bundle / profile 层 | 平台插件与配置分层 |
| `ctx.workflowEngine.start` | 编排运行时（DAG / 子 agent 调度） |
| `agent(prompt, {schema})` | function calling + 结构化输出校验 |
| `workflow/*` 事件 | trace / 可观测性埋点 |
| `wf_eval` + cases | 回归评测集与指标 |
| 预算闸门 | 成本治理 / 限流 |

## 交付物

- 源码：`agentflow/`（Host 插件 + 模板 + 测试）
- **npm：`dsh-agentflow@0.7.0`**（https://www.npmjs.com/package/dsh-agentflow）
- 运行产物：`插件/.agentflow/runs/<id>/{run.json, trace.jsonl, result.md, anchors.json}`
- 评测报告：`插件/.agentflow/eval/<template>-<ts>.md`
- 技术记录：`agentflow/docs/DEVNOTES.md`（21 条实测结论）

## 还没做（面试时如实说）

- 后台任务（jobId）长跑、跨 DSH 版本回归。
- token 计量：引擎不提供子 agent 账本，所以只报 agent 数，不报钱。
- 只在本机 desktop profile 验证过；npm 包已发布，但还没在别人的机器上装过。
