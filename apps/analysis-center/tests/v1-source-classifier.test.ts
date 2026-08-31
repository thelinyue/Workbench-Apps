import { describe, expect, it } from 'vitest';
import { classifyV1Source } from '../backend/lib/analysis-v1/source-classifier';

describe('V1 日志来源识别', () => {
  it.each([
    ['sysinfo.json', 'sysinfo'],
    ['nested/mdstat.log', 'mdstat'],
    ['nested/ugvolume.log', 'ugvolume'],
    ['journal-5days.log', 'kernel'],
    ['dmesg.log', 'kernel'],
    ['EC661JJ302308B59_20260830192714_syslog', 'kernel']
  ] as const)('将 %s 归一化为 %s', (file, sourceType) => {
    expect(classifyV1Source(file)).toBe(sourceType);
  });

  it.each([
    'ai_engine_v2_20260829_181655_crash.xlog.gz',
    'application.log.gz',
    'kern.log.2.gz',
    'syslog.4.gz',
    'EC661JJ302308B59_20260830193155_dmsg.log.gz',
    'sysinfo.json.bak',
    'device_syslog.old'
  ])('忽略未知或结构化文件 %s，不回退到通用全文扫描', (file) => {
    expect(classifyV1Source(file)).toBeUndefined();
  });
});
