# Hephaestus Workbench Apps

官方工作台应用目录与独立应用发布索引。

`catalog.json` 是工作台读取的 `AppCatalogDocumentV1`。每个应用版本对应一个 GitHub Release，ZIP 包通过 Ed25519 签名，工作台安装端同时校验 SHA-256、大小、签名、manifest 和宿主兼容版本。

## 发布约定

- 分析中心版本标签：`analysis-center-vX.Y.Z`
- LVM Uncache Tool 版本标签：`lvm-uncache-tool-vX.Y.Z`
- 目录更新必须经过工作台的严格 Catalog 校验
- 已发布版本不可覆盖，修复必须递增版本号
