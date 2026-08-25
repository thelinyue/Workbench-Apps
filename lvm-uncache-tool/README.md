# LVM 缓存清理工具

工作台内嵌的本地 Web 工具，用于读取 LVM2 VG 文本备份，识别并清理缓存配置，生成可审阅的无缓存 VG 文件。

工具只在本地处理文本，不执行 `vgcfgrestore`、`lvremove`、`vgreduce` 等系统命令，也不会覆盖原始文件。
