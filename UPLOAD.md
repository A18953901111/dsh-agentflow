# 上传到 GitHub（网页版，无需安装 Git）

目标目录：`C:\Users\dong\Desktop\插件\github-upload`（已经整理好，只含要进仓库的文件）。

## 1. 新建仓库

1. 打开 https://github.com/new
2. **Repository name**：`dsh-agentflow`
3. 选 **Public**
4. **不要**勾选 "Add a README file" / ".gitignore" / "license"（会和本地文件冲突）
5. Create repository

## 2. 上传文件

1. 新建出来的空仓库页面，点 **uploading an existing file**
2. 打开 `C:\Users\dong\Desktop\插件\github-upload`
3. **Ctrl+A 全选**（包括 `.github`、`.gitignore`、`docs`、`src`、`test` 等所有内容），拖进浏览器上传区域
   - 如果拖拽不支持文件夹：先上传根目录文件，再对 `src/`、`test/`、`templates/`、`docs/`、`eval/`、`tools/`、`locale/`、`.github/` 逐个拖
4. 确认上传列表里能看到 `.github/workflows/ci.yml`（隐藏点开头的文件在 Windows 资源管理器里默认可见；若看不到，勾选"显示隐藏的项目"）
5. 底部 Commit message 填：`feat: initial release v0.7.0` → **Commit changes**

## 3. 上传后检查

- 仓库首页能看到 README 渲染（含 npm 徽章和三方对比表）
- **Actions** 标签页会自动跑一次 `ci`（Node 22/24 矩阵）；绿了说明 55 个测试在干净环境通过
- **About** 右侧点齿轮，填：
  - Description：`Declarative multi-agent workflow engine for DeepSeek Harness — YAML templates, hard budgets, citation anchors, evals.`
  - Topics：`dsh dsh-plugin deepseek-harness workflow multi-agent orchestration eval`

## 4. 之后建议（可选）

- 仓库 Settings → 无需改动；若想发布 Release：Releases → Draft a new release → tag `v0.7.0`，附上 `dsh-agentflow-0.7.0.tgz`
- 把仓库地址告诉我，我改 `package.json` 的 `repository` 字段，发 `0.7.1` 时补上（npm 页面会显示仓库链接）
- CI 绿了之后，可以按 `docs/PUBLISH.md` 的流程提交到 DSH 插件目录（awesome-dsh-plugin PR），这样才会出现在插件市场的 Discover 里
