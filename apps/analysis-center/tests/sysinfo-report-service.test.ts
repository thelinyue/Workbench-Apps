import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SysinfoReportService } from '../backend/lib/services/sysinfo-report-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('完整 sysinfo 报告服务', () => {
  it('从解压目录按深度和路径顺序选择 sysinfo，并在解压根目录生成报告', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'b'), { recursive: true });
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'b', 'sysinfo.json'), JSON.stringify({ deviceName: 'B device' }), 'utf8');
    await writeFile(join(root, 'a', 'sysinfo.json'), JSON.stringify({ deviceName: 'A device' }), 'utf8');

    const reportPath = await new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'history.tgz' });

    expect(reportPath).toBe(join(root, 'sysinfo-report.html'));
    await expect(readFile(reportPath, 'utf8')).resolves.toContain('A device');
    await expect(readFile(reportPath, 'utf8')).resolves.not.toContain('B device');
  });

  it('报告不旧于源文件时复用缓存，源文件更新后重新生成', async () => {
    const root = await createRoot();
    const sourcePath = join(root, 'sysinfo.json');
    const service = new SysinfoReportService();
    await writeFile(sourcePath, JSON.stringify({ deviceName: 'First device' }), 'utf8');
    const reportPath = await service.getReportPath({ extractPath: root, displayName: 'cache.tgz' });
    const firstReportStat = await stat(reportPath);

    await service.getReportPath({ extractPath: root, displayName: 'cache.tgz' });
    expect((await stat(reportPath)).mtimeMs).toBe(firstReportStat.mtimeMs);

    const newer = new Date(firstReportStat.mtimeMs + 2_000);
    await writeFile(sourcePath, JSON.stringify({ deviceName: 'Updated device' }), 'utf8');
    await utimes(sourcePath, newer, newer);
    await service.getReportPath({ extractPath: root, displayName: 'cache.tgz' });
    await expect(readFile(reportPath, 'utf8')).resolves.toContain('Updated device');
  });

  it('按深度和路径顺序选择独立 dmidecode 文件并展示内存条', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'b'), { recursive: true });
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ deviceName: 'Memory device' }), 'utf8');
    await writeFile(join(root, 'b', 'dmidecode.log'), dmiMemory('32 GB', 'B vendor', 'B-32'), 'utf8');
    await writeFile(join(root, 'a', 'dmidecode.log'), dmiMemory('16 GB', 'A vendor', 'A-16'), 'utf8');

    const reportPath = await new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'memory.tgz' });
    const html = await readFile(reportPath, 'utf8');

    expect(html).toContain('16 GB');
    expect(html).toContain('A vendor');
    expect(html).toContain('A-16');
    expect(html).not.toContain('B vendor');
  });

  it('发现嵌套 lsblk.log 并在完整报告中生成存储链路表格', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'cmd'), { recursive: true });
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sda', name: 'sda' } }] } }), 'utf8');
    await writeFile(join(root, 'cmd', 'lsblk.log'), lsblk('sda'), 'utf8');

    const reportPath = await new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'lsblk.tgz' });
    const html = await readFile(reportPath, 'utf8');
    const table = html.match(/<table class="block-devices-table">([\s\S]*?)<\/table>/)?.[1] ?? '';

    expect(table).toContain('sda');
    expect(table).toContain('sda1');
    expect(html).toContain('lsblk.tgz');
  });

  it('lsblk.log 更新后使完整报告缓存失效', async () => {
    const root = await createRoot();
    const lsblkPath = join(root, 'lsblk.log');
    const service = new SysinfoReportService();
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sda', name: 'sda' } }] } }), 'utf8');
    await writeFile(lsblkPath, lsblk('sda', '/old'), 'utf8');
    const reportPath = await service.getReportPath({ extractPath: root, displayName: 'cache-lsblk.tgz' });

    const newer = new Date((await stat(reportPath)).mtimeMs + 2_000);
    await writeFile(lsblkPath, lsblk('sda', '/updated'), 'utf8');
    await utimes(lsblkPath, newer, newer);
    await service.getReportPath({ extractPath: root, displayName: 'cache-lsblk.tgz' });

    await expect(readFile(reportPath, 'utf8')).resolves.toContain('/updated');
    await expect(readFile(reportPath, 'utf8')).resolves.not.toContain('/old');
  });

  it('旧格式完整报告即使时间较新也会重新生成以包含 lsblk 区域', async () => {
    const root = await createRoot();
    const reportPath = join(root, 'sysinfo-report.html');
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sda', name: 'sda' } }] } }), 'utf8');
    await writeFile(join(root, 'lsblk.log'), lsblk('sda'), 'utf8');
    await writeFile(reportPath, '<html>old report</html>', 'utf8');
    const future = new Date(Date.now() + 60_000);
    await utimes(reportPath, future, future);

    await new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'old-cache.tgz' });

    await expect(readFile(reportPath, 'utf8')).resolves.toContain('块设备存储链路');
    await expect(readFile(reportPath, 'utf8')).resolves.not.toContain('old report');
  });

  it('dmidecode 文件更新后使报告缓存失效', async () => {
    const root = await createRoot();
    const dmiPath = join(root, 'dmidecode.log');
    const service = new SysinfoReportService();
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ deviceName: 'Cache device' }), 'utf8');
    await writeFile(dmiPath, dmiMemory('8 GB', 'First vendor', 'FIRST-8'), 'utf8');
    const reportPath = await service.getReportPath({ extractPath: root, displayName: 'cache-memory.tgz' });
    const firstReportStat = await stat(reportPath);

    const newer = new Date(firstReportStat.mtimeMs + 2_000);
    await writeFile(dmiPath, dmiMemory('16 GB', 'Updated vendor', 'UPDATED-16'), 'utf8');
    await utimes(dmiPath, newer, newer);
    await service.getReportPath({ extractPath: root, displayName: 'cache-memory.tgz' });

    const html = await readFile(reportPath, 'utf8');
    expect(html).toContain('Updated vendor');
    expect(html).not.toContain('First vendor');
  });

  it('没有独立 dmidecode 文件时不使用 sysinfo memInfo', async () => {
    const root = await createRoot();
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({
      deviceName: 'No dmi device',
      memInfo: { size: '99 GB', manufacturer: 'sysinfo vendor' }
    }), 'utf8');

    const reportPath = await new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'no-dmi.tgz' });
    const html = await readFile(reportPath, 'utf8');

    expect(html).toContain('未提供内存信息');
    expect(html).not.toContain('<td class="mono strong">memInfo.size</td>');
    expect(html).not.toContain('<td class="mono">99 GB</td>');
  });

  it('跳过指向解压目录外的 dmidecode 符号链接', async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ deviceName: 'Linked DMI device' }), 'utf8');
    await writeFile(join(outsideRoot, 'dmidecode.log'), dmiMemory('64 GB', 'Outside vendor', 'OUTSIDE-64'), 'utf8');
    await symlink(outsideRoot, join(root, 'cmd'), process.platform === 'win32' ? 'junction' : 'dir');

    const reportPath = await new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'linked-dmi.tgz' });
    const html = await readFile(reportPath, 'utf8');

    expect(html).toContain('未提供内存信息');
    expect(html).not.toContain('Outside vendor');
    expect(html).not.toContain('OUTSIDE-64');
  });

  it('缺少或无法解析 sysinfo.json 时返回中文可读错误', async () => {
    const root = await createRoot();
    const service = new SysinfoReportService();
    await expect(service.getReportPath({ extractPath: root, displayName: 'missing.tgz' })).rejects.toThrow('该诊断包未包含 sysinfo.json');

    await writeFile(join(root, 'sysinfo.json'), '{invalid json', 'utf8');
    await expect(service.getReportPath({ extractPath: root, displayName: 'invalid.tgz' })).rejects.toThrow('sysinfo.json 格式无效');
  });

  it('拒绝诊断包预置的报告符号链接，且不覆盖解压目录外的文件', async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    const outsidePath = join(outsideRoot, 'outside');
    const markerPath = join(outsidePath, 'marker.txt');
    await mkdir(outsidePath);
    await writeFile(markerPath, 'outside remains unchanged', 'utf8');
    await symlink(outsidePath, join(root, 'sysinfo-report.html'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ deviceName: 'Linked report attack' }), 'utf8');

    await expect(new SysinfoReportService().getReportPath({ extractPath: root, displayName: 'linked.tgz' }))
      .rejects.toThrow('sysinfo 报告输出路径不能是符号链接');
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('outside remains unchanged');
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'analysis-sysinfo-report-'));
  temporaryDirectories.push(root);
  return root;
}

function dmiMemory(size: string, manufacturer: string, model: string): string {
  return `Memory Device\n\tSize: ${size}\n\tManufacturer: ${manufacturer}\n\tPart Number: ${model}\n`;
}

function lsblk(device: string, mountpoint = '/volume1'): string {
  return `NAME                                     MAJ:MIN RM   SIZE RO TYPE  MOUNTPOINTS\n${device}                                        8:0    0   3.6T  0 disk  \n└─${device}1                                     8:1    0   3.6T  0 part  ${mountpoint}\n`;
}
