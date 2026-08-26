# 应用统一发布说明

应用发布使用应用 ID 加版本号的 tag：

```text
analysis-center-vX.Y.Z
lvm-uncache-tool-vX.Y.Z
terminal-vX.Y.Z
log-rule-editor-vX.Y.Z
```

标签仍然使用应用 ID 和应用版本，以便工作流只构建发生更新的应用。所有新版本的 ZIP 和元数据资产都发布到固定的 `workbench-apps` Release；元数据资产使用 `<appId>-v<version>.release.json` 命名，避免多个应用共享页面时发生同名冲突。

历史应用专属 Release 和 `catalog.json` 中已有的下载地址保持不变，不做迁移。

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

工作流按 tag 选择一个应用，构建 ZIP 和 `release.json`，要求签名存在，创建或复用 `workbench-apps` Release，使用 `--clobber` 上传 ZIP 和唯一命名的元数据资产，然后更新并校验 `catalog.json`。同一应用版本允许覆盖；覆盖后必须同步更新 SHA-256、大小和签名记录。发布工作流全局串行，避免多个应用同时提交目录产生冲突。
