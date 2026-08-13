# 日志分析

这是 Hephaestus Workbench 的日志分析 EXE 插件，用于读取案例输入并在输出目录生成 `report.html`。

## 工作台协议

```text
log_analyzer.exe --case <case-id> --input <source-path> --output <output-path> --rules <active-rules-path>
```

插件成功时返回退出码 `0`，并在输出目录生成报告。插件 ID 为 `log-analyzer`，当前版本为 `1.0.3`。

`--rules` 用于加载工作台生成的 `Rules/Active/active.json`。指定后如果规则文件不存在、JSON 无效、方向非法、正则无效或存在重复规则，插件会输出中文错误并以非零退出码结束，不会静默回退到内置规则。不指定时才使用内置 `config.json`。

## 本地开发

需要 Go 1.24 或更高版本：

```powershell
go test ./...
go vet ./...
go build -trimpath -o log_analyzer.exe .
```

发布 ZIP 应直接包含 `log_analyzer.exe`、`manifest.json`、`README.md` 和 `config.json`。
