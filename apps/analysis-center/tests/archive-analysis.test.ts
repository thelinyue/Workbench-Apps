import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import yazl from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';
import { runArchiveAnalysis } from '../backend/lib/analysis/archive-analysis';
import { builtInAnalyzerRules } from '../backend/lib/analysis/built-in-rules';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('诊断包分析执行', () => {
  it('解压 .tgz、按内置规则分析并生成浏览器报告', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-archive-'));
    directories.push(root);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const extractDirectory = join(root, 'device');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed <danger> & "quoted"\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);

    const result = await runArchiveAnalysis({
      sourcePath: archivePath,
      extractDirectory,
      rules: builtInAnalyzerRules
    });

    await expect(access(result.reportPath)).resolves.toBeUndefined();
    await expect(access(join(extractDirectory, 'Report', 'static', 'workbench-report.css'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(extractDirectory, 'Report', 'static', 'workbench-report.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(extractDirectory, 'Report', 'structured', 'storage-health.json'))).resolves.toBeUndefined();
    await expect(access(join(extractDirectory, 'Report', 'structured', 'lsblk.html'))).resolves.toBeUndefined();
    expect(result.analysis.files[0].issues[0].message).toBe('nvmeI/O错误');
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('class="hero"');
    expect(report).toContain('class="diagnostic-banner');
    expect(report).toContain('id="searchInput"');
    expect(report).toContain('class="result-card');
    expect(report).not.toContain('static/workbench-report.js');
    expect(report).toContain('applyFilters');
    expect(report).toContain('综合分析');
    expect(report).toContain('&lt;danger&gt; &amp; &quot;quoted&quot;');
    expect(report).not.toMatch(/https?:\/\//);
  });

  it('综合报告使用插件 Bootstrap 资源和 structured 块设备入口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-plugin-report-contract-'));
    directories.push(root);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const extractDirectory = join(root, 'device');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);

    const result = await runArchiveAnalysis({ sourcePath: archivePath, extractDirectory, rules: builtInAnalyzerRules });
    const report = await readFile(result.reportPath, 'utf8');

    await expect(access(join(extractDirectory, 'Report', 'static', 'bootstrap.min.css'))).resolves.toBeUndefined();
    await expect(access(join(extractDirectory, 'Report', 'static', 'bootstrap.bundle.min.js'))).resolves.toBeUndefined();
    await expect(access(join(extractDirectory, 'Report', 'structured', 'lsblk.html'))).resolves.toBeUndefined();
    expect(report).toContain('href="static/bootstrap.min.css"');
    expect(report).toContain('src="static/bootstrap.bundle.min.js"');
    expect(report).toContain('class="layout-center"');
  });

  it('解压 ZIP 时只使用 ZIP 规则，并读取动态文件名与 gzip 日志', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-archive-'));
    directories.push(root);
    const archivePath = join(root, 'nas.zip');
    const extractDirectory = join(root, 'nas');
    await createZip(archivePath, [
      { name: 'EC554_syslog', content: 'nvme nvme0: I/O Error: shared marker\nnvme nvme0: I/O 1 QID 0 timeout, reset controller\nXFS (dm-0): Log I/O Error Detected. Shutting down filesystem\nUPS ups0@localhost on battery\nupsmon: Communications with UPS ups0@localhost lost\nupssched: Event: upsgone\n' },
      { name: 'EC554_dmsg.log.gz', content: gzipSync('nvme nvme0: Device not ready; aborting reset\nblk_update_request: I/O error, dev nvme0n1, sector 1\n') },
      { name: 'nas_storage.log.2', content: 'append hotplug event : remove  nvme0n1p1\n' }
    ]);

    const result = await runArchiveAnalysis({
      sourcePath: archivePath,
      extractDirectory,
      rules: builtInAnalyzerRules
    });

    const issues = result.analysis.files.flatMap((file) => file.issues);
    expect(issues.map((issue) => issue.message)).toEqual([
      'NVMe 设备未就绪，重置已中止',
      'NVMe 块设备发生 I/O 错误',
      'NVMe I/O 超时后控制器重置失败',
      'XFS 日志 I/O 错误，文件系统已强制关闭',
      'UPS 已切换至电池供电',
      'UPS 通信中断触发关机事件',
      '与 UPS 的通信已丢失',
      '存储服务记录到 NVMe 移除事件'
    ]);
    expect(issues.map((issue) => issue.severity)).toEqual(['critical', 'critical', 'critical', 'critical', 'warning', 'critical', 'info', 'critical']);
    expect(issues.some((issue) => issue.message === 'nvme控制器I/O超时')).toBe(false);
    expect(result.structured.overallHealth).toBe('critical');
  });

  it('存储健康分析使用专用仪表盘并隐藏规则日志结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-storage-report-'));
    directories.push(root);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const extractDirectory = join(root, 'device');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);

    const result = await runArchiveAnalysis({
      sourcePath: archivePath,
      extractDirectory,
      rules: builtInAnalyzerRules,
      scope: 'storage'
    });

    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('class="dashboard storage-report"');
    expect(report).toContain('存储健康分析');
    expect(report).toContain('class="metrics"');
    expect(report).toContain('客户回复话术');
    expect(report).not.toContain('id="searchInput"');
    expect(report).not.toContain('class="result-card');
  });

  it('存储健康报告使用原始设备健康模板并展示完整 SMART 信息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-storage-template-'));
    directories.push(root);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const extractDirectory = join(root, 'device');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'sysinfo.json'), JSON.stringify({
      deviceName: 'UGREEN DX4600',
      sn: 'SN-001',
      systemVersion: '1.2.3',
      platform: 'x86_64',
      network: { interface: [{ name: 'eth0', is_running: true, mac: 'AA:BB', ipv4: ['192.168.0.6'], mtu: 1500 }] },
      disk_info: [{
        name: 'sdc',
        dev_name: '/dev/sdc',
        label: 'Hard Drive 1',
        used_for: 'Storage Pool 1',
        slot: 'ata1',
        model: 'Example SSD',
        serial: 'DISK-001',
        brand: 'Example',
        interface_type: 'sata',
        size: 2000000000000,
        temperature: 40,
        power_on_hours: 18000,
        status: 1,
        smart: [{ id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw_string: '2', status: 1 }]
      }]
    }), 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['sysinfo.json']);

    const result = await runArchiveAnalysis({
      sourcePath: archivePath,
      extractDirectory,
      rules: builtInAnalyzerRules,
      scope: 'storage'
    });

    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('class="dashboard storage-report"');
    expect(report).toContain('class="metrics"');
    expect(report).toContain('物理硬盘');
    expect(report).toContain('查看全部 SMART');
    expect(report).toContain('Worst');
    expect(report).toContain('阈值');
    expect(report).toContain('存储用途');
    expect(report).toContain('data-detail-target="diagnosticDisk-0"');
    expect(report).not.toContain('id="searchInput"');
    expect(report).not.toContain('class="result-card');
    expect(report).not.toContain('当前为存储健康分析，不展示规则日志结果。');
  });

  it('存储报告包含插件模板的统计、拓扑、证据时间线和客户话术区域', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-storage-plugin-contract-'));
    directories.push(root);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const extractDirectory = join(root, 'device');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);

    const result = await runArchiveAnalysis({ sourcePath: archivePath, extractDirectory, rules: builtInAnalyzerRules, scope: 'storage' });
    const report = await readFile(result.reportPath, 'utf8');

    expect(report).toContain('class="metrics"');
    expect(report).toContain('存储池 / RAID');
    expect(report).toContain('文件系统异常');
    expect(report).toContain('工程处理项');
    expect(report).toContain('存储拓扑与异常链路');
    expect(report).toContain('证据时间线');
    expect(report).toContain('工程师处理建议');
    expect(report).toContain('客户回复话术');
  });
});

async function createZip(archivePath: string, files: Array<{ name: string; content: string | Buffer }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream
      .pipe(createWriteStream(archivePath))
      .on('close', resolve)
      .on('error', reject);
    files.forEach((file) => zip.addBuffer(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content), file.name));
    zip.end();
  });
}
