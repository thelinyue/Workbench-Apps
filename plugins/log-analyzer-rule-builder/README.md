# Log Analyzer Rule Builder

日志分析规则编辑器是赫菲斯托斯工程工作台的离线 EXE 插件，用于维护
[`log-analyzer-plugin`](https://github.com/thelinyue/Hephaestus-Workbench-Plugin-Sources/tree/main/plugins/log-analyzer-plugin) 使用的 JSON 规则。

## 功能

- 导入或新建规则集，编辑规则版本、文件匹配项和关键词规则。
- 检查空字段、无效方向、重复规则、上下文行数和常见正则错误。
- 将检查后的内容导出为 UTF-8 JSON，交由规则审核和下发流程处理。
- 完全离线运行，不修改案例源文件，也不直接覆盖已经发布的规则。

## 工作台协议

工作台按标准 EXE 插件协议调用：

```text
rule_editor.exe --case <case-id> --input <source-path> --output <output-path>
```

插件成功时返回退出码 `0`，并在 `--output` 目录生成自包含的 `report.html`。
`--input` 仅用于兼容工作台协议，插件不会读取或修改日志压缩包。

## 本地开发

需要 Go 1.24 或更高版本：

```powershell
go test ./...
go vet ./...
go build -o rule_editor.exe .
```

生成插件中心使用的 ZIP：

```powershell
.\scripts\build-release.ps1 -Version 1.0.0
```

ZIP 固定包含 `rule_editor.exe`、`manifest.json`、`README.md` 和 `LICENSE`。

## 使用方法

1. 在工作台中运行插件并打开生成的报告。
2. 点击“导入 JSON”选择现有规则文件，或从空规则集开始。
3. 编辑文件匹配项和关键词规则，点击“检查规则”处理错误或警告。
4. 点击“导出规则”下载 UTF-8 JSON 文件，再交由规则发布流程审核和下发。

## 许可证

[MIT](LICENSE)
