# Changelog

## 0.7.0 — 2026-11-26

- 包名从 `agentflow` 改为 **`dsh-agentflow`**（npm 以与 `agent-flow` 过于相似拒收 `agentflow`），插件行 id 仍为 `agentflow`
- 发布到 npm：https://www.npmjs.com/package/dsh-agentflow
- 本地 profile 链接同步改名

## 0.6.5 — 2026-11-26

- 索引锁：心跳改为对持有句柄 `utimes`，并在临界区前后校验 owner token（`LOCK_LOST` 时重试）
- 索引重建：`readdir` 失败不再吞成空历史，改抛 `INDEX_UNREADABLE`
- 运行记录：索引写失败时补写 `run.json` 留下 `indexError`
- 独立面板：`openRun` 检查 `res.ok`

## 0.6.4 — 2026-11-26

- 索引重建改为先枚举 runs 再改名，写回失败回滚
- 锁心跳（2s）防止慢持有者被误判为陈旧
- 四个产物独立 try，trace 失败不再连坐 `result.md`
- `loadTemplates` 单文件读失败隔离；面板 `pickMarkdown` 与运行中条目不可点击

## 0.6.3 — 2026-11-26

- 修复 `result.md` 漏写：`extractMarkdown()` 支持任意步骤名（`report` / `write`）
- 锁回收改为 owner token + `rename` 原子抢占
- `list()` 与 `record()` 共用索引锁

## 0.6.2 — 2026-11-21

- 全失败运行标记为 `failed` 并写 `failedSteps`，不再"脚本跑完即成功"

## 0.6.0 — 2026-11-20

- 预算估算不再封顶，预检使用真实最坏值
- `earlyStop` 显式拒绝；`subBatch` 真正生效
- 产物写入与索引记录解耦

## 0.5.0 — 2026-11-20

- 首次打包发布准备：移除开发诊断、补充 LICENSE/发布文档

## 0.4.0 — 2026-11-18

- 右侧栏「工作流」面板（Client 模块）+ 只读 HTTP 路由 + 独立页面/离线快照

## 0.3.0 — 2026-11-18

- 新增 `wf_eval` 评测工具与报告

## 0.2.0 / 0.1.0 — 2026-11-17

- 模板编译、预算闸门、引用锚点核查、运行产物与 trace
