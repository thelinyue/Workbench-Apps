import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterEach, expect, it } from 'vitest';
import { runV1ArchiveAnalysis } from '../backend/lib/analysis/archive-analysis';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('归档分析返回 V1 AnalysisResult，而不是旧关键词报告模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-archive-'));
  directories.push(root);
  await writeFile(join(root, 'kern.log'), '2026-08-26T03:12:01+08:00 kernel: blk_update_request: I/O error, dev sdc, sector 1');
  await writeFile(join(root, 'mdstat.log'), 'md0 : active raid1 sdc2[1](F) sdb2[0]\n      100 blocks [2/1] [U_]');
  await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sdc', label: 'Hard Drive 3', serial: 'SERIAL-003', used_for: 'Storage Pool 3' }, smart_info: { report: [{ id: 197, name: 'Current_Pending_Sector', raw: 2 }] } }] } }));
  const archivePath = join(root, 'fixture.tgz');
  await tar.c({ gzip: true, file: archivePath, cwd: root }, ['kern.log', 'mdstat.log', 'sysinfo.json']);

  const result = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted') });

  expect(result.result.diagnoses[0]).toMatchObject({ id: 'storage.device.suspected_failure', primaryResource: '/dev/sdc' });
  expect(result.browserPath).toContain('analysis-result.html');
  expect(await readFile(result.browserPath, 'utf8')).toContain('硬盘 3（序列号：SERIAL-003，用于：存储池 3）的健康检测发现异常，同时记录到 I/O 读写错误，判断该硬盘已出现故障');
});
