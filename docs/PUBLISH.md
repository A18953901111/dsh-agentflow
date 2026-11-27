# 发布与安装

## 前置

- Node.js ≥ 22.12（用在运行时自带的 Node 也行）
- DeepSeek Harness ≥ `0.2.1-rc.5`（`package.json` 的 `engines.dsh` 会在加载时校验）
- 装完还需要在宿主里**启用**插件并重启/开关一次，见文末

## 打包

```powershell
cd agentflow
pnpm pack            # 产出 agentflow-<version>.tgz
tar -tzf agentflow-0.6.1.tgz   # 核对文件清单
```

包内应当包含：`index.js`、`client.js`、`src/**`、`templates/*.yaml`、`eval/cases.json`、
`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`LICENSE`、`README.md`、`docs/*.md`。
`node_modules` 不应出现在包里（依赖由 pnpm 安装）。

## 安装

```powershell
# 1) 从 tarball 安装（最接近用户场景）
dsh plugin --profile desktop add .\dsh-agentflow-0.7.0.tgz

# 2) 从 npm 安装（发布之后）
dsh plugin --profile desktop add dsh-agentflow@0.7.0

# 3) 本地目录（开发期，link: 安装，改代码后仍需重新加载）
dsh plugin --profile desktop add "C:\Users\dong\agentflow-link"
```

中文路径注意：CLI 经 PowerShell 传参会把中文写成乱码，profile 里会链接到不存在的目录、
整包被跳过。开发机请建一个 ASCII junction 指向源码目录，再用 ASCII 路径安装。

## 启用

桌面版的 profile 由 App 管理，`dsh plugin` 只写入依赖与组合包列表：

1. 打开「设置 → 插件」，找到 **agentflow** 并打开；
2. 刷新页面（Client 模块在页面加载时注入）；
3. 改过源码或配置后，若面板/工具没变化，把开关关掉再打开，或重启 App
   （本机实测：改文件、改 manifest、`dsh plugin add` 都不会触发热重组）。

## 兼容性

- `engines.dsh` 不满足时，组合包会被**跳过**并在启动 stderr 里列入 `skippedBundles`，
  不会让整个 App 起不来。
- 插件需要 Host 作用域的 `workflowEngine`；bundle 的 patch 会顺带打开 base 的 `workflow-ptc` 行。
  若宿主已经把该行放在别的层里打开，保持不冲突即可。

## 卸载

插件页里关掉并删除，或在 profile 目录执行：

```powershell
dsh plugin --profile desktop remove agentflow
```

运行产物不会自动清理：默认在 `~/.dsh/agentflow`（可用 `config.artifactRoot` 改），
确认不要了再手动删。

## 发布到 npm

包名最终定为 **`dsh-agentflow`**（2026-11-26 查 registry：可用）。最初想用 `agentflow`，但 npm 以
"too similar to existing package `agent-flow`" 为由拒绝（403），故改名；插件行 id 仍是 `agentflow`，
`package.json` 的 `name` 必须与 `cordis.patch.yml` 里插入行的 `name` 一致。

```powershell
cd agentflow
pnpm config set "//registry.npmjs.org/:_authToken" <你的token> --location user
pnpm whoami                                  # 应打印你的用户名
pnpm publish --no-git-checks --access public # publishConfig 已声明 public
pnpm view dsh-agentflow version               # 回读确认
```

发布后从 registry 安装验证一次（独立 profile，别污染 desktop）：

```powershell
dsh --profile probe --from-default-profile web --dump-config
dsh plugin --profile probe add dsh-agentflow@0.7.0
dsh --profile probe web --dump-config | Select-String -Context 0,3 "agentflow"
```

预期能看到 `# == agentflow` 行与 `- id: workflow-ptc ... disabled: false`。
CI 里用 `NPM_TOKEN` 环境变量，token 需要 granular + bypass 2FA（或 classic Automation 类型）。

## 发布前检查清单

- [ ] 逐文件跑 `node test/*.test.js` 全绿（本机沙箱下 `node --test` 会 `spawn EPERM`）
- [ ] 版本号已递增（`package.json` 与 `index.js` 的 `VERSION` 一致）
- [ ] `files` 覆盖新增文件；`tar -tzf` 核对
- [ ] README 的实测数字仍可复现
- [ ] 卸载后重装一次，确认没有依赖本机路径
