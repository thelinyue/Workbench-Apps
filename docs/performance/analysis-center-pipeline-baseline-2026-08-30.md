# 分析中心 Pipeline 性能基线（2026-08-30）

> 开发者基准：主进程内 Pipeline + 生产成功持久化；不包含发布版 Worker 启动开销。

## 基准协议

| 项目 | 值 |
|---|---:|
| 样本 ID | real-zip-20260830 |
| 归档大小 | 41,154,086 bytes |
| 归档文件数 | 1,069 |
| 预热 / 测量 | 1 / 5 |
| 独立解压目录 / SQLite | 6 / 6 |
| 语义等价 | 通过 |

## 总耗时

| min | P50 | max |
|---:|---:|---:|
| 1403.425 ms | 1533.009 ms | 1714.131 ms |

## 分阶段耗时

| 阶段 | min | P50 | max | P50 占总耗时 |
|---|---:|---:|---:|---:|
| input.recognition | 5.787 ms | 6.514 ms | 10.856 ms | 0.42% |
| archive.extract | 1234.869 ms | 1357.053 ms | 1549.012 ms | 88.52% |
| source.read | 9.834 ms | 10.159 ms | 11.223 ms | 0.66% |
| parser.total | 47.339 ms | 52.335 ms | 54.580 ms | 3.41% |
| rules.event.total | 54.902 ms | 56.820 ms | 60.164 ms | 3.71% |
| finding.aggregate | 0.066 ms | 0.068 ms | 0.079 ms | 0.00% |
| diagnosis.compose | 0.347 ms | 0.411 ms | 0.421 ms | 0.03% |
| recommendation.compose | 0.026 ms | 0.029 ms | 0.031 ms | 0.00% |
| report.render | 0.654 ms | 0.847 ms | 0.966 ms | 0.06% |
| persistence | 10.000 ms | 11.852 ms | 17.871 ms | 0.77% |

## 耗时 Top 3

| 排名 | 阶段 | P50 | 定位 | 后续优化方向 | 准确性保护 |
|---:|---|---:|---|---|---|
| 1 | archive.extract | 1357.053 ms | 诊断包解压与成员落盘 | 评估解压 I/O、压缩格式和临时目录写入成本 | 不得跳过归档成员或复用含旧文件的解压目录 |
| 2 | rules.event.total | 56.820 ms | Event Rule Regex 扫描 | 检查候选行比例、全规则调用和重复命中 | 不得减少规则覆盖、命中 Event 或关联 Evidence |
| 3 | parser.total | 52.335 ms | 结构化 Parser 与文本行解析 | 检查 Parser 热点和不必要的中间对象 | 结构化文件必须由对应 Parser 完整处理 |

## 优先排查结论

| 检查项 | 结果 |
|---|---:|
| 文件清单遍历次数 | 1 |
| 重复文件扫描 | 未检测到 |
| 每候选行 Regex 调用 | 31.000 |
| 重复 Event / Evidence | 0 / 0 |
| Finding Evidence 引用 / 唯一引用 | 57 / 57 |
| 结构化文件文本扫描 | 未检测到 |

## 核心计数

| 指标 | 数量 |
|---|---:|
| fileInventoryPasses | 1 |
| directoriesVisited | 1 |
| filesDiscovered | 1,069 |
| filesIgnored | 1,066 |
| filesRead | 3 |
| bytesRead | 2,265,784 |
| decodedBytes | 2,395,135 |
| structuredFilesParsed | 0 |
| linesProcessed | 28,927 |
| candidateLines | 4,106 |
| ruleInvocations | 127,286 |
| ruleMatches | 57 |
| eventsCreated | 57 |
| findingsCreated | 19 |
| evidenceRetained | 57 |
| diagnosesCreated | 0 |
| recommendationsCreated | 0 |
| duplicateEvents | 0 |
| duplicateEvidence | 0 |
| findingEvidenceReferences | 57 |
| uniqueFindingEvidenceReferences | 57 |

## Top 10 文件

| 匿名文件 | 来源 | P50 | 读取字节 | 解码字节 | 行数 | Event | Evidence |
|---|---|---:|---:|---:|---:|---:|---:|
| kernel-01 | kernel | 97.074 ms | 2,073,370 | 2,073,370 | 24,590 | 19 | 19 |
| kernel-02 | kernel | 7.612 ms | 160,825 | 160,825 | 2,055 | 19 | 19 |
| kernel-03 | kernel | 7.086 ms | 31,589 | 160,940 | 2,282 | 19 | 19 |

## Top 10 规则

| Rule ID | P50 | 调用 | 命中 |
|---|---:|---:|---:|
| storage.timeout | 1.038 ms | 4,106 | 0 |
| system.oom_killer | 1.038 ms | 4,106 | 0 |
| storage.scsi.medium | 1.036 ms | 4,106 | 0 |
| storage.scsi.medium.device | 1.031 ms | 4,106 | 0 |
| filesystem.readonly | 1.014 ms | 4,106 | 0 |
| storage.device.unrecognized.named | 0.992 ms | 4,106 | 0 |
| storage.ata.error | 0.984 ms | 4,106 | 0 |
| storage.device.unrecognized.ata | 0.977 ms | 4,106 | 0 |
| storage.nvme.timeout_aborting | 0.973 ms | 4,106 | 0 |
| storage.device_reset | 0.969 ms | 4,106 | 0 |

## 准确性保护

5 次测量结果在仅忽略 AnalysisResult.id、metadata.startTime、metadata.completeTime、metadata.duration 后完全相等。性能优化不得减少规则覆盖、日志覆盖、诊断准确率或 Evidence。

本报告不包含输入路径、真实文件名、原始日志、Evidence 内容、序列号、资源、诊断文案、HTML、错误消息或临时目录。
