# 分析规则编辑器

这是 Hephaestus Workbench 的独立应用，用于维护分析中心的用户规则。工作台通过 App Host 加载 `renderer/index.html`，网页不直接访问本地文件，也不持有上传 Token。

## 功能

- 只读查看维护者主规则及版本；
- 新增、编辑、删除和校验本地用户规则；
- 保存后由工作台合并生成 `Rules/Active/active.json`，立即参与分析；
- 保留冲突规则并显示冲突原因，但冲突规则不会进入激活规则；
- 只提交选中的用户增量，不上传主规则或完整 `active.json`；
- 导出用户规则，便于离线备份和复核。

维护者专用的隐藏解锁入口已禁用。主规则只通过 `Workbench-Apps` 的源码评审和发布流程维护，应用不会保存或上传维护者 Token。

## 工作台桥接协议

网页通过版本化的 `rules.*` Host API 发送请求：

```text
rules.getRuleState
rules.saveUserRules { user }
rules.validateUserRules { user }
rules.submitSelectedRules
rules.exportRules
```

所有本地文件写入、规则合并和提交请求都由工作台完成。

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

```powershell
npm run build:log-rule-editor
```

应用发布包包含编译后的 `renderer/index.html`、`manifest.json`、`renderer/icon.svg`、`README.md` 和 `LICENSE`。

## 许可

[MIT](LICENSE)
