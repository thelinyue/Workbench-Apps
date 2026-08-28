import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeStructuredExtract } from '../backend/lib/analysis/structured-analysis';
import type { AnalysisResult } from '../backend/lib/analysis/log-analyzer';

const temporaryDirectories: string[] = [];
const noRules: AnalysisResult = { files: [] };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('结构化存储分析', () => {
  it('解析原始 sysinfo 的设备、网卡、内存与完整 SMART 字段', async () => {
    const root = await createFixture({
      sysinfo: {
        deviceName: 'UGREEN DX4600',
        sn: 'SN-001',
        systemVersion: '1.2.3',
        architecture: 'x86_64',
        network: {
          interface: [{
            name: 'eth0',
            is_running: true,
            mac: 'AA:BB:CC:DD:EE:FF',
            ipv4: ['192.168.0.6'],
            ipv6: ['fe80::1'],
            mtu: 1500
          }]
        },
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
          smart: [
            { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 50, raw_string: '0', status: 1 },
            { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw_string: '0', status: 1 },
            { id: 1, name: 'Raw_Read_Error_Rate', value: 100, worst: 100, thresh: 50, raw_string: '0', status: 1 }
          ]
        }]
      },
      dmidecode: [
        'Memory Device',
        '\tSize: 16 GB',
        '\tManufacturer: Example',
        '\tPart Number: M-16   ',
        'Memory Device',
        '\tSize: No Module Installed',
        '\tManufacturer: Empty Slot',
        'Memory Device',
        '\tSize: 16 GB',
        '\tManufacturer: Example',
        '\tPart Number: M-16',
        'Memory Device',
        '\tSize: 8 GB',
        '\tModel: M-8',
        ''
      ].join('\n')
    });

    const result = await analyzeStructuredExtract(root, noRules);

    expect(result.memory).toEqual([
      { size: '16 GB', manufacturer: 'Example', model: 'M-16' },
      { size: '16 GB', manufacturer: 'Example', model: 'M-16' },
      { size: '8 GB', manufacturer: '', model: 'M-8' }
    ]);
    expect(result.networks).toEqual([{
      name: 'eth0',
      mac: 'AA:BB:CC:DD:EE:FF',
      ipv4: ['192.168.0.6'],
      ipv6: ['fe80::1'],
      status: '正常',
      state: 'UP',
      carrier: 'CARRIER',
      mtu: '1500'
    }]);
    expect(result.disks[0]).toMatchObject({
      name: 'sdc',
      label: 'Hard Drive 1',
      device: '/dev/sdc',
      usedFor: 'Storage Pool 1',
      slot: 'ata1',
      model: 'Example SSD',
      serial: 'DISK-001',
      brand: 'Example',
      interfaceType: 'sata',
      capacity: '1.82 TB',
      temperature: '40',
      powerOnHours: '750 天 0 小时',
      health: 'normal'
    });
    expect(result.disks[0].smart).toEqual([
      { id: 5, name: 'Reallocated_Sector_Ct', value: '100', worst: '100', threshold: '50', raw: '0', status: '正常' },
      { id: 197, name: 'Current_Pending_Sector', value: '100', worst: '100', threshold: '0', raw: '0', status: '正常' },
      { id: 1, name: 'Raw_Read_Error_Rate', value: '100', worst: '100', threshold: '50', raw: '0', status: '正常' }
    ]);
  });

  it('缺失或无效结构化字段时继续生成可展示的降级结果', async () => {
    const root = await createFixture({ sysinfo: '{invalid json' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(analyzeStructuredExtract(root, noRules)).resolves.toMatchObject({
        sysInfo: {},
        memory: [],
        networks: [],
        disks: [],
        overallHealth: 'unknown'
      });
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('解析 sysinfo.json 失败'));
    } finally {
      consoleError.mockRestore();
    }
  });
});

async function createFixture(options: { sysinfo?: Record<string, unknown> | string; dmidecode?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workbench-structured-analysis-'));
  temporaryDirectories.push(root);
  if (options.sysinfo !== undefined) {
    await writeFile(join(root, 'sysinfo.json'), typeof options.sysinfo === 'string' ? options.sysinfo : JSON.stringify(options.sysinfo), 'utf8');
  }
  if (options.dmidecode) await writeFile(join(root, 'dmidecode'), options.dmidecode, 'utf8');
  return root;
}
