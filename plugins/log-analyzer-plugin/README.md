# Log Analyzer Plugin

这是 Hephaestus Workbench 的日志分析 EXE 插件，用于读取案例输入并在输出目录生成 `report.html`。

## 工作台协议

```text
log_analyzer.exe --case <case-id> --input <source-path> --output <output-path>
```

插件成功时返回退出码 `0`，并在输出目录生成报告。插件 ID 为 `log-analyzer`，当前版本为 `1.0.1`。

## 本地开发

需要 Go 1.24 或更高版本：

```powershell
go test ./...
go vet ./...
go build -trimpath -o log_analyzer.exe .
```

发布 ZIP 应直接包含 `log_analyzer.exe`、`manifest.json`、`README.md` 和 `config.json`。
