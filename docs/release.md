# 应用独立发布说明

应用发布使用应用 ID 加版本号的 tag：

```text
analysis-center-vX.Y.Z
lvm-uncache-tool-vX.Y.Z
terminal-vX.Y.Z
log-rule-editor-vX.Y.Z
```

## 本地验收

```powershell
npm ci
npm run typecheck
npm test
npm run validate:catalog
npm run build
```

没有 `HEPHAESTUS_APP_SIGNING_PRIVATE_KEY` 和 `HEPHAESTUS_APP_SIGNING_KEY_ID` 时，构建仍可用于类型、测试和 ZIP 确定性检查，但 `release.json` 不带正式签名，不能写入正式目录或通过 Workbench 安装校验。

## CI 发布

GitHub Actions 使用两个 Secret：

- `WORKBENCH_APPS_SIGNING_PRIVATE_KEY`：Ed25519 私钥；
- `WORKBENCH_APPS_SIGNING_KEY_ID`：与 Workbench 受信任公钥配置一致的 key ID。

工作流按 tag 选择一个应用，构建 ZIP 和 `release.json`，要求签名存在，更新并校验 `catalog.json`，然后使用当前仓库 `contents: write` 权限创建 Release。Release 资产不可覆盖，修复必须递增应用版本。
