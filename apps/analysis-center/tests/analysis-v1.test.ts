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

  it('XFS metadata corruption 仍进入文件系统异常规则，不能被性能预筛选跳过', () => {
    const result = analyzeV1Sources({
      sourceName: 'xfs-corruption.tgz',
      files: { 'kern.log': 'XFS (dm-0): Metadata corruption detected at xfs_inode.c:123' }
    });

    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'filesystem.error:system' })]));
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

  it('先列出异常硬盘，再提示关联 RAID 0 的无冗余风险', () => {
    const result = analyzeV1Sources({
      sourceName: 'raid0-disk-risk.tgz',
      files: {
        'mdstat.log': 'md0 : active raid0 sda1[0] sdb1[1]\n      100 blocks [2/2] [UU]',
        'sysinfo.json': JSON.stringify({ disk: { devices: [
          { disk_info: { dev_name: '/dev/sda', label: 'Hard Drive 2', serial: 'SERIAL-002' }, smart_info: { report: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 2 }] } },
          { disk_info: { dev_name: '/dev/sdb', label: 'Hard Drive 3', serial: 'SERIAL-003' }, smart_info: { report: [{ id: 197, name: 'Current_Pending_Sector', raw: 1 }] } }
        ] } })
      }
    });

    const reply = result.diagnoses.find((item) => item.id === 'storage.multiple_devices.failure_suspected')?.userConclusion;
    expect(reply).toContain('发现 2 块硬盘存在异常');
    expect(reply).toContain('硬盘 2（序列号：SERIAL-002）：硬盘健康信息存在异常。');
    expect(reply).toContain('硬盘 3（序列号：SERIAL-003）：硬盘健康信息存在异常。');
    expect(reply).toContain('RAID 0 无冗余，一块硬盘故障可能导致整个阵列数据不可用，请立即备份数据。');
    expect(reply!.indexOf('硬盘 3')).toBeLessThan(reply!.indexOf('RAID 0'));
  });

  it('同一存储池的 RAID 1 有两块异常成员时只提示一次并要求立即备份', () => {
    const result = analyzeV1Sources({
      sourceName: 'raid1-two-failed-disks.tgz',
      files: {
        'mdstat.log': [
          'md4 : active raid1 sdd2[0]',
          '      100 blocks [1/1] [U]',
          'md1 : active raid1 sdb2[0](F) sda2[1]',
          '      100 blocks [2/1] [_U]'
        ].join('\n'),
        'sysinfo.json': JSON.stringify({ disk: { devices: [
          { disk_info: { dev_name: '/dev/sda', label: 'Hard Drive 1', serial: 'SERIAL-001', used_for: 'Storage Pool 1' }, smart_info: { report: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 480 }] } },
          { disk_info: { dev_name: '/dev/sdb', label: 'Hard Drive 2', serial: 'SERIAL-002', used_for: 'Storage Pool 1' }, smart_info: { report: [{ id: 197, name: 'Current_Pending_Sector', raw: 680 }] } },
          { disk_info: { dev_name: '/dev/sdd', label: 'Hard Drive 4', serial: 'SERIAL-004', used_for: 'Storage Pool 3' }, smart_info: { report: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 3 }] } }
        ] } })
      }
    });

    const reply = result.diagnoses.find((item) => item.id === 'storage.multiple_devices.failure_suspected')?.userConclusion ?? '';
    const highRiskMessage = '存储池 1 的 RAID 1（md1）中，硬盘 1、硬盘 2 均存在异常，阵列数据处于高风险，请立即备份重要数据并尽快更换故障硬盘。';
    expect(reply.split(highRiskMessage)).toHaveLength(2);
    expect(reply).not.toContain('RAID 1 已降级，当前冗余降低');
  });

  it.each([
    ['raid1', 'RAID 1（md0）已降级，硬盘 1 存在异常，当前冗余降低，请尽快备份重要数据并更换故障硬盘。'],
    ['raid5', 'RAID 5 已失去冗余，再有一块硬盘故障可能导致数据不可用，请立即备份。'],
    ['raid6', 'RAID 6 冗余能力已降低，请尽快备份并更换故障硬盘。'],
    ['raid10', 'RAID 10 已降级，请尽快备份并更换故障硬盘。'],
    ['linear', 'JBOD 无冗余，故障硬盘上的数据可能无法访问，请立即备份数据。']
  ])('为 %s 阵列生成对应的用户风险提示', (level, expected) => {
    const result = analyzeV1Sources({
      sourceName: `${level}-disk-risk.tgz`,
      files: {
        'mdstat.log': `md0 : active ${level} sda1[0] sdb1[1]\n      100 blocks [2/1] [U_]`,
        'sysinfo.json': JSON.stringify({ disk: { devices: [
          { disk_info: { dev_name: '/dev/sda', label: 'Hard Drive 1', serial: 'SERIAL-001' }, smart_info: { report: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: 2 }] } }
        ] } })
      }
    });

    expect(result.diagnoses.find((item) => item.primaryResource === '/dev/sda')?.userConclusion).toContain(expected);
  });

  it('在硬盘 SMART 正常且存储池文件系统错误时提示远程修复', () => {
    const result = analyzeV1Sources({
      sourceName: 'filesystem-repair.tgz',
      files: {
        'mdstat.log': 'md0 : active raid1 sda1[0] sdb1[1]\n      100 blocks [2/2] [UU]',
        'ugvolume.log': "pool[pool1] /dev/md0 assemble by 2 disks\npool1-volume mntPath:/volume1\npool1-volume can't read superblock",
        'sysinfo.json': JSON.stringify({ disk: { devices: [
          { disk_info: { dev_name: '/dev/sda' }, smart_info: { report: [] } },
          { disk_info: { dev_name: '/dev/sdb' }, smart_info: { report: [] } }
        ] } })
      }
    });

    expect(result.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'filesystem.storage.repair',
      userConclusion: '您好，经分析诊断日志，当前硬盘健康信息正常，但存储池下的存储空间文件系统存在异常，需要给您修复文件系统。'
    })]));
  });

  it('仅在明确掉盘日志出现时提示关机后重新插拔或换槽', () => {
    const unavailable = analyzeV1Sources({
      sourceName: 'device-unavailable.tgz',
      files: { 'kern.log': 'ata1: SATA link down (SStatus 0 SControl 300)' }
    });
    const timeout = analyzeV1Sources({
      sourceName: 'device-timeout.tgz',
      files: { 'kern.log': 'sd 0:0:0:0: timing out command, dev sda' }
    });

    expect(unavailable.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'storage.device.unrecognized',
      userConclusion: '您好，经分析诊断日志，硬盘当前未被系统识别，可能存在硬盘接触或槽位异常。请先关机后重新插拔硬盘，或更换其他硬盘槽位接入后再观察。'
    })]));
    expect(timeout.diagnoses).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'storage.device.unrecognized' })]));
  });

  it('掉盘日志可定位硬盘时在用户话术中带出硬盘名称', () => {
    const result = analyzeV1Sources({
      sourceName: 'identified-device-unavailable.tgz',
      files: {
        'kern.log': 'sda: link is down',
        'sysinfo.json': JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sda', label: 'Hard Drive 4' }, smart_info: { report: [] } }] } })
      }
    });

    expect(result.diagnoses.find((item) => item.id === 'storage.device.unrecognized')?.userConclusion).toContain('硬盘 4 当前未被系统识别');
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
      userConclusion: expect.stringContaining('硬盘 1（序列号：SERIAL-001）：检测到多次读写错误（I/O Error）；硬盘健康信息存在异常。'),
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
