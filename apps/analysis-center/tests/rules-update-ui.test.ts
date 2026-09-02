import { describe, expect, it } from 'vitest';
import { getRuleUpdateMessage, getRuleUpdatePresentation } from '../renderer/rules-update-presentation';

describe('分析中心 V1 规则隔离', () => {
  it('将独立规则状态呈现为用户可读版本与来源', () => {
    expect(getRuleUpdatePresentation({ currentVersion: '1.0.0', source: 'bundled' })).toBe('规则 1.0.0 · 内置');
    expect(getRuleUpdatePresentation({ currentVersion: '1.0.1', source: 'downloaded' })).toBe('规则 1.0.1 · 已更新');
  });

  it('将手动更新结果转换为可读提示', () => {
    expect(getRuleUpdateMessage({ status: 'updated', previousVersion: '1.0.0', currentVersion: '1.0.1' })).toBe('分析规则已更新至 1.0.1，将在下一次分析时生效。');
    expect(getRuleUpdateMessage({ status: 'up-to-date', previousVersion: '1.0.1', currentVersion: '1.0.1' })).toBe('当前已是最新分析规则。');
  });

  it('只呈现 AnalysisResult 的诊断、Finding、建议与 Evidence', () => {
    expect(getRuleUpdateMessage({ status: 'updated', previousVersion: '1.0.0', currentVersion: '1.0.1' })).toContain('下一次分析');
  });
});
