import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtInAnalyzerRules } from '../backend/lib/analysis/built-in-rules';
import { analyzeExtractedDirectory, analyzeExtractedDirectoryWithStats, type AnalyzerRuleConfig } from '../backend/lib/analysis/log-analyzer';

const directories: string[] = [];
const rules: AnalyzerRuleConfig = {
  version: 'test',
  files: [{
    name: 'kern',
    category: '内核服务',
    keywords: [{
      term: 'nvme.*I/O Error',
      result: 'NVMe I/O 错误',
      regex: true,
      severity: 'critical',
      context_lines: 1,
      context_direction: 'down'
    }]
  }]
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('内置日志分析引擎', () => {
  it('按插件规则扫描解压目录并保留命中上下文', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-analysis-'));
    directories.push(extractDirectory);
    await mkdir(join(extractDirectory, 'logs'));
    await writeFile(
      join(extractDirectory, 'logs', 'kern'),
      '第一行\nnvme I/O Error: controller failed\n第三行\n',
      'utf8'
    );

    const result = await analyzeExtractedDirectory(extractDirectory, rules);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ file: 'logs/kern', category: '内核服务' });
    expect(result.files[0].issues[0]).toMatchObject({
      keyword: 'nvme.*I/O Error',
      message: 'NVMe I/O 错误',
      severity: 'critical',
      line: 2,
      contextLines: [
        { number: 2, text: 'nvme I/O Error: controller failed', hit: true },
        { number: 3, text: '第三行', hit: false }
      ]
    });
  });

  it('不会把规则未声明的文件写入分析结果', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-analysis-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'unrelated.log'), 'nvme I/O Error', 'utf8');

    await expect(analyzeExtractedDirectory(extractDirectory, rules)).resolves.toEqual({ files: [] });
  });

  it('扫描时按已处理文件数报告进度', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-progress-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'kern'), '错误', 'utf8');
    await writeFile(join(extractDirectory, 'ignored.log'), '无关', 'utf8');
    const updates: number[] = [];
    await analyzeExtractedDirectory(extractDirectory, { files: [{ name: 'kern', category: '内核', keywords: [{ term: '错误', result: '错误' }] }] }, (progress) => updates.push(progress.processedFiles));
    expect(updates).toEqual([1, 2]);
  });

  it('遵循插件规则的向上搜索顺序', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-analysis-order-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'kern'), '错误一\n普通\n错误二', 'utf8');

    const result = await analyzeExtractedDirectory(extractDirectory, {
      files: [{ name: 'kern', category: '系统日志', keywords: [{ term: '错误', result: '错误', search_direction: 'up' }] }]
    });

    expect(result.files[0].issues.map((item) => item.line)).toEqual([3, 1]);
  });

  it('TGZ通用规则识别重启、文件系统恢复和UPS事件', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-tgz-rules-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'kern'), [
      'kernel: [0.000000] Linux version 6.12.30+',
      'EXT4-fs (dm-0): 3 orphan inodes deleted',
      'EXT4-fs (dm-0): recovery complete'
    ].join('\n'), 'utf8');
    await writeFile(join(extractDirectory, 'syslog'), [
      'UPS ups0@localhost on battery',
      'upsmon: Communications with UPS ups0@localhost lost',
      'upssched: Event: upsgone'
    ].join('\n'), 'utf8');

    const result = await analyzeExtractedDirectory(extractDirectory, builtInAnalyzerRules.tgz);
    const issues = result.files.flatMap((file) => file.issues);
    const terms = builtInAnalyzerRules.tgz.files.flatMap((file) => file.keywords.map((keyword) => keyword.term));

    expect(terms).not.toEqual(expect.arrayContaining(['NormalFlag', '因电源或其它原因导致设备异常关机', 'not usb ups']));
    expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      '记录到内核启动标记，可用于确认一次启动或重启',
      'EXT4 清理未正常关闭遗留的 orphan inode，支持上次异常中断',
      'EXT4 文件系统启动时完成日志恢复，支持上次未正常卸载',
      'UPS 已切换至电池供电，说明外部输入曾出现异常',
      'UPS 通信丢失，需结合 UPS 事件日志判断是否发生掉电',
      'UPS 设备离线，需结合 UPS 事件日志判断是否发生掉电'
    ]));
  });

  it('异常重启规则识别点号日志名中的内存压力、异常中断和启动边界', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-reboot-rules-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'journal-5days.log'), [
      'earlyoom: low memory! at or below SIGKILL limits',
      'earlyoom: swap free: 0 of 8192 MiB',
      'systemd-journald: File /var/log/journal/system.journal corrupted or uncleanly shut down, renaming and replacing.',
      '-- Boot 0123456789abcdef --'
    ].join('\n'), 'utf8');

    const result = await analyzeExtractedDirectory(extractDirectory, builtInAnalyzerRules.tgz);
    expect(result.files[0]?.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      '检测到严重内存压力，earlyoom 已进入强制终止进程阶段，可能导致关键服务退出',
      '交换空间已耗尽，支持严重内存压力判断',
      '系统日志未正常关闭，说明上次运行异常中断，但不能单独确定重启原因',
      '检测到系统启动边界，仅用于确认发生过启动或重启'
    ]));
  });

  it('异常重启规则不把已知无因果关系的日志当作重启证据', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-reboot-negative-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'journal-5days.log'), [
      'ramoops: attached 0x100000@0x12340000',
      'POST /ugreen/v1/desktop/reboot --> handler registered',
      'systemd[1888]: Reached target shutdown.target',
      'mcu wdt rst falg:00',
      'ffprobe -show_streams movie.mkv'
    ].join('\n'), 'utf8');

    await expect(analyzeExtractedDirectory(extractDirectory, builtInAnalyzerRules.tgz)).resolves.toEqual({ files: [] });
  });

  it('带统计的扫描只读取选中规则声明的文件并返回处理行数', async () => {
    const extractDirectory = await mkdtemp(join(tmpdir(), 'workbench-rule-scan-stats-'));
    directories.push(extractDirectory);
    await writeFile(join(extractDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await writeFile(join(extractDirectory, 'unrelated.log'), 'nvme I/O Error: should not be read\n', 'utf8');

    const result = await analyzeExtractedDirectoryWithStats(extractDirectory, {
      version: 'test',
      files: [{ name: 'kern', category: '内核服务', keywords: [{ term: 'nvme.*I/O Error', result: 'NVMe I/O 错误', regex: true }] }]
    });

    expect(result).toMatchObject({ processedFiles: 2, matchedFiles: 1, processedLines: 1 });
    expect(result.analysis.files).toHaveLength(1);
  });
});
