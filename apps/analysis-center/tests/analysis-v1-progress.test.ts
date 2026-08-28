import { describe, expect, it } from 'vitest';
import { analyzeV1Sources } from '../backend/lib/analysis-v1/pipeline';

describe('V1 分析进度', () => {
  it('解析大日志时持续报告单调递增的文件与进度信息', () => {
    const updates: Array<{ processedFiles: number; totalFiles: number; progress: number }> = [];
    const result = analyzeV1Sources({
      sourceName: 'large-log.tgz',
      files: {
        'kern.log': Array.from({ length: 12_000 }, () => 'kernel: blk_update_request: I/O error, dev sdc, sector 1').join('\n'),
        'mdstat.log': 'md0 : active raid1 sdc2[1](F) sdb2[0]\n      100 blocks [2/1] [U_]'
      },
      onProgress: (update) => updates.push(update)
    });

    expect(result.metadata.processedLines).toBe(12_002);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ processedFiles: 1, totalFiles: 2 }),
      expect.objectContaining({ processedFiles: 2, totalFiles: 2, progress: 100 })
    ]));
    expect(updates.every((update, index) => index === 0 || update.progress >= updates[index - 1].progress)).toBe(true);
  });
});
