import defaultRules from './rules.json';
import type { AnalyzerRuleCatalog } from './log-analyzer';

/**
 * 内置规则直接继承系统诊断插件 v2.1.0 的 config.json 语义。
 * 工作台不再暴露规则插件入口，但保留原文件名、正则和上下文配置，便于后续逐步迁移
 * 更复杂的结构化存储诊断能力。
 */
export const builtInAnalyzerRules = defaultRules as AnalyzerRuleCatalog;
