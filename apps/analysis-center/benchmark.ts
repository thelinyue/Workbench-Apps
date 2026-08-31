import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkArguments, runPipelineBenchmark, writePipelineBenchmarkReports } from './backend/lib/analysis-v1/pipeline-benchmark';

const args = parseBenchmarkArguments(process.argv.slice(2));
const outputDirectory = args.outputDirectory
  ? resolve(args.outputDirectory)
  : fileURLToPath(new URL('../../docs/performance/', import.meta.url));
const report = await runPipelineBenchmark(args.inputPath);
await writePipelineBenchmarkReports(report, outputDirectory);

console.log('分析中心 Pipeline 性能基线已写入报告目录。');
for (const stage of report.topStages) console.log(`Top ${stage.rank}: ${stage.stage}，P50 ${stage.p50Ms.toFixed(3)} ms，占总耗时 ${stage.shareOfTotalP50Percent.toFixed(2)}%`);
