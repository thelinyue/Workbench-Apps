# Hephaestus Workbench Plugin Sources

本仓库集中维护 Hephaestus Workbench 的插件源码。每个插件仍然独立构建、独立版本和独立发布，但共享同一个源码仓库。

## 插件

- `plugins/log-analyzer-plugin`：日志分析插件。
- `plugins/log-analyzer-rule-builder`：日志分析规则编辑器插件。

## 版本和发布

插件版本独立管理。为避免不同插件的标签冲突，统一使用以下标签格式：

```text
log-analyzer-plugin/v1.0.0
log-analyzer-rule-builder/v1.0.0
```

GitHub Release 的 ZIP 包仍按插件分别发布。公共插件目录位于
[`Hephaestus-Workbench-Plugins`](https://github.com/thelinyue/Hephaestus-Workbench-Plugins)。

## 迁移说明

本仓库合并了原 `log-analyzer-plugin` 和 `log-analyzer-rule-builder` 仓库的源码及 Git 提交历史。原仓库已停止作为开发入口。
