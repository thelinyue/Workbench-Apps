# Terminal Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `Workbench-Apps` 以 `terminal-v1.0.0` 自动签名发布 SSH 终端，并将其写入线上 Catalog。

**Architecture:** 应用源码和发布工作流均归属 `Workbench-Apps`。标签触发工作流使用 `github.token` 创建同仓库 Release，签名使用仓库现有 Secret；宿主仓库不再负责跨仓库发布。

**Tech Stack:** Node.js 22、Vite、TypeScript、Vitest、GitHub Actions、GitHub CLI、Ed25519。

---

### Task 1: 统一 `terminal` 的源码和构建标识

**Files:**
- Move: `D:/code/Workbench-Apps/apps/ssh-terminal` to `D:/code/Workbench-Apps/apps/terminal`
- Move: `D:/code/Workbench-Apps/tools/build-ssh-terminal.mjs` to `D:/code/Workbench-Apps/tools/build-terminal.mjs`
- Move: `D:/code/Workbench-Apps/tests-ssh-terminal-app.test.ts` to `D:/code/Workbench-Apps/tests-terminal-app.test.ts`
- Modify: `D:/code/Workbench-Apps/package.json`

- [ ] **Step 1: 写出失败测试**

将现有测试迁移为 `tests-terminal-app.test.ts`，增加断言，要求 manifest 的 ID 为 `terminal`，构建脚本的 ZIP 和 Release URL 均使用 `terminal-v1.0.0`。

```ts
expect(manifest.id).toBe('terminal');
expect(buildSource).toContain('terminal-v${manifest.version}.zip');
expect(buildSource).toContain('/terminal-v${manifest.version}/terminal-v${manifest.version}.zip');
```

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run -c vitest.config.ts tests-terminal-app.test.ts`

Expected: 失败，因为现有应用 ID 和 ZIP 名称仍是 `ssh-terminal`。

- [ ] **Step 3: 最小实现**

使用 `git mv` 将应用目录和构建脚本改名为 `terminal`，将 manifest 的 `id` 改为 `terminal`，并将根 `package.json` 的构建、类型检查、测试命令改为 `terminal`。构建脚本中 ZIP 名称和 Release URL 改为 `terminal-v${manifest.version}`；保留显示名 `SSH 终端`、能力和应用功能。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run -c vitest.config.ts tests-terminal-app.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add apps/terminal tools/build-terminal.mjs tests-terminal-app.test.ts package.json
git commit -m "feat: publish terminal app"
```

### Task 2: 将 Apps 发布工作流接入 `terminal` 标签

**Files:**
- Modify: `D:/code/Workbench-Apps/.github/workflows/release.yml`
- Modify: `D:/code/Workbench-Apps/tests-terminal-app.test.ts`

- [ ] **Step 1: 写出失败测试**

增加 workflow 文本断言，要求监听 `terminal-v*` 并在构建分支执行 `npm run build:terminal`，同时不再声明 `ssh-terminal-v*`。

```ts
expect(workflow).toContain("- 'terminal-v*'");
expect(workflow).toContain('terminal) npm run build:terminal ;;');
expect(workflow).not.toContain("- 'ssh-terminal-v*'");
```

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run -c vitest.config.ts tests-terminal-app.test.ts`

Expected: 失败，因为当前 workflow 只接受 `ssh-terminal-v*`。

- [ ] **Step 3: 最小实现**

在工作流标签列表中将 `ssh-terminal-v*` 改为 `terminal-v*`；在 `case` 中以 `terminal` 匹配并调用 `npm run build:terminal`。保持 `permissions: contents: write`、`GH_TOKEN: ${{ github.token }}` 与签名 Secret 不变。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run -c vitest.config.ts tests-terminal-app.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add .github/workflows/release.yml tests-terminal-app.test.ts
git commit -m "ci: release terminal from apps repository"
```

### Task 3: 验证签名构建和应用目录更新

**Files:**
- Modify: `D:/code/Workbench-Apps/catalog.json` (仅由发布工作流写入)

- [ ] **Step 1: 构建并校验 Release 元数据**

Run: `npm run typecheck && npm test && npm run build:terminal`

Expected: 类型检查和测试通过；构建产物包含 `apps/terminal/dist/terminal-v1.0.0.zip` 与已签名的 `release.json`。

- [ ] **Step 2: 推送主分支与发布标签**

```powershell
git push origin main
git tag terminal-v1.0.0
git push origin terminal-v1.0.0
```

Expected: GitHub Actions 成功完成构建、签名、Catalog 提交和 Release 创建。

- [ ] **Step 3: 校验线上产物**

Run:

```powershell
gh release view terminal-v1.0.0 --repo thelinyue/Workbench-Apps
Invoke-RestMethod https://raw.githubusercontent.com/thelinyue/Workbench-Apps/main/catalog.json | ConvertTo-Json -Depth 10
```

Expected: Release 含 `terminal-v1.0.0.zip` 和 `release.json`；Catalog 含 `terminal`、`SSH 终端`、版本 `1.0.0`，并与 Release 元数据一致。

### Task 4: 删除宿主仓库的错误发布入口

**Files:**
- Delete: `D:/code/Hephaestus Workbench/.github/workflows/terminal-release.yml`

- [ ] **Step 1: 删除跨仓库工作流**

移除依赖 `APPS_RELEASES_TOKEN` 的 workflow，避免从宿主仓库再次发布或写入 Catalog。

- [ ] **Step 2: 验证工作区边界**

Run: `git status --short`

Expected: 仅该 workflow 删除被暂存；不暂存现有的 UI 和测试未提交改动。

- [ ] **Step 3: 提交并推送**

```powershell
git add .github/workflows/terminal-release.yml
git commit -m "ci: remove terminal cross-repository release"
git push origin master
```

Expected: 宿主不再包含终端跨仓库发布路径。
