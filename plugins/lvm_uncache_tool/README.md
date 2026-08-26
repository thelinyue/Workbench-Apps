# LVM 缓存清理工具

这是 Hephaestus Workbench 的静态网页工具插件，用于读取 LVM2 VG 文本备份，识别并清理 cache 配置，生成可供工程师继续处理的新 VG 文件。

## 使用方式

在 Workbench 插件中心安装后，点击“启动工具”：

1. 选择 `.vg` 文件，或直接粘贴 VG 文本。
2. 点击“解析并预览”。
3. 检查缓存 PV、缓存 LV、origin、删除键和 segment 转换结果。
4. 点击“另存为清理结果”。

默认文件名为 `<原文件名>_nocache.vg`。工具不会覆盖原始文件，也不会执行 `vgcfgrestore`、`lvremove`、`vgreduce` 等系统命令。

## 安全边界

- 所有处理在本地网页中完成，不启动服务器，不联网，不使用数据库。
- 输入文件只读，输出文件由用户通过保存对话框选择。
- 结构损坏、origin 缺失、缓存卷引用不完整或无法安全映射时，工具会拒绝生成结果。
- 输出结果必须由工程师在实际恢复前自行备份、审查并验证。

## 开发测试

需要 Node.js 18 或更高版本：

```powershell
node --test tests\app.test.js
```

发布包不包含 Java/Maven、Docker、SQLite、`target`、`data` 或 `about_project` 样例目录。
