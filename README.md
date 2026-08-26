# Hephaestus Workbench Apps

官方工作台应用源码、目录与统一应用发布索引。

`catalog.json` 是工作台读取的 `AppCatalogDocumentV1`。所有新应用版本共享固定的 `workbench-apps` GitHub Release，ZIP 包通过 Ed25519 签名，工作台安装端同时校验 SHA-256、大小、签名、manifest 和宿主兼容版本。

## 发布约定

- 分析中心版本标签：`analysis-center-vX.Y.Z`
- LVM Uncache Tool 版本标签：`lvm-uncache-tool-vX.Y.Z`
- SSH 终端版本标签：`terminal-vX.Y.Z`
- 分析规则编辑器版本标签：`log-rule-editor-vX.Y.Z`
- 统一发布页：`https://github.com/thelinyue/Workbench-Apps/releases/tag/workbench-apps`
- 目录更新必须经过工作台的严格 Catalog 校验
- 同一应用版本允许重新发布，覆盖资产后必须同步更新 Catalog 中的校验信息

仓库职责与迁移边界见 [贡献指南](CONTRIBUTING.md)、[发布说明](docs/release.md) 和 [迁移记录](docs/migration.md)。Workbench 只消费这里发布的 `AppManifestV1` 应用包，不依赖旧插件协议。
