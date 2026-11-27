# 开发笔记：在 DSH 里做插件的实测结论

这些结论都来自本机（DSH 0.2.1-rc.5，desktop profile）的实测，不是文档推断。

## 1. `@deepseek-ai/dsh-tools` 在 profile 插件里**不可解析**

首次冒烟（bundle 只导出 `apply`）报：

```
Error: Cannot find package '@deepseek-ai/dsh-tools' imported from
C:\Users\dong\Desktop\插件\agentflow\index.js
```

官方技能文档说"随 dsh 发布的包从安装处解析"，但至少在这个桌面版 + `link:` 安装方式下不成立。
**替代方案**：手写工具描述对象，只依赖 `ctx.tools.register` 的形状。`defineTool` 只是校验/补默认值，不是必需。

## 2. 工具描述必须带 `output: { schema, render }`

手写对象第一次注册时报：

```
TypeError: tool "wf_echo" must declare output { schema, render, presentationMeta? }
```

即 `schema` 与 `render(args, value)` 都是必需的；缺一不可。

## 3. profile 改动不会热重组（本机实测）

依次尝试过，marker 均未更新：

1. 改 `profile/cordis.patch.yml` 注释
2. 追加一条真实的 `- id: agentflow` 覆盖行（真实配置变化）
3. 改 `profile/package.json` 的 `dsh.profile.bundles` 顺序（真实 manifest 变化）
4. `dsh plugin remove` + `add` 重新安装

结论：**改完必须重启 App**。文档里说的 HMR 重组在这个部署里没有观察到。
（注：第一次安装时 marker 确实被写过一次，说明安装那一刻有过一次重组；之后不再响应。）

## 4. 别用 PowerShell 写这些文件

`Set-Content -Encoding utf8` 会写 BOM，`ConvertTo-Json` 的输出也可能破坏结构；而且终端显示中文路径会变成 `鎻掍欢`（只是显示问题）。
写 profile 文件要么用工具（UTF-8 无 BOM），要么用 node 的 `fs.writeFileSync`。

## 5. 引擎的能力边界（来自 dsh-workflow-ptc 文档）

- `maxConcurrentAgents`（0 = 按 CPU）、`maxTotalAgents`（默认 1000）——**协作式上限，不是安全配额**，也没有 token 预算。
- 运行没有整体超时；取消才会停子进程。
- 脚本里没有 fs / 网络 / 定时器；环境变量为空。
- 子 agent 的用量不进父级上下文，父级 token 不反映子级消耗。

所以：预算必须插件自己算（本实现：启动前估算 + 脚本内批次计数 + 宿主墙钟定时器）。

## 6. 验证路径

- 离线：`test/*.test.js`（30 个断言集），其中 integration 用假引擎跑通工具→runtime→产物的全链路。
- 在线：重启 App 后看 `.agentflow/smoke.json`（apply 每次激活都会重写），再在**新会话**里调 `wf_list` / `wf_run`。

## 7. `workflowEngine` 在 preset 隔离域里，Host 插件拿不到

启用插件时实际报错：

```
1 entry did not activate agentflow: pending (waiting for service: workflowEngine)
```

原因：桌面版把 `workflow-ptc` 与 `tool-workflow` 放在**每个 agent preset 的 isolate 组**里
（`isolate: { workflowEngine: true }`），根级组合里那条是 `disabled: true`。

修法：bundle 的 patch 里把根级那一行打开——

```yaml
- id: workflow-ptc
  name: '@deepseek-ai/dsh-workflow-ptc'
  disabled: false
  config:
    provider: spawn
```

这也符合官方说明：「被 Host 插件消费的服务应当放在 Host 配置里」。

## 8. 本机有 TLS 中间人，抓取引用必须允许回退

第一次真实调研里 9 条引用全部 `unreachable`，`reason: fetch-failed`。单独验证：

```
fetch FAILED TypeError fetch failed  self-signed certificate in certificate chain
```

所以 `src/anchors.js` 改用自己的 node:https 实现，TLS 策略三档 `strict | insecure | auto`：
`auto` 先用严格校验，遇到证书链不受信任才回退不校验，并在该条 anchor 上记 `tls: insecure`。
「全部不可达」和「引用造假」必须区分开，否则这个功能会骗人。

## 9. `maxItems` 不能只用于估算

第一次跑 8-agent 版本时运行期直接中止：

```
BUDGET_EXCEEDED: verify needs 11 agents, budget is 8
```

因为 `maxItems` 只进了 `worstCaseAgents()` 的估算，脚本里并没有真的截断，plan 返回几个子问题就扇出几个。
修法：编译产物里 `items.slice(0, maxItems)` 并 `log()` 记一次截断，估算与运行期才一致。

## 10. 本机唯一可靠的重载方式

改源码、改 manifest、`dsh plugin add/remove` **都不触发重组**；只有「插件页里关掉再打开」或重启 App 会。
所以迭代节奏是：改代码 → 跑离线测试 → 让用户点一次开关。

## 11. Client 模块：`inject` 指向不存在的包 = 静默不执行

第一版面板的 `dsh.client.inject` 抄成了 `@deepseek-ai/dsh-client-runtime`——这个包在 0.2.1 的安装里**根本不存在**。
结果是 Client 条目一直在等一个永远不会出现的依赖，模块从未执行，页面里连报错都没有。

- 校验方法：`asar.cjs` 列出 `@deepseek-ai/dsh-client-*` 的真实包名，`inject` 只能写其中的名字。
- 现在的取值：`@deepseek-ai/dsh-client-ui-sidebar-right`（右侧栏服务由它提供）。
- 诊断手段：Client 里发一个 `GET /agentflow/diag?stage=…` 信标，Host 写 `client-diag.log`，
  不依赖浏览器控制台就能判断「模块没加载 / 加载了但注册失败 / 注册成功」。

## 12. 面板的保底形态

即使在线标签页因宿主差异装不上，`tools/panel.mjs` 也能把运行记录渲染成自包含 HTML 快照
（数据内嵌、`</script>` 已转义）。演示和截图用它，不阻塞其余能力。

## 13. 路由注册必须把 `webServer` 写进 inject

面板能显示标题、却报 `读取失败：HTTP 404`，marker 里是 `routes: false`：`ctx.get('webServer')`
在 apply 时还没挂好，代码走了「没有 server 就跳过」的分支，**静默**没注册路由。

修法：把 `webServer` 写进 `inject`（硬依赖），Loader 会等 HTTP 服务就绪再激活插件。
之后 marker `routes: true`，`/agentflow/runs` 返回 200，面板拿到数据。
代价：没有 HTTP 服务的组合里插件不激活——对一个带 Web 面板的插件可以接受。

## 14. 模板是热加载的，代码不是

`listTemplates()` 每次调用都重新 `readdir(templates/)`，所以**新增/修改 YAML 不用重启**：
在插件已经运行、App 还在跑旧代码的情况下，往 `templates/` 放进 `codebase-audit.yaml`，
直接 `GET /agentflow` 就能看到新模板（本机实测）。这让「加业务场景」的成本降到写一个 YAML。

反过来说，`src/`、`index.js`、`client.js` 的改动仍然要重启/开关插件才生效——两者别混。

## 15. 用 codebase-audit 审计自己：抓到 4 条真问题

插件做出来第一个该审计的对象就是它自己。用宿主 `workflow` 工具跑它的编译产物（7 agents），
盲验后保留 4 条 `strong` 发现，全部落在"硬预算"和"产物不丢"这两条对外承诺上：

| 严重度 | 位置 | 问题 |
|---|---|---|
| high | `src/compile.js:164` | `worstCaseAgents()` 注释写 "ignoring the cap"，代码却 `Math.min(step.maxItems, template.budget.maxAgents)`：超支模板被压成"刚好装得下"，预检放行，跑到某一批才 `BUDGET_EXCEEDED`，前面已启动的 agent 白烧。 |
| medium | `src/runtime.js:200` | 预检又取一次 `Math.min(worst, maxAgents)`，模板自身超 `maxAgents` 时启动闸门永不触发。 |
| medium | `src/runtime.js:288` | `writeRun / trace / result / anchors / record` 共用一个 try，任一二次写失败就跳过索引，run 从 `wf_status` 列表消失。 |
| low | `src/store.js:67` | `record()` 无锁 read-modify-write `index.json`，并发 run 后写覆盖先写。 |

修法与回归测试：

- `worstCaseAgents()` 只用 `step.maxItems`；`estimateAgents()` 与 `compileTemplate().estimatedAgents` 也返回未钳制值——展示给用户的数字必须能被预检信任（`test/compile.test.js` 新增 uncapped 用例）。
- 预检直接用未钳制 worst；新增集成用例：把模板改成 `maxAgents: 3` → 启动前拒绝、`calls.length === 0`。
- 产物写入与 `store.record` 拆成两个 try；`record` 失败记 `record.indexError`，run 仍在列表可查。
- `store.record()` 加 promise 串行链（`indexChain`），`test/store.test.js` 并发 8 个 run 断言全部入索引。
- 顺带清掉两个"死承诺"：`earlyStop` 在归一化阶段直接报错（此前只加进估算、编译产物里没有对应步骤）；`subBatch` 真正作为 `perBatch` 生效（此前校验完从未使用）。

教训：预算类不变量必须"估算 = 预检 = 运行期"三方对齐，任何一处再取 `min` 都会把"启动前可拒绝的错误"推迟成"已经烧掉的 token"。

## 16. 第二轮：修复本身引进了 2 个缺陷

改完上表 4 条，又用同一份 `codebase-audit` 复跑了一次（8 agents，仍是盲验），
上一轮的 4 条全部消失，但审出 3 条新的 `strong`——其中 2 条直接来自上一轮的改动：

| 严重度 | 位置 | 问题 |
|---|---|---|
| high | `src/store.js:33` | `readIndex()` 一个 try/catch 把 ENOENT、JSON 损坏、EBUSY/EPERM 全部吞成 `{runs:[]}`，注释声称的 "rebuild from scratch" 其实不存在；`record()` 在这个假空索引上合并，一次坏读就能静默抹掉最多 49 条历史。 |
| high | `src/compile.js:63` | 上一轮为拒绝未实现的 `earlyStop`，写成 `if (doc.earlyStop !== undefined)`——`earlyStop: false` 也被判成"未实现"，整份模板 invalid、不可运行。 |
| medium | `src/store.js:46` | 串行链 `indexChain` 是 `createStore` 的闭包变量：同一 artifactRoot 上的第二个实例/第二个进程照样并发 read-modify-write，上一轮的锁只覆盖了单实例。 |

修法：

- 索引降级为**派生数据**：只有 ENOENT 回空；解析失败/读失败先把坏文件改名成 `index.json.corrupt-<ISO>.json`，再扫 `runs/*/run.json` 按 `startedAt` 倒序重建（≤50 条）并写回，坏索引可诊断、历史不丢。
- `record()` 的串行链提升为模块级 `indexChains`（按 indexPath 分桶），再加跨进程 `withIndexLock()`：`open(lock,'wx')`、重试 100×20ms、`mtime` 超 10s 视为陈旧锁回收。
- `earlyStop` 用真值判断：只有真的开关打开才拒绝，`false/null/0` 视作没写。
- `writeAtomic` 失败时 `unlink` 临时文件，不留垃圾。

教训：**修 bug 的那次改动同样是要接受审计的新代码**；"拒绝未实现特性"的校验要看值而非看字段存在；进程内串行化不等于跨进程互斥。改完跑 49 个断言，其中 3 个新用例专门盯这三种回归。

## 17. 真正从插件工具跑一次，抓到"假成功"

前面所有运行都是拿宿主 `workflow` 工具跑编译产物；这次终于从插件自己的 `wf_run` 入口发起（子代理里调用，工具是可见的），
结果 4.2 秒就"完成"，`run.json` 却是：

```
status: completed, agentsStarted: 2, agents: [inventory:failed, report:failed]
result: { ok: true, steps: { inventory: null, review: [], verify: [], report: null } }
```

两个问题一次暴露：

1. **引擎里 agent 全部失败，运行仍是 `completed`**。编译脚本只要自己跑完就 `return { ok: true }`，`agent()` 返回 null 被静默过滤，
   于是"8 个 agent 全挂"和"顺利完成"在磁盘上长得一样。修法：脚本记录每个返回 null 的步骤（`plan`、`gather+3` 这种带数量），
   返回 `{ ok: __failed.length === 0, failed }`；runtime 把 `ok === false` 映射成状态 `failed`，并把 `failedSteps` 写进 run.json
   与 `wf_run` 的工具回执，面板/快照按 `failed` 上色。
2. **为什么全挂**：当时以为是 `subagent.maxDepth`（默认 1）挡住了第 2 层派生。**这个判断后来被证伪**：
   同一天晚些时候，同一个深度（子代理里调 `wf_run`）完整跑成功了 6 个 agent / 496 秒。真实原因是切换插件后的
   **重组合窗口**——profile 重新组合时 preset 与服务短暂缺席，同一窗口内新建会话会报
   `Unknown agent preset: standard`，此时派生 agent 也必然失败。等组合稳定后重试即正常。
   所以这条不是插件缺陷，已知限制改为："刚切换/重载插件后稍等几秒再建会话或跑工作流"。

教训：工具的"成功"必须由内容定义，而不是由"没有抛异常"定义。一个编排器如果分不清"跑完了"和"什么都没跑出来"，
它的所有预算/引用/评测数字都不可信。

## 18. 真入口跑成功一次，又抓到 `result.md` 漏写

重组合稳定后，从子代理经 `wf_run` 真跑 `codebase-audit`：**6 个 agent 全部 `completed`**、4 个阶段、496 秒、
`failedSteps: []`，产出 1 high / 2 medium / 1 low 的审计报告（报告正文存进了 `run.json`）。

但产物目录只有 `run.json` 和 `trace.jsonl`，**没有 `result.md`**：runtime 里写死的是
`steps.write.markdown`，而审计模板的成稿步骤叫 `report`。换成 `extractMarkdown(value)`：先看顶层 `markdown`，
再遍历任意 step 找第一个非空 `markdown`；工具回执、右侧栏面板、离线快照三处同步改用同一逻辑。
这也说明"文件没生成"这种 bug，只有真跑一次才会暴露——单测里 fake 引擎一直用 research-report 的 `write` 步骤。

新增 2 条测试锁住 `report`/`write` 两种命名与空值场景。

## 19. 第三轮：成功运行的那份报告，又审出 3 条新问题

`codebase-audit` 这次跑成功了，报告本身很硬：它把"result.md 永远不会写出"列为 **high**（正是我们在 §18 修的那条），
另外两条 medium 都指向上一轮刚加的索引锁：

| 严重度 | 位置 | 问题 |
|---|---|---|
| medium | `src/store.js:71` | 回收陈旧锁用 stat→unlink，中间有 TOCTOU：另一个进程可能刚重建锁，这里却把新锁删掉，两个写者同时进入临界区。 |
| medium | `src/store.js:182` | `list()` 不走 `enqueue`/锁，它触发的 `rebuildIndex()` 会 rename+覆盖 `index.json`，可能压掉并发 `record()` 刚写的条目。 |
| low | `src/runtime.js:123` | 模板目录 `stat` 的任何错误（EACCES/EBUSY）都被吞成"没有模板"，真实故障被藏起来；与 store 只把 ENOENT 当空的约定不一致。 |

修法：锁文件写入 owner token，回收改为 `rename(lock → lock.stale-<token>)` 原子抢占，释放前比对 token；
`list()` 与 `record()` 走同一条队列 + 同一把锁；模板目录只把 ENOENT 当空，其余错误抛
`TEMPLATE_DIR_UNREADABLE`。新增"陈旧锁可回收且释放后不留 `.lock`"用例。

到这里三轮闭环完整：**审 → 修 → 复跑**。每一轮都只剩新问题，没有旧问题复发；而且第 2、3 轮的问题基本都是上一轮修复引入的。

## 20. 第四轮：7 条，3 条 high，还是"修出来的"

第四轮从插件真入口跑（8 agent / 273 秒 / 0 失败），**上一轮的 `result.md` 回归项 PASS**（4897 字节，非空）。
报告保留 7 条 strong：

| 严重度 | 位置 | 问题 | 修法 |
|---|---|---|---|
| high | `src/store.js:164` | rebuild 先 `rename` 掉 index.json 再 `readdir`；readdir 失败就返回空索引，历史静默丢 | 先枚举 runs，成功后才改名；写回失败则把备份改回来 |
| high | `src/store.js:83` | 锁只按 mtime 判陈旧、持锁无心跳，超过 10s 会被当成死锁抢走 | 持锁期间每 2s `utimes` 续命（`LOCK_HEARTBEAT_MS`），陈旧阈值仍 10s |
| high | `src/runtime.js:327` | 四个产物共用一个 try，trace 写失败连坐跳过 result.md / anchors.json | 每个产物独立 try，失败汇总到 `record.artifactError`，其余照写 |
| medium | `src/routes.js:85` | 独立面板页写死 `steps.write.markdown`，审计模板的 `report` 永远渲染不出成品 | 面板内联 JS 也改用 `pickMarkdown()`（顶层或任意步骤） |
| medium | `src/runtime.js:163` | `readFile` 在 try 外，单个模板读失败会让整次 `loadTemplates` reject | 每个文件独立 try，坏文件记成 invalid 条目，其余模板照常可用 |
| medium | `src/routes.js:54` | 面板不检查 `res.ok`，500 显示成"还没有运行记录" | 非 2xx 直接抛错并显示状态码 |
| low | `src/routes.js:167` | 运行中的条目可点击，但 run.json 还没写，详情必 404 | 运行中行不可点击（在线面板与右侧栏同步） |

新增 1 条用例："runs 目录不可读时，坏 index 不被改名、保留待重试"。

四轮下来一个规律：**每轮的高危项几乎都出现在上一轮的修复代码里**。这不是坏消息——它说明审计模板确实在盯"最近改过的东西"，
也说明"修完就跑一次审计"应该成为这个项目的固定动作，而不是一次性演示。

## 21. 第五轮：8 条里留 4 条，锁心跳自己成了高危项

第五轮（8 agent / 617 秒 / `result.md` 4398 字节）对上一轮 7 处修复逐条复核：只有 `pickMarkdown` 被判完全修好，
其余"修了但有残留"。保留的 4 条：

| 严重度 | 位置 | 问题 | 修法 |
|---|---|---|---|
| high | `src/store.js:116` | 心跳用 `utimes(lockPath)` 按**路径**续命：进程停顿超过陈旧阈值、锁被他人 rename 回收后，本进程会替**别人的锁**续命并继续跑临界区，互斥静默失效 | 心跳改为对**持有的句柄** `handle.utimes()`；进入临界区前和每次索引写入前都用 `assertOwner()` 比对 token，输了抛 `LOCK_LOST` 并重试整次获取 |
| medium | `src/store.js:154` | `readdir` 失败仍被吞成 `{runs:[]}`，list 显示 0 条，record 随后用单条覆写索引 | 只有 ENOENT 视作"还没有历史"；其他失败抛 `INDEX_UNREADABLE`，list 会报错、record 拒绝写入，坏索引留在盘上 |
| medium | `src/runtime.js:377` | 索引写失败只写内存 `record.indexError`，无人读取，run 从列表消失 | 失败后补写一次 run.json（带 `indexError`），至少磁盘上留痕 |
| low | `src/routes.js:99` | `openRun` 不检查 `res.ok`，错误体被当成功体 | 非 2xx 直接抛 `HTTP <status>` |

用例改成"runs 是文件（ENOTDIR）时 list/record 都报 `INDEX_UNREADABLE` 且 index 不被改写"。

五轮之后的判断：**这已经不是"再跑一轮就能归零"的阶段了**——目录、文件锁、并发读写这类系统级边界，每修一处都会把风险推到相邻的
时间窗口。项目该停在"已知边界写清楚、核心路径有回归"这里：55 个断言、三次真入口成功运行（6/8/8 agent）、零未处理的生产路径。











