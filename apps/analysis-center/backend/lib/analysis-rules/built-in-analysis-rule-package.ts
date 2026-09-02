import eventRulePack from '../analysis-v1/event-rule-pack.json';
import ruleDefinitions from './rule-definitions.json';
import { builtInAnalyzerRules } from '../analysis/built-in-rules';
import type { AnalysisRulePackage } from '../services/analysis-rules-service';

/**
 * 首次安装时随应用交付的可信规则快照。
 *
 * 在线包不可用时始终回退到该快照；后续规则发布只替换 dataDirectory/rules 下经验证的副本，
 * 不会修改应用安装目录或依赖 Workbench 主进程。
 */
export const builtInAnalysisRulePackage: AnalysisRulePackage = {
  schemaVersion: 1,
  ruleSetId: 'analysis-center-runtime-rules',
  version: '1.0.0',
  minimumRuntimeVersion: '1.0.0',
  formatRules: {
    tgz: { files: structuredClone(builtInAnalyzerRules.tgz.files) },
    zip: { files: structuredClone(builtInAnalyzerRules.zip.files) }
  },
  v1: {
    // 构建时 JSON 导入会把来源字面量宽化为 string；原始包已由 V1 schema 校验，此处收窄为统一包类型。
    eventRules: structuredClone(eventRulePack.eventRules) as AnalysisRulePackage['v1']['eventRules'],
    findingRules: structuredClone(ruleDefinitions.findingRules) as AnalysisRulePackage['v1']['findingRules'],
    diagnosisRules: structuredClone(ruleDefinitions.diagnosisRules) as AnalysisRulePackage['v1']['diagnosisRules'],
    recommendations: structuredClone(ruleDefinitions.recommendations) as AnalysisRulePackage['v1']['recommendations']
  }
};
