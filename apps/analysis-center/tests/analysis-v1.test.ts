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

  it('介质故障优先显示 smart_info.label 并沿用硬盘名称中文化', () => {
    const result = analyzeV1Sources({
      sourceName: 'smart-label-media-failure.tgz',
      files: {
        'kern.log': [
          'ata1.00: error: { UNC }',
          'sd 0:0:0:0: [sdb] Sense Key : Medium Error [current]',
          'sd 0:0:0:0: [sdb] Add. Sense: Unrecovered read error - auto reallocate failed'
        ].join('\n'),
        'mdstat.log': '',
        'sysinfo.json': JSON.stringify({ disk: { devices: [{
          disk_info: { dev_name: '/dev/sdb', label: 'Hard Drive 1' },
          smart_info: { label: 'Hard Drive 2', report: [] }
        }] } })
      }
    });

    const diagnosis = result.diagnoses[0];
    expect(diagnosis).toEqual(expect.objectContaining({
      id: 'storage.device.media_failure',
      title: '硬盘 2 存在介质故障',
      summary: '硬盘 2 存在不可恢复介质读取错误。',
      userConclusion: '您好，经分析诊断日志，硬盘 2 存在不可恢复介质读取错误，建议更换硬盘 2。',
      engineerConclusion: expect.stringContaining('硬盘 2：')
    }));
    expect(diagnosis.title).not.toContain('/dev/sdb');
    expect(result.deviceAssessments).toEqual([expect.objectContaining({ resource: '/dev/sdb', label: 'Hard Drive 2' })]);
  });

  it('介质故障没有 smart_info.label 时回退到 disk_info.label', () => {
    const result = analyzeV1Sources({
      sourceName: 'disk-label-media-failure.tgz',
      files: {
        'kern.log': 'sd 0:0:0:0: [sdb] Add. Sense: Unrecovered read error - auto reallocate failed',
        'sysinfo.json': JSON.stringify({ disk: { devices: [{
          disk_info: { dev_name: '/dev/sdb', label: 'Hard Drive 3' },
          smart_info: { report: [] }
        }] } })
      }
    });

    expect(result.diagnoses[0]?.title).toBe('硬盘 3 存在介质故障');
  });

  it('介质故障没有任何设备 label 时回退到设备路径', () => {
    const result = analyzeV1Sources({
      sourceName: 'resource-label-media-failure.tgz',
      files: { 'kern.log': 'sd 0:0:0:0: [sdb] Add. Sense: Unrecovered read error - auto reallocate failed' }
    });

    expect(result.diagnoses[0]?.title).toBe('/dev/sdb 存在介质故障');
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

  it('单独出现未映射到现有硬盘的 SATA link down 时不推断掉盘', () => {
    const unavailable = analyzeV1Sources({
      sourceName: 'device-unavailable.tgz',
      files: { 'kern.log': 'ata1: SATA link down (SStatus 0 SControl 300)' }
    });
    const timeout = analyzeV1Sources({
      sourceName: 'device-timeout.tgz',
      files: { 'kern.log': 'sd 0:0:0:0: timing out command, dev sda' }
    });

    expect(unavailable.diagnoses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.device.unrecognized' })
    ]));
    expect(unavailable.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'storage.sata_link_down', affectedResources: ['ata1'] })
    ]));
    expect(unavailable.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'storage.device_unrecognized' })
    ]));
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

  it('将真实硬盘 2 掉盘、设备数不一致与 RAID 缺失成员合并为关机换槽对比结论', async () => {
    const fixture = new URL('./fixtures/disk2-dropout-raid-degraded/', import.meta.url);
    const names = ['journal-5days.log', 'mdstat.log', 'ugvolume.log', 'sysinfo.json'];
    const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(new URL(name, fixture), 'utf8')])));
    const result = analyzeV1Sources({ sourceName: 'diag_EC671JJ172407493_202608281825.tgz', files });

    expect(result.diagnoses[0]).toEqual(expect.objectContaining({
      id: 'storage.device.unrecognized',
      title: '硬盘 2 掉盘且 RAID 已降级',
      summary: '硬盘 2 掉盘且 RAID 已降级。',
      primaryResource: 'ata2',
      affectedResources: expect.arrayContaining(['ata2', 'md1']),
      userConclusion: '您好，经分析诊断日志，硬盘 2 掉盘且 RAID 已降级。请关机后重新拔插硬盘 2；如仍未识别，请更换其他硬盘槽位接入对比，以判断是硬盘故障还是槽位异常。'
    }));
    expect(result.diagnoses[0].userConclusion).not.toContain('备份');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.io_error:/dev/sdb', occurrenceCount: 2 }),
      expect.objectContaining({ id: 'storage.device_count_mismatch:system' }),
      expect.objectContaining({ id: 'raid.degraded:md1' })
    ]));
    expect(result.diagnoses[0].affectedResources).not.toContain('/dev/sdb');
    expect(result.diagnoses[0].userConclusion).not.toContain('硬盘 3');
  });

  it('将跨启动设备名变化的介质错误归并到硬盘 2，并关联已移除成员与 RAID5 降级', async () => {
    const fixture = new URL('./fixtures/disk2-media-error-raid5-degraded/', import.meta.url);
    const names = ['kern.log', 'mdstat.log', 'sysinfo.json'];
    const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(new URL(name, fixture), 'utf8')])));
    const result = analyzeV1Sources({ sourceName: 'diag_EC752JJ222503616_2608281952.tgz', files });

    expect(result.diagnoses[0]).toEqual(expect.objectContaining({
      id: 'storage.device.media_failure',
      title: '硬盘 2 存在介质故障且 RAID 已降级',
      summary: '硬盘 2 存在重复的不可恢复介质读取错误，已被 RAID 5 移除，md1 当前处于降级状态。',
      primaryResource: '/dev/sda',
      affectedResources: expect.arrayContaining(['/dev/sda', 'ata2', 'md1']),
      affectedDeviceResources: ['/dev/sda'],
      confidence: 'confirmed',
      userConclusion: '您好，经分析诊断日志，硬盘 2 存在重复的不可恢复介质读取错误，已被 RAID 5 移除，md1 当前处于降级状态，建议更换硬盘 2。',
      engineerConclusion: expect.stringContaining('记录到不可恢复介质错误证据 6 条')
    }));
    expect(result.diagnoses[0].userConclusion).not.toContain('重新拔插');
    expect(result.diagnoses[0].userConclusion).not.toContain('备份');
    expect(result.deviceAssessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: '/dev/sda', label: 'Hard Drive 2', slot: 'ata2', mediaErrorCount: 6 })
    ]));
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.media_error:/dev/sda', summary: '/dev/sda 检测到不可恢复介质错误，共 6 条日志证据。' })
    ]));
    expect(result.diagnoses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ primaryResource: '/dev/sdc' })
    ]));
  });

  it('真实 EC752 单盘介质故障不会把其余空槽位误判为掉盘', async () => {
    const fixture = new URL('./fixtures/disk1-media-failure-empty-slots/', import.meta.url);
    const sources = [['journal-5days.log', 'journal-5days.txt'], ['mdstat.log', 'mdstat.txt'], ['ugvolume.log', 'ugvolume.txt'], ['sysinfo.json', 'sysinfo.json']] as const;
    const files = Object.fromEntries(await Promise.all(sources.map(async ([sourceName, fixtureName]) => [sourceName, await readFile(new URL(fixtureName, fixture), 'utf8')])));
    const result = analyzeV1Sources({ sourceName: 'diag_EC752JJ35250CAD4_2608282019.tgz', files });

    expect(result.diagnoses[0]).toEqual(expect.objectContaining({
      id: 'storage.device.media_failure',
      title: '硬盘 1 存在介质故障',
      primaryResource: '/dev/sda',
      userConclusion: expect.stringContaining('建议更换硬盘 1')
    }));
    expect(result.diagnoses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.device.unrecognized' })
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'storage.device_unrecognized' })
    ]));
  });

  it('真实 H430 将设备掉线、写入错误与 BTRFS 强制只读关联到硬盘 1 和存储池 1', async () => {
    const fixture = new URL('./fixtures/disk1-link-failure-btrfs-readonly/', import.meta.url);
    const sources = [['kern.log', 'kern.txt'], ['mdstat.log', 'mdstat.txt'], ['ugvolume.log', 'ugvolume.txt'], ['sysinfo.json', 'sysinfo.json']] as const;
    const files = Object.fromEntries(await Promise.all(sources.map(async ([sourceName, fixtureName]) => [sourceName, await readFile(new URL(fixtureName, fixture), 'utf8')])));
    const result = analyzeV1Sources({ sourceName: 'diag_H43001J6100097FA_2608281705.tgz', files });

    expect(result.diagnoses[0]).toEqual(expect.objectContaining({
      id: 'storage.device.suspected_failure',
      title: '硬盘 1 健康异常并发生链路掉线',
      summary: '硬盘 1 健康信息异常并发生链路掉线，导致存储池 1 写入失败并被强制切换为只读。',
      primaryResource: '/dev/sda',
      affectedResources: expect.arrayContaining(['/dev/sda', 'md1', 'pool1', '/volume1']),
      userConclusion: '您好，经分析诊断日志，硬盘 1 健康信息异常并发生链路掉线，导致存储池 1 写入失败并被强制切换为只读。请关机后重新拔插硬盘 1；如换槽后仍出现相同错误，说明硬盘自身故障，建议更换硬盘 1。'
    }));
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.device_unavailable:/dev/sda' }),
      expect.objectContaining({ id: 'filesystem.read_only:pool1' })
    ]));
    expect(result.diagnoses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.device.unrecognized' }),
      expect.objectContaining({ id: 'raid.array.degraded' })
    ]));
    expect(result.diagnoses[0].userConclusion).not.toContain('备份');
  });

  it('不把网卡 Link Down 和 smartd 数据库缺项误判为硬盘掉盘', () => {
    const result = analyzeV1Sources({
      sourceName: 'non-storage-link-events.tgz',
      files: {
        'journal-5days.log': [
          'Aug 28 17:38:00 host kernel: igc 0000:02:00.0 eth1: NIC Link is Down',
          'Aug 28 17:38:01 host smartd[100]: Device: /dev/sda [SAT], not found in smartd database'
        ].join('\n')
      }
    });

    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'storage.device_unrecognized' })
    ]));
    expect(result.diagnoses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.device.unrecognized' })
    ]));
  });

  it('SATA 槽位数与块设备数相等时不生成数量不一致 Finding', () => {
    const result = analyzeV1Sources({
      sourceName: 'matching-device-count.tgz',
      files: { 'ugvolume.log': 'got 4 sataOnCount and 4 sdCount' }
    });

    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'storage.device_count_mismatch' })
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

  it('将存储卡死关键日志转换为独立 Finding，但不直接生成根因诊断', () => {
    const result = analyzeV1Sources({
      sourceName: 'storage-stall-events.tgz',
      files: {
        'journal-5days.log': [
          '2026-08-30T18:39:57+08:00 host kernel: nvme nvme0: I/O tag 732 (02dc) opcode 0x0 (I/O Cmd) QID 1 timeout, aborting req_op:FLUSH(2) size:0',
          '2026-08-30T18:40:01+08:00 host kernel: INFO: task md2_raid1:2684 blocked for more than 120 seconds.',
          '2026-08-30T18:40:02+08:00 host kernel: INFO: task jbd2/bcache0-8:2921 blocked for more than 120 seconds.',
          '2026-08-30T18:40:03+08:00 host kernel: Workqueue: bcache bch_data_insert_keys [bcache]',
          '2026-08-30T18:40:30+08:00 host systemd-shutdown[1]: Syncing filesystems and block devices - timed out, issuing SIGKILL...'
        ].join('\n')
      }
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storage.nvme_timeout:nvme0', severity: 'warning', affectedResources: ['nvme0'] }),
      expect.objectContaining({ id: 'storage.io_hung:md2', severity: 'warning', affectedResources: ['md2'] }),
      expect.objectContaining({ id: 'storage.io_hung:bcache0', severity: 'warning', affectedResources: ['bcache0'] }),
      expect.objectContaining({ id: 'storage.bcache_stall:system', severity: 'warning', affectedResources: [] }),
      expect.objectContaining({ id: 'system.shutdown_sync_timeout:system', severity: 'warning', affectedResources: [] })
    ]));
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'storage.nvme_timeout', resource: 'nvme0' }),
      expect.objectContaining({ eventType: 'storage.io_hung', resource: 'md2' }),
      expect.objectContaining({ eventType: 'storage.io_hung', resource: 'bcache0' }),
      expect.objectContaining({ eventType: 'storage.bcache_stall', resource: undefined }),
      expect.objectContaining({ eventType: 'system.shutdown_sync_timeout', resource: undefined })
    ]));
    expect(result.diagnoses).toEqual([]);
  });

  it('不把相似但低信号的关机和工作队列日志识别为存储卡死事件', () => {
    const result = analyzeV1Sources({
      sourceName: 'storage-stall-noise.tgz',
      files: {
        'journal-5days.log': [
          '2026-08-30T18:40:00+08:00 host kernel: nvme nvme0: 8/0/0 default/read/poll queues',
          '2026-08-30T18:40:01+08:00 host kernel: Workqueue: events bch_data_insert_keys [bcache]',
          '2026-08-30T18:40:02+08:00 host systemd[1]: volume.mount: Mount process exited, target is busy',
          '2026-08-30T18:40:03+08:00 host systemd-shutdown[1]: Processes still around after final SIGKILL. Entering emergency mode.'
        ].join('\n')
      }
    });

    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'storage.nvme_timeout' }),
      expect.objectContaining({ type: 'storage.io_hung' }),
      expect.objectContaining({ type: 'storage.bcache_stall' }),
      expect.objectContaining({ type: 'system.shutdown_sync_timeout' })
    ]));
  });
});
