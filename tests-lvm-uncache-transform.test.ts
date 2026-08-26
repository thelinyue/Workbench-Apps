import { describe, expect, it } from 'vitest';
import { transformVgText, LvmUncacheError } from './apps/lvm-uncache-tool/core/transform.js';

const cachedVolumeGroup = `contents = "Text Format Volume Group"
version = 1

test_vg {
    extent_size = 8192
    physical_volumes {
        pv0 {
            device = "/dev/test0"
            tags = []
        }
        pv1 {
            device = "/dev/test1"
            tags = ["lvmcache"]
        }
    }
    logical_volumes {
        data {
            segment_count = 1
            segment1 {
                type = "cache+CACHE_USES_CACHEVOL"
                cache_pool = "cachepool"
                origin = "origin"
            }
        }
        cachepool {
            flags = ["CACHE_VOL"]
            segment_count = 1
            segment1 {
                type = "striped"
                stripes = ["pv1", 0]
            }
        }
        origin {
            segment_count = 1
            segment1 {
                type = "striped"
                stripes = ["pv0", 0]
            }
        }
    }
}`;

describe('LVM 缓存转换', () => {
  it('用 volume1_corig 的 segment1 替换 volume1 的缓存 segment', () => {
    const result = transformVgText(cachedVolumeGroup, 'sample.vg');

    expect(result.summary.hasCache).toBe(true);
    expect(result.processedText).toContain('type = "striped"');
    expect(result.processedText).not.toContain('cache_pool');
    expect(result.processedText).not.toContain('volume1_lvmcache_cvol');
    expect(result.processedText).not.toContain('volume1_corig');
  });

  it('拒绝缺少必需块的输入并返回中文错误', () => {
    expect(() => transformVgText('volume1 { segment1 { type = "cache" } }')).toThrow(LvmUncacheError);
  });

  it('拒绝移除缓存后没有物理卷的输入', () => {
    const withoutPhysicalVolume = cachedVolumeGroup.replace(/tags = \[\]/, 'tags = ["lvmcache"]');

    expect(() => transformVgText(withoutPhysicalVolume)).toThrow(LvmUncacheError);
  });

  it('无缓存输入保持原文并生成安全的输出文件名', () => {
    const noCache = cachedVolumeGroup.replace(/cache\+CACHE_USES_CACHEVOL/g, 'striped').replace(/cache_pool = "cachepool"\n\s*origin = "origin"\n/, 'stripes = ["pv0", 0]\n').replace(/tags = \["lvmcache"\]/, 'tags = []').replace(/flags = \["CACHE_VOL"\]\n/, '');
    const result = transformVgText(noCache, '设备备份.vg');

    expect(result.summary.hasCache).toBe(false);
    expect(result.processedText).toBe(noCache);
    expect(result.suggestedFilename).toBe('设备备份_nocache.vg');
  });

  it('拒绝缓存 segment 缺少 origin 或声明多个 segment', () => {
    expect(() => transformVgText(cachedVolumeGroup.replace(/origin = "origin"\n/, ''))).toThrow(LvmUncacheError);
    expect(() => transformVgText(cachedVolumeGroup.replace('segment_count = 1', 'segment_count = 2'))).toThrow(LvmUncacheError);
  });
});
