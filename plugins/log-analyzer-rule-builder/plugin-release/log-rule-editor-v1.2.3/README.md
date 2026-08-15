# 分析规则编辑器

这是 Hephaestus Workbench 的 Web 插件，用于维护 `log-analyzer-plugin` 的用户规则。工作台通过 WebView2 加载 `editor.html`，网页不直接访问本地文件，也不持有上传 Token。

## 功能

- 只读查看维护者主规则及版本；
- 新增、编辑、删除和校验本地用户规则；
- 保存后由工作台合并生成 `Rules/Active/active.json`，立即参与分析；
- 保留冲突规则并显示冲突原因，但冲突规则不会进入激活规则；
- 只提交选中的用户增量，不上传主规则或完整 `active.json`；
- 导出用户规则，便于离线备份和复核。

## 工作台桥接协议

网页通过 `window.chrome.webview.postMessage` 发送 JSON 消息：

```text
getRuleState
saveUserRules { user }
validateUserRules { user }
submitSelectedRules
exportRules
```

工作台返回 `ruleState`、`saveSucceeded`、`validationResult`、`submissionSucceeded`、`exportData` 或 `error`。所有本地文件写入、规则合并、加密主规则解密和提交请求都由工作台完成。

## 本地规则模型

```text
Rules/
├── Official/main.json
├── Local/additions.json
├── Active/active.json
└── History/
```

`Official/main.json` 只读，`Local/additions.json` 只保存用户增量，`Active/active.json` 是校验并合并后的分析输入。

## 开发和打包

需要 Go 1.24 或更高版本用于运行现有测试：

```powershell
go test ./...
go vet ./...
```

Web 插件发布包不再构建 EXE，只包含 `editor.html`、`manifest.json`、`README.md` 和 `LICENSE`：

```powershell
.\scripts\build-release.ps1 -Version 1.2.3
```

## 许可

[MIT](LICENSE)
