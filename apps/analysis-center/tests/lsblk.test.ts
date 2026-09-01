import { describe, expect, it } from 'vitest';
import { parseLsblk, selectStorageBlockDevices, type LsblkDeviceRow } from '../backend/lib/parsers/lsblk';

const sampleLsblk = `NAME                                     MAJ:MIN RM   SIZE RO TYPE  MOUNTPOINTS
loop0                                      7:0    0 647.3M  1 loop  /rootfs/base
sda                                        8:0    0   3.6T  0 disk
├─sda1                                     8:1    0  15.3G  0 part
└─sda2                                     8:2    0   3.6T  0 part
  └─md1                                    9:1    0   3.6T  0 raid1
    └─pool-volume                          253:0  0   3.6T  0 lvm   /home
                                                                    /volume1
mmcblk0                                  179:0    0  29.2G  0 disk
├─mmcblk0p1                              179:1    0   128M  0 part
zram0                                    254:0    0   962M  0 disk  [SWAP]
`;

describe('lsblk 结构化解析', () => {
  it('按表头列解析树形设备并合并续行挂载点', () => {
    expect(parseLsblk(sampleLsblk)).toEqual([
      row('loop0', 0, '7:0', '0', '647.3M', '1', 'loop', ['/rootfs/base']),
      row('sda', 0, '8:0', '0', '3.6T', '0', 'disk', []),
      row('sda1', 1, '8:1', '0', '15.3G', '0', 'part', []),
      row('sda2', 1, '8:2', '0', '3.6T', '0', 'part', []),
      row('md1', 2, '9:1', '0', '3.6T', '0', 'raid1', []),
      row('pool-volume', 3, '253:0', '0', '3.6T', '0', 'lvm', ['/home', '/volume1']),
      row('mmcblk0', 0, '179:0', '0', '29.2G', '0', 'disk', []),
      row('mmcblk0p1', 1, '179:1', '0', '128M', '0', 'part', []),
      row('zram0', 0, '254:0', '0', '962M', '0', 'disk', ['[SWAP]'])
    ]);
  });

  it('只保留 sysinfo 硬盘名单对应的根设备及全部后代', () => {
    const rows = parseLsblk(sampleLsblk);
    expect(selectStorageBlockDevices(rows, ['/dev/sda'])).toEqual(rows.slice(1, 6));
  });

  it('缺失或无法识别表头时返回空结构，不抛出异常', () => {
    expect(parseLsblk('not an lsblk report')).toEqual([]);
    expect(parseLsblk('')).toEqual([]);
  });
});

function row(name: string, depth: number, majorMinor: string, removable: string, size: string, readOnly: string, type: string, mountpoints: string[]): LsblkDeviceRow {
  return { name, depth, majorMinor, removable, size, readOnly, type, mountpoints };
}
