import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');

describe('分析中心 V1 规则隔离', () => {
  it('不调用旧规则读取、更新或远程规则通道', () => {
    expect(source).not.toContain("rules.getActive");
    expect(source).not.toContain("rules.getUpdateState");
    expect(source).not.toContain("rules.updateOfficial");
  });

  it('只呈现 AnalysisResult 的诊断、Finding、建议与 Evidence', () => {
    expect(source).toContain('result.diagnoses');
    expect(source).toContain('result.findings');
    expect(source).toContain('result.recommendations');
    expect(source).toContain('result.evidence');
  });

  it('优先呈现可发送给用户的结论、异常硬盘身份和旧结果降级提示', () => {
    expect(source).toContain('给用户的结论');
    expect(source).toContain('给工程师的结论');
    expect(source).toContain('deviceAssessments');
    expect(source).toContain('请重新分析诊断包以查看硬盘身份和双结论');
  });
});
