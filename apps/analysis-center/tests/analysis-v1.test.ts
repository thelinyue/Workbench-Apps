import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { analyzeV1Sources } from '../backend/lib/analysis-v1/pipeline';

describe('V1 统一诊断分析', () => {
  it('将磁盘、SMART、RAID 与文件系统证据聚合为一个主要诊断', () => {
    const result = analyzeV1Sources({
      sourceName: 'storage-failure.tgz',
      files: {
        'log/kern.log': [
          '2026-08-26T03:12:01+08:00 kernel: blk_update_request: I/O error, dev sdc, sector 1',
          '2026-08-26T03:12:20+08:00 kernel: Buffer I/O error on dev sdc, logical block 2',
          '2026-08-26T03:13:00+08:00 kernel: EXT4-fs error (device md0): I/O failure'
        ].join('\n'),
        'mdstat.log': 'md0 : active raid1 sdc2[1](F) sdb2[0]\n      100 blocks [2/1] [U_]',
        'ugvolume.log': 'pool[storage1] /dev/md0 assemble by 2 disks\nvolume[storage1] mntPath /volume1',
        'sysinfo.json': JSON.stringify({ disk_info: [{ dev_name: '/dev/sdc', smart: [
          { name: 'Current_Pending_Sector', raw_string: '184' },
          { name: 'Offline_Uncorrectable', raw_string: '2' }
        ] }] })
      }
    });

    expect(result.status).toBe('completed');
    expect(result.diagnoses).toEqual([expect.objectContaining({
      id: 'storage.device.suspected_failure',
      primaryResource: '/dev/sdc',
      severity: 'critical',
      confidence: 'high',
      affectedResources: expect.arrayContaining(['/dev/sdc', 'md0', 'storage1'])
    })]);
    expect(result.recommendations.map((item) => item.title)).toEqual(expect.arrayContaining(['检查 /dev/sdc SMART', '确认 md0 当前冗余状态']));
  });

  it('仅凭单个 I/O 事件只形成事实 Finding，不推断物理磁盘故障', () => {
    const result = analyzeV1Sources({
      sourceName: 'single-io.tgz',
      files: { 'log/kern.log': '2026-08-26T03:12:01+08:00 kernel: blk_update_request: I/O error, dev sdc, sector 1' }
    });

    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'storage.io_error:/dev/sdc', occurrenceCount: 1 })]));
    expect(result.diagnoses).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'storage.device.suspected_failure' })]));
  });

  it('将无 /dev 前缀的设备名和 raw_value SMART 原始值归一化为设备风险', () => {
    const result = analyzeV1Sources({
      sourceName: 'normalized-smart-risk.tgz',
      files: {
        'sysinfo.json': JSON.stringify({ disk: { devices: [{
          disk_info: { dev_name: 'sde' },
          smart_info: { report: [{ id: 197, name: 'Current_Pending_Sector', raw_value: 2 }] }
        }] } }),
        'mdstat.log': ''
      }
    });

    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'storage.smart_risk:/dev/sde' })]));
    expect(result.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'storage.device.smart_risk', primaryResource: '/dev/sde', confidence: 'high'
    })]));
  });

  it('将 UGREEN sysinfo 中同级 disk_info 的 SMART 05、197、198 归属到对应磁盘，并提示多盘介质风险', () => {
    const disk = (name: string, attributes: Array<{ id: number; name: string; raw: number }>) => ({
      disk_info: { dev_name: `/dev/${name}` },
      smart_info: { report: attributes.map((attribute) => ({ ...attribute, raw_string: String(attribute.raw) })) }
    });
    const result = analyzeV1Sources({
      sourceName: 'four-smart-risk.tgz',
      files: {
        'sysinfo.json': JSON.stringify({ disk: { devices: [
          disk('sda', [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 180 }, { id: 197, name: 'Current_Pending_Sector', raw: 121 }, { id: 198, name: 'Offline_Uncorrectable', raw: 15 }]),
          disk('sdb', [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 40 }]),
          disk('sdc', [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 1 }, { id: 197, name: 'Current_Pending_Sector', raw: 13 }, { id: 198, name: 'Offline_Uncorrectable', raw: 5 }]),
          disk('sdd', [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 1585 }, { id: 197, name: 'Current_Pending_Sector', raw: 1 }]),
          disk('nvme0n1', [{ id: 5, name: 'data_units_read', raw: 23 }])
        ] } }),
        'mdstat.log': ''
      }
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.smart_risk:/dev/sda' }),
      expect.objectContaining({ id: 'storage.smart_risk:/dev/sdb' }),
      expect.objectContaining({ id: 'storage.smart_risk:/dev/sdc' }),
      expect.objectContaining({ id: 'storage.smart_risk:/dev/sdd' })
    ]));
    expect(result.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'storage.multiple_devices.failure_suspected',
      severity: 'critical',
      confidence: 'high',
      affectedResources: expect.arrayContaining(['/dev/sda', '/dev/sdb', '/dev/sdc', '/dev/sdd'])
    })]));
    expect(result.findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'storage.smart_risk:/dev/nvme0n1' })]));
    expect(result.evidence.filter((item) => item.eventType === 'storage.smart_risk')).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: '/dev/sda' }),
      expect.objectContaining({ resource: '/dev/sdb' }),
      expect.objectContaining({ resource: '/dev/sdc' }),
      expect.objectContaining({ resource: '/dev/sdd' })
    ]));
  });

  it('把 sysinfo 硬盘身份写入结果，并生成可发送给用户和工程师的结论', () => {
    const result = analyzeV1Sources({
      sourceName: 'identified-disk-risk.tgz',
      files: {
        'log/kern.log': '2026-08-26T03:12:01+08:00 kernel: blk_update_request: I/O error, dev sda, sector 1',
        'mdstat.log': '',
        'sysinfo.json': JSON.stringify({ disk: { devices: [{
          disk_info: { dev_name: '/dev/sda', label: 'Hard Drive 1', model: 'WDC Test', serial: 'SERIAL-001', slot: 'ata1', used_for: 'Storage Pool 1' },
          smart_info: { report: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 2 }] }
        }, {
          disk_info: { dev_name: '/dev/nvme0n1', label: 'M.2 Hard Drive 1', model: 'NVMe Test', serial: 'NVME-001', slot: 'nvme1', used_for: 'SSD Cache 1' },
          smart_info: { report: [{ id: 5, name: 'data_units_read', raw: 99 }] }
        }] } })
      }
    });

    expect(result.deviceAssessments).toEqual(expect.arrayContaining([expect.objectContaining({
      resource: '/dev/sda', label: 'Hard Drive 1', model: 'WDC Test', serial: 'SERIAL-001', slot: 'ata1', usedFor: 'Storage Pool 1',
      smartRiskAttributes: [expect.objectContaining({ id: 5, raw: 2 })], ioErrorCount: 1
    })]));
    expect(result.deviceAssessments).toEqual(expect.arrayContaining([expect.objectContaining({ resource: '/dev/nvme0n1', smartRiskAttributes: [] })]));
    expect(result.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'storage.device.suspected_failure',
      affectedDeviceResources: ['/dev/sda'],
      userConclusion: expect.stringContaining('硬盘 1（序列号：SERIAL-001，用于：存储池 1）的健康检测发现异常，同时记录到 I/O 读写错误，判断该硬盘已出现故障'),
      engineerConclusion: expect.stringContaining('SMART 05 原始值 2')
    })]));
  });

  it('回归夹具将 SMART、I/O 与文件系统影响关联为高置信度诊断，且不误报单成员 RAID 降级', async () => {
    const fixture = new URL('./fixtures/full-storage-fault-chain/', import.meta.url);
    const files = Object.fromEntries(await Promise.all(['journal-5days.log', 'mdstat.log', 'ugvolume.log', 'sysinfo.json'].map(async (name) => [name, await readFile(new URL(name, fixture), 'utf8')])));
    const result = analyzeV1Sources({ sourceName: 'full-storage-fault-chain.tgz', files });

    expect(result.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'storage.device.suspected_failure', primaryResource: '/dev/sda', confidence: 'high',
      affectedResources: expect.arrayContaining(['/dev/sda', 'md2', 'pool3', '/volume3'])
    })]));
    expect(result.diagnoses).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'raid.array.degraded' })]));
  });
});
