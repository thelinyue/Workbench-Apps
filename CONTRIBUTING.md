# 贡献指南

Workbench-Apps 只接受应用源码、应用目录、测试、构建脚本和发布说明。宿主 IPC、Electron 窗口、应用安装器和通用 Host API 修改应提交到 Workbench，并同步更新契约测试。

提交前运行：

```powershell
npm run typecheck
npm test
npm run validate:catalog
npm run build
```

不要提交数据库、`dist`、ZIP、签名私钥、构建缓存或样例生产数据。所有用户可见失败信息使用中文；关键 backend 和构建逻辑补充中文设计注释。
