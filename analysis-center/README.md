# 分析中心独立应用

分析中心是工作台的首个官方应用。它的 manifest、renderer、backend Worker、分析规则和报告模板随独立版本 ZIP 发布；运行时数据写入工作台用户目录下的 `apps/analysis-center/data/analysis-center.db`，不读取旧的 `workbench.db`。

在仓库根目录执行 `npm run build:analysis-center` 可生成带 manifest、renderer 和 backend Worker 的种子 ZIP。正式发布时由 `Workbench-Apps` 仓库生成 Catalog、SHA-256 和 Ed25519 签名。
