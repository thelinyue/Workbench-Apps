import { describe, expect, it } from 'vitest';
import { presentFinding } from '../shared/finding-presentation';

describe('重要发现展示文案', () => {
  it.each([
    ['storage.timeout', '存储设备访问超时'],
    ['storage.media_error', '磁盘介质读写错误'],
    ['storage.device_unrecognized', '硬盘未被系统识别'],
    ['storage.nvme_error', 'NVMe 固态硬盘异常'],
    ['storage.ata_error', 'SATA/ATA 通信异常'],
    ['filesystem.error', '文件系统错误']
  ])('将 %s 转换为中文问题名称', (type, title) => {
    const presentation = presentFinding({ type, severity: 'warning', occurrenceCount: 3, affectedResources: ['/dev/sda'] });

    expect(presentation.title).toBe(title);
    expect(presentation.meaning).not.toContain(type);
    expect(presentation.advice).toBeTruthy();
    expect(presentation.technicalEvent).toBe(type);
    expect(presentation.riskLabel).toBe('警告');
    expect(presentation.affectedResources).toEqual(['/dev/sda']);
  });

  it('为未知事件保留技术键并提供保守的中文提示', () => {
    const presentation = presentFinding({ type: 'storage.future_event', severity: 'info', occurrenceCount: 1 });

    expect(presentation.title).toBe('未分类异常');
    expect(presentation.meaning).toContain('未归类');
    expect(presentation.advice).toContain('工程师');
    expect(presentation.technicalEvent).toBe('storage.future_event');
    expect(presentation.riskLabel).toBe('提示');
  });
});
