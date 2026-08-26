# Terminal Release Design

## 目标

将 SSH 终端作为 `terminal` 应用从 `Workbench-Apps` 仓库发布 `terminal-v1.0.0`，由该仓库的标签工作流完成签名、GitHub Release 和 Catalog 更新。

## 边界

- 应用 ID、应用目录、ZIP 文件名和 Release 标签统一使用 `terminal`。
- 保持显示名称 `SSH 终端` 及现有界面实现不变。
- 只使用 `Workbench-Apps` 工作流中的 `github.token` 发布同仓库资源；签名继续使用已配置的 `WORKBENCH_APPS_SIGNING_*` Secrets。
- 删除宿主 `Workbench` 仓库中依赖 `APPS_RELEASES_TOKEN` 的跨仓库发布工作流，避免两条发布链路并存。

## 发布流程

`terminal-v1.0.0` 推送至 `Workbench-Apps` 后，工作流构建带 Ed25519 签名的 ZIP，校验 Release 元数据，写入并验证 `catalog.json`，提交 Catalog 更新，再创建同标签 Release 并上传 ZIP 与 `release.json`。

## 验收

- 本地构建生成 `terminal-v1.0.0.zip` 与包含签名的 `release.json`。
- `catalog.json` 包含 ID 为 `terminal`、名称为 `SSH 终端` 的 `1.0.0` 版本。
- 线上 Release 包含 ZIP 与 `release.json`，且 Catalog 中的 SHA-256、大小和签名与 Release 元数据一致。
