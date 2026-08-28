import { describe, expect, it } from 'vitest';
import { buildResultPresentation } from '../shared/result-presentation';

describe('结果页展示层', () => {
  it('只将主要诊断直接关联的硬盘、RAID 和存储池放入影响范围', () => {
    const presentation = buildResultPresentation({
      status: 'completed',
      diagnoses: [{ id: 'disk', title: '/dev/sda 高度疑似存在磁盘故障', summary: '持续 I/O 异常。', severity: 'critical', confidence: 'high', affectedResources: ['/dev/sda', 'md1', 'pool1'], affectedDeviceResources: ['/dev/sda'], findingIds: ['io'], recommendationIds: [], userConclusion: '硬盘 2 存在明显异常。' }],
      findings: [{ id: 'io', type: 'storage.io_error', title: '持续 I/O Error', summary: '31 次。', severity: 'critical', confidence: 'high', affectedResources: ['/dev/sda'], evidenceIds: [], occurrenceCount: 31 }, { id: 'fs', type: 'filesystem.error', title: '文件系统错误', summary: '需要关注。', severity: 'warning', confidence: 'medium', affectedResources: ['/volume1'], evidenceIds: [], occurrenceCount: 1 }],
      deviceAssessments: [{ resource: '/dev/sda', label: 'Hard Drive 2', serial: 'SERIAL-002', usedFor: 'Storage Pool 1', smartRiskAttributes: [], ioErrorCount: 31 }, { resource: '/dev/sdb', label: 'Hard Drive 3', serial: 'SERIAL-003', smartRiskAttributes: [], ioErrorCount: 0 }],
      recommendations: [],
      metadata: { missingData: [] }
    });

    expect(presentation.customerReply).toBe('硬盘 2 存在明显异常。');
    expect(presentation.impact.devices).toEqual([expect.objectContaining({ label: '硬盘 2', resource: '/dev/sda', serial: 'SERIAL-002', usedFor: '存储池 1' })]);
    expect(presentation.impact.raids).toEqual([{ label: 'md1', resource: 'md1' }]);
    expect(presentation.impact.storage).toEqual([{ label: '存储池 1', resource: 'pool1' }]);
    expect(presentation.importantFindings).toEqual([expect.objectContaining({
      id: 'fs',
      display: expect.objectContaining({ title: '文件系统错误', technicalEvent: 'filesystem.error', advice: expect.any(String) })
    })]);
  });

  it('对没有主要诊断的结果生成不扩大事实的用户回复', () => {
    const presentation = buildResultPresentation({ status: 'completed', diagnoses: [], findings: [], deviceAssessments: [], recommendations: [], metadata: { missingData: [] } });

    expect(presentation.customerReply).toContain('暂未发现明确的系统或存储异常');
    expect(presentation.summary.title).toBe('未发现明确异常');
  });

  it('历史结果缺少硬盘评估时仍展示其他重要发现', () => {
    const presentation = buildResultPresentation({
      status: 'completed', diagnoses: [],
      findings: [{ id: 'timeout', type: 'storage.timeout', title: 'storage.timeout', summary: '3 次。', severity: 'warning', confidence: 'medium', affectedResources: ['/dev/sda'], evidenceIds: [], occurrenceCount: 3 }],
      recommendations: [], metadata: { missingData: [] }
    });

    expect(presentation.impact.devices).toEqual([]);
    expect(presentation.importantFindings).toEqual([expect.objectContaining({
      display: expect.objectContaining({ title: '存储设备访问超时', affectedResources: ['/dev/sda'] })
    })]);
  });
});
