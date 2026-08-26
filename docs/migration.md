# 两仓库迁移记录

本仓库保存应用源码和统一发布资产。迁移过程使用 Git subtree 导入，完整历史已进入当前提交图；源码整理完成后不保留临时导入目录。

## 历史映射

| 来源 | subtree 分支切分提交 | 目标目录 | 迁移内容 |
| --- | --- | --- | --- |
| 原 Workbench 应用目录 | `926cc3d10558a475136f804a39216f06c6a7f3de` | `.migration/workbench-history` | 分析中心、LVM 工具、SSH 终端应用历史 |
| 原插件源码目录 | `ac8ce8252766ccfada68810280f183dac94630f8` | `.migration/plugin-history` | 日志分析插件与规则编辑器历史 |

应用源码已转换为当前 `AppManifestV1` 和独立应用构建格式：

- `apps/analysis-center`：日志分析、结构化存储分析、报告生成和私有 backend 数据库；
- `apps/lvm-uncache-tool`：LVM 文本转换；
- `apps/ssh-terminal`：SSH backend 与 renderer；
- `apps/log-rule-editor`：规则编辑页面和 `rules.*` Host API shim。

不迁移 `target`、数据库、样例输入、缓存、构建输出和未提交用户文件。分析中心成为日志分析能力的唯一实现，旧的独立日志分析插件不作为运行入口保留。

## 协议转换

- 历史插件 manifest 和历史目录协议不参与运行时；
- 应用包统一使用 `AppManifestV1`；
- 应用目录统一使用 `AppCatalogDocumentV1`；
- 所有新应用版本共享固定的 `workbench-apps` GitHub Release，ZIP、唯一命名的元数据资产和 Ed25519 签名由 `release.yml` 生成；历史应用专属 Release 保留不迁移；
- 规则编辑器的普通用户流程只调用 `rules.getRuleState`、`rules.validateUserRules`、`rules.saveUserRules`、`rules.submitSelectedRules` 和 `rules.exportRules`。
