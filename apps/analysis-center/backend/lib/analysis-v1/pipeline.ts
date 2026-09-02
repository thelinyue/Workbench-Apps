import { z } from 'zod';
import rulePackJson from './event-rule-pack.json';
import type { PipelineProfiler } from './pipeline-profiler';
import { classifyV1Source, type V1InputSourceType } from './source-classifier';
import type { AnalysisDiagnosisRule, AnalysisFindingRule, AnalysisRecommendationRule } from '../services/analysis-rules-service';

export type Severity = 'critical' | 'warning' | 'info';
export type Confidence = 'confirmed' | 'high' | 'medium' | 'low';
export type TimestampPrecision = 'exact' | 'derived' | 'relative' | 'unknown';

export interface Evidence { id: string; timestamp?: string; timestampPrecision: TimestampPrecision; timestampConfidence: Confidence; sourceFile: string; lineNumber?: number; eventType: string; resource?: string; rawMessage: string; contextBefore?: string[]; contextAfter?: string[]; }
export interface NormalizedEvent { id: string; ruleId: string; type: string; resource?: string; timestamp?: string; timestampPrecision: TimestampPrecision; timestampConfidence: Confidence; evidenceId: string; attributes: Record<string, string | number>; }
export interface Finding {
  id: string;
  type: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  summary: string;
  /** 格式规则实际使用的关键词或正则，报告必须直接读取该字段，不能从 Finding ID 反推。 */
  matchedKeyword?: string;
  affectedResources: string[];
  evidenceIds: string[];
  firstSeen?: string;
  lastSeen?: string;
  occurrenceCount: number;
}
export interface Recommendation { id: string; priority: number; type: 'inspection' | 'verification' | 'repair'; title: string; reason: string; risk: 'safe' | 'confirmation-required' | 'high-risk'; }
export interface SmartRiskAttribute { id: number; name: string; raw: number; }
export interface DeviceAssessment { resource: string; label?: string; model?: string; serial?: string; slot?: string; usedFor?: string; smartRiskAttributes: SmartRiskAttribute[]; ioErrorCount: number; mediaErrorCount?: number; }
export interface Diagnosis { id: string; category: string; severity: Severity; confidence: Confidence; title: string; summary: string; primaryResource?: string; affectedResources: string[]; affectedDeviceResources?: string[]; findingIds: string[]; recommendationIds: string[]; userConclusion?: string; engineerConclusion?: string; correlationWindowMs?: number; }
export interface AnalysisResult { schemaVersion: 1; id: string; status: 'completed' | 'partial'; summary: { criticalCount: number; warningCount: number; infoCount: number; primaryDiagnosisId?: string; complete: boolean }; diagnoses: Diagnosis[]; findings: Finding[]; evidence: Evidence[]; deviceAssessments: DeviceAssessment[]; recommendations: Recommendation[]; metadata: { source: string; startTime: string; completeTime: string; duration: number; processedFiles: number; processedLines: number; processedEvents: number; analyzerVersion: string; rulePackVersion: string; missingData: string[] }; }

interface DeviceIdentity { resource: string; label?: string; model?: string; serial?: string; slot?: string; usedFor?: string; }
interface RaidAssessment { resource: string; level?: string; expectedMembers?: number; activeMembers?: number; missingMemberIndexes?: number[]; degraded: boolean; }
interface RecommendationRequest { kind: 'smart' | 'raid' | 'ups'; resource: string; }

const rulePackSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), eventRules: z.array(z.object({ id: z.string(), sources: z.array(z.enum(['kernel', 'sysinfo', 'mdstat', 'ugvolume', 'ups'])), regex: z.string(), type: z.string() })) });
const rulePack = rulePackSchema.parse(rulePackJson);
type CompiledEventRule = (typeof rulePack.eventRules)[number] & { pattern: RegExp };
type EventRule = (typeof rulePack.eventRules)[number];
// 内核来源的大多数行是无异常心跳；该集合覆盖当前所有 kernel 规则的触发词，预筛选命中后仍由原规则决定诊断结果。
const kernelEventCandidate = /\b(?:error|timeout|timed out|reset controller|device not ready|hard resetting|failed|failure|link(?: is)? down|not recognized|not found|medium|uncorrectable|panic|out of memory|oom-kill|killed process|watchdog|uncleanly|orphan inode|recovery complete|corrupt\w*|read-?only|blocked for more than|bch_data_insert_keys)\b/i;

export interface V1Progress { processedFiles: number; totalFiles: number; progress: number; }

/** V1 只分析白名单来源，所有后续规则只消费这里生成的结构化事件。 */
export function analyzeV1Sources(input: { sourceName: string; files: Record<string, string>; eventRules?: EventRule[]; findingRules?: AnalysisFindingRule[]; diagnosisRules?: AnalysisDiagnosisRule[]; recommendations?: AnalysisRecommendationRule[]; rulePackVersion?: string; profiler?: PipelineProfiler; onProgress?: (progress: V1Progress) => void }): AnalysisResult {
  const started = new Date();
  const profiler = input.profiler;
  const evidence: Evidence[] = [];
  const events: NormalizedEvent[] = [];
  const topology = new Map<string, string[]>();
  const deviceArrays = new Map<string, string[]>();
  const raidAssessments = new Map<string, RaidAssessment>();
  const deviceIdentities = new Map<string, DeviceIdentity>();
  let processedLines = 0;
  let evidenceNumber = 0;
  let candidateLines = 0;
  let ruleInvocations = 0;
  let ruleMatches = 0;
  const rulesBySource = compileRulesBySource(input.eventRules ?? rulePack.eventRules);
  const sources = Object.entries(input.files).filter(([sourceFile]) => classifyV1Source(sourceFile));
  let lastProgress = -1;
  const reportProgress = (processedFiles: number, processedCharacters = 0, currentLength = 0, force = false) => {
    const progress = Math.min(100, Math.floor(((processedFiles + (currentLength ? processedCharacters / currentLength : 0)) / Math.max(sources.length, 1)) * 100));
    if (force || progress > lastProgress) { lastProgress = progress; input.onProgress?.({ processedFiles, totalFiles: sources.length, progress }); }
  };
  const add = (ruleId: string, type: string, sourceFile: string, line: string, lineNumber: number | undefined, resource?: string, attributes: Record<string, string | number> = {}) => {
    const time = parseTimestamp(line);
    const id = `evidence-${++evidenceNumber}`;
    evidence.push({ id, timestamp: time.timestamp, timestampPrecision: time.precision, timestampConfidence: time.confidence, sourceFile, lineNumber, eventType: type, resource, rawMessage: line.slice(0, 4000) });
    events.push({ id: `event-${evidenceNumber}`, ruleId, type, resource, timestamp: time.timestamp, timestampPrecision: time.precision, timestampConfidence: time.confidence, evidenceId: id, attributes });
  };

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const [sourceFile, content] = sources[sourceIndex];
    const source = classifyV1Source(sourceFile);
    if (!source) continue;
    if (profiler && !profiler.hasFile(sourceFile)) {
      const decodedBytes = Buffer.byteLength(content);
      profiler.recordFile(sourceFile, source, { bytesRead: decodedBytes, decodedBytes });
    }
    const fileStartedAt = profiler?.mark();
    const initialEventCount = events.length;
    const initialEvidenceCount = evidence.length;
    let fileLineCount = 0;
    let fileRuleDurationMs = 0;
    if (source === 'sysinfo') {
      profiler?.increment('structuredFilesParsed');
      parseSysinfo(content, sourceFile, add, deviceIdentities);
    }
    else {
      const mdstatContext: { currentArray?: string } = {};
      const kernelContext: { recentAtaSlot?: string; recentAtaLine?: number; recentFilesystemResource?: string; recentFilesystemLine?: number } = {};
      let lineNumber = 0;
      forEachLine(content, (line, endOffset) => {
        lineNumber += 1;
        fileLineCount += 1;
        processedLines += 1;
        if (source === 'kernel') updateKernelContext(line, lineNumber, kernelContext);
        if (source === 'kernel' && !kernelEventCandidate.test(line)) {
          if (lineNumber % 1024 === 0) reportProgress(sourceIndex, endOffset, content.length);
          return;
        }
        if (profiler) candidateLines += 1;
        const rulesStartedAt = profiler?.mark();
        const emittedTypes = new Set<string>();
        for (const rule of rulesBySource[source]) {
          if (source === 'mdstat' && rule.type === 'raid.degraded') continue;
          const ruleStartedAt = profiler?.mark();
          const match = rule.pattern.exec(line);
          if (profiler && ruleStartedAt !== undefined) {
            const durationMs = profiler.elapsed(ruleStartedAt);
            ruleInvocations += 1;
            if (match) ruleMatches += 1;
            profiler.recordRule(rule.id, 1, Boolean(match), durationMs);
          }
          if (!match || emittedTypes.has(rule.type)) continue;
          const device = match.groups?.device;
          const slot = match.groups?.slot;
          const pool = match.groups?.pool;
          const controller = match.groups?.controller;
          const array = match.groups?.array;
          const cache = match.groups?.cache;
          const recentFilesystemResource = source === 'kernel' && kernelContext.recentFilesystemLine !== undefined && lineNumber - kernelContext.recentFilesystemLine <= 12
            ? kernelContext.recentFilesystemResource
            : undefined;
          // 控制器、阵列和缓存名保留日志中的逻辑身份；没有可靠拓扑证据时不映射成具体块设备。
          const resource = slot?.toLowerCase()
            ?? (device ? `/dev/${device.replace(/\d+$/, '')}` : controller?.toLowerCase() ?? array?.toLowerCase() ?? cache?.toLowerCase() ?? pool ?? (rule.type.startsWith('filesystem.') ? recentFilesystemResource : undefined) ?? (source === 'ugvolume' && rule.type === 'filesystem.error' ? poolFromMountLine(line) : undefined));
          const attributes = Object.fromEntries(Object.entries(match.groups ?? {}).filter(([name, value]) => !['device', 'slot', 'pool'].includes(name) && Boolean(value))) as Record<string, string>;
          const recentSlot = source === 'kernel' && kernelContext.recentAtaLine !== undefined && lineNumber - kernelContext.recentAtaLine <= 12
            ? kernelContext.recentAtaSlot
            : undefined;
          if (slot || (recentSlot && ['storage.media_error', 'storage.io_error', 'raid.member_failed'].includes(rule.type))) attributes.slot = (slot ?? recentSlot)!;
          add(rule.id, rule.type, sourceFile, line, lineNumber, resource, attributes);
          emittedTypes.add(rule.type);
        }
        if (profiler && rulesStartedAt !== undefined) fileRuleDurationMs += profiler.elapsed(rulesStartedAt);
        if (source === 'mdstat') parseMdstatLine(line, sourceFile, lineNumber, add, deviceArrays, raidAssessments, mdstatContext);
        if (source === 'ugvolume') parseTopology(line, topology);
        if (lineNumber % 1024 === 0) reportProgress(sourceIndex, endOffset, content.length);
      });
    }
    if (profiler && fileStartedAt !== undefined) {
      const fileDurationMs = profiler.elapsed(fileStartedAt);
      const parserDurationMs = Math.max(0, fileDurationMs - fileRuleDurationMs);
      profiler.recordElapsed('parser.total', parserDurationMs);
      if (source !== 'sysinfo') profiler.recordElapsed('rules.event.total', fileRuleDurationMs);
      profiler.addFileMetrics(sourceFile, {
        linesProcessed: fileLineCount,
        parserDurationMs,
        ruleDurationMs: fileRuleDurationMs,
        eventsCreated: events.length - initialEventCount,
        evidenceRetained: evidence.length - initialEvidenceCount
      });
    }
    reportProgress(sourceIndex + 1, 0, 0, true);
  }
  canonicalizeDeviceEvents(events, evidence, deviceIdentities);
  for (const event of events.filter((item) => item.type === 'raid.member_failed')) {
    const array = typeof event.attributes.array === 'string' ? event.attributes.array : undefined;
    if (!array || !event.resource?.startsWith('/dev/')) continue;
    deviceArrays.set(event.resource, [...new Set([...(deviceArrays.get(event.resource) ?? []), array])]);
  }
  for (const event of events.filter((item) => item.type === 'raid.degraded')) {
    const linked = topology.get(event.resource ?? '') ?? [];
    for (const resource of linked) event.attributes.affected = resource;
  }
  const aggregatedFindings = profiler
    ? profiler.measure('finding.aggregate', () => aggregateFindings(events, evidence, topology))
    : aggregateFindings(events, evidence, topology);
  const findings = applyFindingRules(aggregatedFindings, input.findingRules ?? []);
  const deviceAssessments = buildDeviceAssessments(deviceIdentities, events);
  // 远程包声明的诊断由受限 DSL 唯一负责，避免同一证据同时产出旧内置结论和在线结论。
  const externallyDefinedDiagnosisIds = new Set((input.diagnosisRules ?? []).map((rule) => rule.id));
  const diagnosisComposition = profiler
    ? profiler.measure('diagnosis.compose', () => composeDiagnoses(findings, events, topology, deviceArrays, deviceAssessments, raidAssessments, externallyDefinedDiagnosisIds))
    : composeDiagnoses(findings, events, topology, deviceArrays, deviceAssessments, raidAssessments, externallyDefinedDiagnosisIds);
  const ruleDiagnoses = composeRuleDiagnoses(events, findings, input.diagnosisRules ?? []);
  const diagnoses = [...ruleDiagnoses, ...diagnosisComposition.diagnoses];
  const baseRecommendations = profiler
    ? profiler.measure('recommendation.compose', () => composeRecommendations(diagnosisComposition.recommendationRequests))
    : composeRecommendations(diagnosisComposition.recommendationRequests);
  const usedRuleRecommendationIds = new Set(ruleDiagnoses.flatMap((diagnosis) => diagnosis.recommendationIds));
  const ruleRecommendations = (input.recommendations ?? []).filter((item) => usedRuleRecommendationIds.has(item.id));
  const recommendations = [...baseRecommendations, ...ruleRecommendations]
    .filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((left, right) => left.priority - right.priority);
  if (profiler) {
    const findingEvidenceIds = findings.flatMap((finding) => finding.evidenceIds);
    profiler.increment('linesProcessed', processedLines);
    profiler.increment('candidateLines', candidateLines);
    profiler.increment('ruleInvocations', ruleInvocations);
    profiler.increment('ruleMatches', ruleMatches);
    profiler.increment('eventsCreated', events.length);
    profiler.increment('findingsCreated', findings.length);
    profiler.increment('evidenceRetained', evidence.length);
    profiler.increment('diagnosesCreated', diagnoses.length);
    profiler.increment('recommendationsCreated', recommendations.length);
    profiler.increment('duplicateEvents', duplicateEventCount(events, evidence));
    profiler.increment('duplicateEvidence', duplicateEvidenceCount(evidence));
    profiler.increment('findingEvidenceReferences', findingEvidenceIds.length);
    profiler.increment('uniqueFindingEvidenceReferences', new Set(findingEvidenceIds).size);
  }
  const missingData = ['sysinfo', 'mdstat'].filter((source) => !sources.some(([file]) => classifyV1Source(file) === source));
  const ended = new Date();
  const criticalCount = diagnoses.filter((item) => item.severity === 'critical').length;
  const warningCount = diagnoses.filter((item) => item.severity === 'warning').length;
  return { schemaVersion: 1, id: `analysis-${started.getTime()}`, status: missingData.length ? 'partial' : 'completed', summary: { criticalCount, warningCount, infoCount: diagnoses.filter((item) => item.severity === 'info').length, primaryDiagnosisId: diagnoses[0]?.id, complete: missingData.length === 0 }, diagnoses, findings, evidence, deviceAssessments, recommendations, metadata: { source: input.sourceName, startTime: started.toISOString(), completeTime: ended.toISOString(), duration: ended.getTime() - started.getTime(), processedFiles: sources.length, processedLines, processedEvents: events.length, analyzerVersion: '1.1.0', rulePackVersion: input.rulePackVersion ?? rulePack.version, missingData } };
}

function compileRulesBySource(eventRules: EventRule[]): Record<V1InputSourceType, CompiledEventRule[]> {
  return Object.fromEntries((['kernel', 'sysinfo', 'mdstat', 'ugvolume', 'ups'] as V1InputSourceType[]).map((source) => [source, eventRules.filter((rule) => rule.sources.includes(source)).map((rule) => ({ ...rule, pattern: new RegExp(rule.regex, 'i') }))])) as Record<V1InputSourceType, CompiledEventRule[]>;
}

function applyFindingRules(findings: Finding[], rules: AnalysisFindingRule[]): Finding[] {
  const ruleByType = new Map(rules.map((rule) => [rule.type, rule]));
  return findings.map((finding) => {
    const rule = ruleByType.get(finding.type);
    if (!rule) return finding;
    const title = renderFindingTemplate(rule.title, finding);
    return {
      ...finding,
      category: rule.category,
      severity: rule.severity,
      confidence: rule.confidence,
      title,
      summary: renderFindingTemplate(rule.summary, finding, title)
    };
  });
}

/** 在线 Finding 文案仅可引用固定字段，避免把规则包变成任意表达式执行入口。 */
function renderFindingTemplate(template: string, finding: Finding, title = finding.title): string {
  const resource = finding.affectedResources[0] ?? '';
  const values: Record<string, string> = {
    resource,
    resourcePrefix: resource ? `${resource} ` : '',
    occurrenceCount: String(finding.occurrenceCount),
    title
  };
  return template.replace(/\{\{(resource|resourcePrefix|occurrenceCount|title)\}\}/g, (_match, name: string) => values[name]!);
}

/** 受限关联只消费已规范化事件，支持存在、排除、同资源计数和顺序窗口，不执行远程代码。 */
function composeRuleDiagnoses(events: NormalizedEvent[], findings: Finding[], rules: AnalysisDiagnosisRule[]): Diagnosis[] {
  return [...rules]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .flatMap((rule) => {
      const matched = matchDiagnosisRule(events, rule);
      if (!matched) return [];
      const eventTypes = new Set([...(rule.all ?? []), ...(rule.any ?? []), ...(rule.none ?? []), ...(rule.sequence ?? [])].map((item) => item.type));
      const affectedResources = [...new Set(matched.map((event) => event.resource).filter((resource): resource is string => Boolean(resource)))];
      return [{
        id: rule.id, category: rule.category, severity: rule.severity, confidence: rule.confidence, title: rule.title, summary: rule.summary,
        affectedResources, findingIds: findings.filter((finding) => eventTypes.has(finding.type)).map((finding) => finding.id), recommendationIds: rule.recommendationIds,
        ...(rule.userConclusion ? { userConclusion: rule.userConclusion } : {}), ...(rule.engineerConclusion ? { engineerConclusion: rule.engineerConclusion } : {})
      }];
    });
}

function matchDiagnosisRule(events: NormalizedEvent[], rule: AnalysisDiagnosisRule): NormalizedEvent[] | undefined {
  const matchesCondition = (condition: { type: string; minCount?: number; sameResource?: boolean }) => {
    const matched = events.filter((event) => event.type === condition.type);
    if (matched.length < (condition.minCount ?? 1)) return undefined;
    if (!condition.sameResource) return matched;
    const resourceCounts = new Map<string, NormalizedEvent[]>();
    for (const event of matched) if (event.resource) resourceCounts.set(event.resource, [...(resourceCounts.get(event.resource) ?? []), event]);
    return [...resourceCounts.values()].find((items) => items.length >= (condition.minCount ?? 1));
  };
  const required = (rule.all ?? []).map(matchesCondition);
  if (required.some((items) => !items)) return undefined;
  const any = rule.any ?? [];
  if (any.length && !any.some((condition) => matchesCondition(condition))) return undefined;
  if ((rule.none ?? []).some((condition) => matchesCondition(condition))) return undefined;
  const sequence = matchSequence(events, rule.sequence ?? []);
  if (rule.sequence && !sequence) return undefined;
  return [...required.flatMap((items) => items ?? []), ...(sequence ?? [])];
}

function matchSequence(events: NormalizedEvent[], sequence: NonNullable<AnalysisDiagnosisRule['sequence']>): NormalizedEvent[] | undefined {
  if (!sequence.length) return [];
  const ordered = [...events].sort((left, right) => (left.timestamp ?? '').localeCompare(right.timestamp ?? '') || left.id.localeCompare(right.id));
  const memo = new Map<string, NormalizedEvent[] | undefined>();
  const findFrom = (stepIndex: number, from: number): NormalizedEvent[] | undefined => {
    if (stepIndex === sequence.length) return [];
    const cacheKey = `${stepIndex}:${from}`;
    if (memo.has(cacheKey)) return memo.get(cacheKey);
    const step = sequence[stepIndex]!;
    const previous = from > 0 ? ordered[from - 1] : undefined;
    for (let index = from; index < ordered.length; index += 1) {
      const event = ordered[index]!;
      if (event.type !== step.type) continue;
      if (previous && step.withinMs !== undefined) {
        if (!previous.timestamp || !event.timestamp || Date.parse(event.timestamp) - Date.parse(previous.timestamp) > step.withinMs) continue;
      }
      if (previous && step.noInterveningTypes?.some((type) => ordered.slice(from, index).some((candidate) => candidate.type === type))) continue;
      const tail = findFrom(stepIndex + 1, index + 1);
      if (tail) {
        const match = [event, ...tail];
        memo.set(cacheKey, match);
        return match;
      }
    }
    memo.set(cacheKey, undefined);
    return undefined;
  };
  return findFrom(0, 0);
}

function forEachLine(content: string, callback: (line: string, endOffset: number) => void): void { let start = 0; for (let index = 0; index <= content.length; index += 1) { if (index !== content.length && content.charCodeAt(index) !== 10) continue; const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index; callback(content.slice(start, end), index); start = index + 1; } }
function parseTimestamp(line: string): { timestamp?: string; precision: TimestampPrecision; confidence: Confidence } { const match = line.match(/\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)\b/); return match ? { timestamp: new Date(match[1].replace(' ', 'T')).toISOString(), precision: 'exact', confidence: 'confirmed' } : { precision: 'unknown', confidence: 'low' }; }
/**
 * ATA、SCSI 与 BTRFS 错误经常分布在连续多行中。这里只在同一文件、最多 12 行的错误块内
 * 继承最近 ATA 控制器或存储池身份，既能关联紧邻的错误链，也避免跨日志或长距离猜测资源身份。
 */
function updateKernelContext(line: string, lineNumber: number, context: { recentAtaSlot?: string; recentAtaLine?: number; recentFilesystemResource?: string; recentFilesystemLine?: number }): void {
  const match = line.match(/\b(ata\d+)(?:\.\d+)?:/i);
  if (match && /(?:failed command|\bEmask\b|\berror:|\bUNC\b)/i.test(line)) {
    context.recentAtaSlot = match[1].toLowerCase();
    context.recentAtaLine = lineNumber;
  } else if (context.recentAtaLine !== undefined && lineNumber - context.recentAtaLine > 12) {
    delete context.recentAtaSlot;
    delete context.recentAtaLine;
  }
  const pool = line.match(/\/dev\/mapper\/\S*_(pool\d+)-\S*/i)?.[1];
  if (pool) {
    context.recentFilesystemResource = pool.toLowerCase();
    context.recentFilesystemLine = lineNumber;
  } else if (context.recentFilesystemLine !== undefined && lineNumber - context.recentFilesystemLine > 12) {
    delete context.recentFilesystemResource;
    delete context.recentFilesystemLine;
  }
}

/** 使用 sysinfo 的当前盘位身份收敛历史设备名，同时在 attributes 中保留原始设备名用于工程取证。 */
function canonicalizeDeviceEvents(events: NormalizedEvent[], evidence: Evidence[], deviceIdentities: Map<string, DeviceIdentity>): void {
  const resourceBySlot = new Map([...deviceIdentities.values()].flatMap((identity) => identity.slot ? [[identity.slot.toLowerCase(), identity.resource] as const] : []));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (const event of events) {
    if (!['storage.media_error', 'storage.io_error', 'raid.member_failed'].includes(event.type)) continue;
    const slot = typeof event.attributes.slot === 'string' ? event.attributes.slot.toLowerCase() : undefined;
    const canonicalResource = slot ? resourceBySlot.get(slot) : undefined;
    if (!canonicalResource) continue;
    if (event.resource && event.resource !== canonicalResource && event.resource !== slot) event.attributes.observedResource = event.resource;
    event.resource = canonicalResource;
    const item = evidenceById.get(event.evidenceId);
    if (item) item.resource = canonicalResource;
  }
}
/**
 * sysinfo 的 SMART 报告与 disk_info 是同级字段，递归时必须显式继承 disk_info.dev_name。
 * 标准属性 05、197、198（名称分别为 Reallocated_Sector_Ct、Current_Pending_Sector、Offline_Uncorrectable）的 raw 非零均是设备已经出现介质风险的直接快照证据。
 */
function parseSysinfo(content: string, file: string, add: (ruleId: string, type: string, sourceFile: string, line: string, lineNumber: number | undefined, resource?: string, attributes?: Record<string, string | number>) => void, deviceIdentities: Map<string, DeviceIdentity>): void {
  try {
    const value = JSON.parse(content) as unknown;
    visit(value, undefined);
    function visit(current: unknown, device: string | undefined): void {
      if (Array.isArray(current)) return current.forEach((item) => visit(item, device));
      if (!current || typeof current !== 'object') return;
      const item = current as Record<string, unknown>;
      const diskInfo = item.disk_info as Record<string, unknown> | undefined;
      const smartInfo = item.smart_info as Record<string, unknown> | undefined;
      const nestedDevice = diskInfo && typeof diskInfo.dev_name === 'string' ? diskInfo.dev_name : undefined;
      const deviceName = typeof item.dev_name === 'string' ? item.dev_name : nestedDevice ?? device;
      const currentDevice = deviceName ? normalizeDeviceName(deviceName) : undefined;
      if (diskInfo && currentDevice) {
        // SMART 快照中的 label 优先作为用户可读硬盘名称，缺失时兼容 disk_info.label；只保存诊断与定位所需字段，避免复制整份 sysinfo。
        deviceIdentities.set(currentDevice, {
          resource: currentDevice,
          label: readString(smartInfo?.label) ?? readString(diskInfo.label),
          model: readString(diskInfo.model),
          serial: readString(diskInfo.serial),
          slot: readString(diskInfo.slot),
          usedFor: readString(diskInfo.used_for)
        });
      }
      const name = typeof item.name === 'string' ? item.name : undefined;
      const raw = parseSmartRaw(item.raw ?? item.raw_string ?? item.raw_value ?? item.rawValue ?? item.raw_val ?? 0);
      // NVMe 与 ATA 的数值属性 ID 不共用语义，必须通过标准 ATA 属性名确认，不能只看 id。
      const isRiskAttribute = /^(Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable)$/i.test(name ?? '');
      if (isRiskAttribute && raw > 0) {
        const attribute = name!;
        const attributeId = Number(item.id);
        add(`storage.smart.${attribute.toLowerCase()}`, 'storage.smart_risk', file, `${attribute} = ${raw}`, undefined, currentDevice, { attribute, raw, attributeId: Number.isFinite(attributeId) ? attributeId : smartAttributeId(attribute) });
      }
      Object.values(item).forEach((child) => visit(child, currentDevice));
    }
  } catch {
    /* 无效 sysinfo 作为 Partial 处理，不中断其他来源。 */
  }
}
function normalizeDeviceName(value: string): string { return value.startsWith('/dev/') ? value : `/dev/${value}`; }
function parseSmartRaw(value: unknown): number { const match = String(value).match(/^\s*(\d+)/); return match ? Number(match[1]) : 0; }
function readString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function smartAttributeId(name: string): number { return ({ Reallocated_Sector_Ct: 5, Current_Pending_Sector: 197, Offline_Uncorrectable: 198 } as Record<string, number>)[name] ?? 0; }
/** 将一次解析得到的事实汇总为设备评估，供诊断、桌面页与 HTML 共享。 */
function buildDeviceAssessments(deviceIdentities: Map<string, DeviceIdentity>, events: NormalizedEvent[]): DeviceAssessment[] {
  const resources = new Set([...deviceIdentities.keys(), ...events.map((event) => event.resource).filter((resource): resource is string => Boolean(resource?.startsWith('/dev/')))]);
  return [...resources].sort().map((resource) => {
    const identity = deviceIdentities.get(resource) ?? { resource };
    const smartRiskAttributes = events.filter((event) => event.type === 'storage.smart_risk' && event.resource === resource).map((event) => ({ id: Number(event.attributes.attributeId) || smartAttributeId(String(event.attributes.attribute)), name: String(event.attributes.attribute), raw: Number(event.attributes.raw) })).filter((attribute) => attribute.raw > 0);
    return {
      ...identity,
      smartRiskAttributes,
      ioErrorCount: events.filter((event) => event.type === 'storage.io_error' && event.resource === resource).length,
      mediaErrorCount: events.filter((event) => event.type === 'storage.media_error' && event.resource === resource).length
    };
  });
}
/** 解析 mdstat 的多行阵列块，成员计数只来自同一块中的 [期望/在线] 状态。 */
function parseMdstatLine(line: string, file: string, lineNumber: number, add: (ruleId: string, type: string, sourceFile: string, line: string, lineNumber: number | undefined, resource?: string, attributes?: Record<string, string | number>) => void, deviceArrays: Map<string, string[]>, raidAssessments: Map<string, RaidAssessment>, context: { currentArray?: string }): void {
  const header = line.match(/^\s*(md\d+)\s*:\s*\w+\s+(\S+)/i);
  if (header) {
    const resource = header[1];
    context.currentArray = resource;
    raidAssessments.set(resource, { resource, level: header[2], degraded: /\bbroken\b/i.test(line) });
    for (const member of line.matchAll(/\b(sd[a-z]+|nvme\d+n\d+)\d*\[\d+\](\(F\))?/g)) {
      const device = `/dev/${member[1]}`;
      deviceArrays.set(device, [...new Set([...(deviceArrays.get(device) ?? []), resource])]);
      if (member[2]) add('raid.member.failed', 'raid.member_failed', file, line, lineNumber, device);
    }
    if (/\bbroken\b/i.test(line)) add('raid.array.broken', 'raid.degraded', file, line, lineNumber, resource);
  }
  const status = line.match(/\[(\d+)\/(\d+)\]\s+\[([U_]+)\]/);
  if (!status || !context.currentArray) return;
  const assessment = raidAssessments.get(context.currentArray);
  if (!assessment) return;
  assessment.expectedMembers = Number(status[1]);
  assessment.activeMembers = Number(status[2]);
  assessment.missingMemberIndexes = [...status[3]].flatMap((state, index) => state === '_' ? [index] : []);
  assessment.degraded ||= assessment.activeMembers < assessment.expectedMembers || status[3].includes('_');
  if (assessment.degraded) add('raid.array.degraded', 'raid.degraded', file, line, lineNumber, assessment.resource);
}
/** ugvolume 历史版本存在两种挂载行格式，统一收敛为 md -> pool -> volume 拓扑。 */
function parseTopology(line: string, topology: Map<string, string[]>): void {
  const array = line.match(/pool\[([^\]]+)\].*\/dev\/(md\d+)/i);
  if (array) topology.set(array[2], [...new Set([...(topology.get(array[2]) ?? []), array[1]])]);
  const mount = line.match(/(?:pool\[pool(\d+)\]|pool(\d+)-[^,\s]+).*mntPath:?\s*(\/volume\d+)/i);
  if (!mount) return;
  const pool = `pool${mount[1] ?? mount[2]}`;
  topology.set(pool, [...new Set([...(topology.get(pool) ?? []), mount[3]])]);
}
function poolFromMountLine(line: string): string | undefined { const match = line.match(/pool(\d+)-/i); return match ? `pool${match[1]}` : undefined; }
function aggregateFindings(events: NormalizedEvent[], evidence: Evidence[], topology: Map<string, string[]>): Finding[] { const groups = new Map<string, NormalizedEvent[]>(); for (const event of events) { const key = `${event.type}:${event.resource ?? 'system'}`; groups.set(key, [...(groups.get(key) ?? []), event]); } return [...groups.entries()].map(([key, grouped]) => { const event = grouped[0]; const resource = event.resource; const extra = resource ? topology.get(resource) ?? [] : []; const title = titleFor(event.type, resource); const summary = event.type === 'storage.media_error' ? `${title}，共 ${grouped.length} 条日志证据。` : `${title}，共 ${grouped.length} 次。`; return { id: key, type: event.type, category: event.type.split('.')[0], severity: severityFor(event.type), confidence: event.type.startsWith('raid.') || event.type.startsWith('power.') || ['storage.media_error', 'storage.device_unavailable', 'filesystem.read_only'].includes(event.type) ? 'confirmed' : event.type === 'storage.smart_risk' ? 'high' : 'medium', title, summary, affectedResources: [...new Set([...(resource ? [resource] : []), ...extra])], evidenceIds: grouped.map((item) => item.evidenceId), firstSeen: grouped.map((item) => item.timestamp).filter(Boolean).sort()[0], lastSeen: grouped.map((item) => item.timestamp).filter(Boolean).sort().at(-1), occurrenceCount: grouped.length }; }); }
function titleFor(type: string, resource?: string): string { const names: Record<string, string> = { 'storage.io_error': '检测到块设备 I/O 错误', 'storage.device_unavailable': '检测到块设备已不可访问', 'storage.sata_link_down': '检测到 SATA 链路未连接', 'storage.media_error': '检测到不可恢复介质错误', 'storage.smart_risk': '检测到 SMART 介质风险指标', 'storage.device_count_mismatch': '检测到 SATA 槽位与块设备数量不一致', 'storage.nvme_timeout': '检测到 NVMe 请求超时并被中止', 'storage.io_hung': '检测到存储任务长时间阻塞', 'storage.bcache_stall': '检测到 bcache 写入路径阻塞线索', 'raid.member_failed': 'RAID 成员已失败', 'raid.degraded': 'RAID 阵列已降级', 'filesystem.error': '检测到文件系统错误', 'filesystem.read_only': '检测到文件系统被强制切换为只读', 'system.unclean_shutdown': '检测到异常关机线索', 'system.shutdown_sync_timeout': '检测到关机同步存储数据超时', 'system.kernel_panic': '检测到 Kernel Panic', 'system.oom': '检测到内存耗尽', 'system.oom_killer': '检测到 OOM Killer', 'system.watchdog': '检测到 Watchdog 锁死', 'power.ups_on_battery': 'UPS 已切换至电池供电', 'power.ups_standby_scheduled': 'UPS 保护待机定时已设置', 'power.ups_low_battery': 'UPS 在电池供电期间进入低电量状态', 'power.ups_already_standby': '设备已进入 UPS 保护待机', 'power.ups_online': 'UPS 已恢复在线供电', 'power.ups_service_started': 'UPS 管理服务已启动' }; return `${resource ? `${resource} ` : ''}${names[type] ?? type}`; }
function severityFor(type: string): Severity {
  if (type.startsWith('raid.') || type === 'system.kernel_panic' || type === 'system.watchdog') return 'critical';
  if (['power.ups_standby_scheduled', 'power.ups_already_standby', 'power.ups_online', 'power.ups_service_started'].includes(type)) return 'info';
  return type.startsWith('storage.') || type.startsWith('filesystem.') || type.startsWith('system.') || type.startsWith('power.') ? 'warning' : 'info';
}
function localizeDeviceLabel(label: string | undefined, resource: string): string { if (!label) return resource; const m2 = label.match(/^M\.2\s+Hard Drive\s+(\d+)$/i); if (m2) return `M.2 硬盘 ${m2[1]}`; const disk = label.match(/^Hard Drive\s+(\d+)$/i); return disk ? `硬盘 ${disk[1]}` : label; }
function localizeUsage(usage: string | undefined): string { return usage?.replace(/^Storage Pool\s+(\d+)$/i, '存储池 $1') ?? '日志未提供'; }
function dropoutAction(deviceName: string): string { return `请关机后重新拔插${deviceName}；如仍未识别，请更换其他硬盘槽位接入对比，以判断是硬盘故障还是槽位异常。`; }
/** 用户结论只转换已确认的设备、阵列事实，不让用户重复执行已经完成的诊断检查。 */
function buildUserConclusion(devices: DeviceAssessment[], deviceArrays: Map<string, string[]>, raidAssessments: Map<string, RaidAssessment>): string {
  const orderedDevices = [...devices].sort((left, right) => localizeDeviceLabel(left.label, left.resource).localeCompare(localizeDeviceLabel(right.label, right.resource), 'zh-CN', { numeric: true }));
  const deviceLines = orderedDevices.map((device) => {
    const facts = [device.ioErrorCount > 0 ? '检测到多次读写错误（I/O Error）' : '', device.smartRiskAttributes.length ? '硬盘健康信息存在异常' : ''].filter(Boolean);
    return `${localizeDeviceLabel(device.label, device.resource)}（序列号：${device.serial ?? '日志未提供'}）：${facts.join('；')}。`;
  });
  const arrays = [...new Set(orderedDevices.flatMap((device) => deviceArrays.get(device.resource) ?? []))];
  const raidLines = arrays.map((array) => {
    const affectedDevices = orderedDevices.filter((device) => (deviceArrays.get(device.resource) ?? []).includes(array));
    return raidRiskMessage(raidAssessments.get(array), array, affectedDevices);
  }).filter((value): value is string => Boolean(value));
  const conclusion = devices.length === 1 ? '该硬盘存在较高故障风险。' : '以上硬盘均存在较高故障风险。';
  return ['您好，经分析诊断日志，发现 ' + `${devices.length} 块硬盘存在异常：`, deviceLines.join('\n'), raidLines.join('\n'), `综合当前日志信息，${conclusion}建议您尽快备份存储池中的重要数据，并及时更换异常硬盘。`].filter(Boolean).join('\n\n');
}

/**
 * RAID 风险按阵列标识生成，每个阵列只输出一次。used_for 只用于补充用户可识别的存储池名称，
 * 阵列成员关系仍以 mdstat 为准；RAID 1 同阵列有多块异常盘时必须提升为立即备份提示。
 */
function raidRiskMessage(raid: RaidAssessment | undefined, array: string, devices: DeviceAssessment[]): string | undefined {
  if (!raid?.level) return undefined;
  const level = raid.level.toLowerCase();
  if (level === 'raid0') return 'RAID 0 无冗余，一块硬盘故障可能导致整个阵列数据不可用，请立即备份数据。';
  if (level === 'linear' || level === 'jbod') return 'JBOD 无冗余，故障硬盘上的数据可能无法访问，请立即备份数据。';
  if (level === 'raid1') {
    const storagePools = [...new Set(devices.map((device) => device.usedFor).filter((value): value is string => Boolean(value)))];
    const context = `${storagePools.length === 1 ? `${localizeUsage(storagePools[0])} 的 ` : ''}RAID 1（${array}）`;
    const deviceNames = devices.map((device) => localizeDeviceLabel(device.label, device.resource)).join('、');
    if (devices.length >= 2 && storagePools.length <= 1) return `${context}中，${deviceNames} 均存在异常，阵列数据处于高风险，请立即备份重要数据并尽快更换故障硬盘。`;
    if (raid.degraded) return `${context}已降级，${deviceNames || '成员硬盘'} 存在异常，当前冗余降低，请尽快备份重要数据并更换故障硬盘。`;
    return `${context}关联的${deviceNames || '成员硬盘'} 存在异常，请尽快备份重要数据并检查阵列状态。`;
  }
  if (level === 'raid5') return 'RAID 5 已失去冗余，再有一块硬盘故障可能导致数据不可用，请立即备份。';
  if (level === 'raid6') return 'RAID 6 冗余能力已降低，请尽快备份并更换故障硬盘。';
  if (level === 'raid10') return 'RAID 10 已降级，请尽快备份并更换故障硬盘。';
  return undefined;
}
/** 工程师结论保留原始属性和拓扑事实，明确不将时间关联写成未经证实的因果。 */
function buildEngineerConclusion(devices: DeviceAssessment[], arrays: string[] = [], pools: string[] = []): string {
  const deviceFacts = devices.map((device) => {
    const smart = device.smartRiskAttributes.length ? device.smartRiskAttributes.map((attribute) => `SMART ${String(attribute.id).padStart(2, '0')} 原始值 ${attribute.raw}`).join('、') : '未记录 SMART 风险属性';
    const io = device.ioErrorCount > 0 ? `记录到 I/O 读写错误 ${device.ioErrorCount} 次` : '未记录 I/O 读写错误';
    const media = (device.mediaErrorCount ?? 0) > 0 ? `记录到不可恢复介质错误证据 ${device.mediaErrorCount} 条` : '未记录不可恢复介质错误';
    return `${localizeDeviceLabel(device.label, device.resource)}：型号 ${device.model ?? '日志未提供'}，序列号 ${device.serial ?? '日志未提供'}，槽位 ${device.slot ?? '日志未提供'}，设备名 ${device.resource}，用途 ${localizeUsage(device.usedFor)}；${smart}；${io}；${media}`;
  });
  const topologyFacts = [arrays.length ? `关联 RAID ${arrays.join('、')}` : '', pools.length ? `关联存储池 ${pools.join('、')}` : ''].filter(Boolean).join('；');
  return `${deviceFacts.join('。')}${topologyFacts ? `。${topologyFacts}` : ''}。以上为日志记录的设备与事件事实，未据此推断未经证实的因果关系。`;
}

interface UpsOutageSequence {
  onBattery: NormalizedEvent;
  standbyScheduled?: NormalizedEvent;
  lowBattery?: NormalizedEvent;
  alreadyStandby?: NormalizedEvent;
}

/**
 * UPS 日志会长期保留多个停电周期，命令名还可能与实际状态相反。这里只消费精确状态事件，
 * 并用 OL 或 NUT 服务重启切断旧周期；文件系统恢复痕迹只用于佐证下一次启动异常，不能单独归因。
 */
function buildUpsPowerLossDiagnosis(findings: Finding[], events: NormalizedEvent[]): Diagnosis | undefined {
  const relevantTypes = new Set([
    'power.ups_on_battery',
    'power.ups_standby_scheduled',
    'power.ups_low_battery',
    'power.ups_already_standby',
    'power.ups_online',
    'power.ups_service_started',
    'system.unclean_shutdown'
  ]);
  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => Boolean(event.timestamp) && relevantTypes.has(event.type))
    .sort((left, right) => Date.parse(left.event.timestamp!) - Date.parse(right.event.timestamp!) || left.index - right.index);
  let outage: UpsOutageSequence | undefined;
  let correlated: { outage: Required<UpsOutageSequence>; unclean: NormalizedEvent } | undefined;

  for (const { event } of ordered) {
    if (event.type === 'power.ups_on_battery') {
      outage = { onBattery: event };
      continue;
    }
    if (event.type === 'power.ups_online' || event.type === 'power.ups_service_started') {
      outage = undefined;
      continue;
    }
    if (!outage) continue;
    if (event.type === 'power.ups_standby_scheduled') outage.standbyScheduled = event;
    else if (event.type === 'power.ups_low_battery' && outage.standbyScheduled) outage.lowBattery = event;
    else if (event.type === 'power.ups_already_standby' && outage.lowBattery) outage.alreadyStandby = event;
    else if (event.type === 'system.unclean_shutdown' && outage.standbyScheduled && outage.lowBattery && outage.alreadyStandby) {
      correlated = { outage: outage as Required<UpsOutageSequence>, unclean: event };
    }
  }
  if (!correlated) return undefined;

  const findingTypes = [
    'power.ups_on_battery',
    'power.ups_standby_scheduled',
    'power.ups_low_battery',
    'power.ups_already_standby',
    'system.unclean_shutdown'
  ];
  const findingIds = findingTypes
    .map((type) => findings.find((finding) => finding.type === type)?.id)
    .filter((id): id is string => Boolean(id));
  const startedAt = Date.parse(correlated.outage.onBattery.timestamp!);
  const uncleanAt = Date.parse(correlated.unclean.timestamp!);

  return {
    id: 'power.ups_power_loss_suspected',
    category: 'power',
    severity: 'warning',
    confidence: 'high',
    title: 'UPS 低电量后供电中断',
    summary: 'UPS 在电池供电期间按策略进入保护待机，随后报告低电量；下一次启动出现异常中断恢复痕迹，与 UPS 电量耗尽后的供电中断高度一致。',
    affectedResources: [],
    findingIds,
    recommendationIds: ['recommendation.ups:system'],
    userConclusion: '您好，经分析诊断日志，UPS 在停电期间切换至电池供电，系统按设置进入保护待机，随后 UPS 进入低电量状态。下一次启动日志同时出现上次未正常关闭的恢复痕迹。综合判断，本次异常关机与停电持续时间较长、UPS 电量耗尽后供电中断高度一致。建议检查 UPS 电池健康、实际带载续航、负载功率和低电量保护策略。',
    engineerConclusion: 'UPS 事件依次记录电池供电、设置保护待机、低电量和已待机，且在恢复在线或 UPS 服务重启前出现异常启动恢复证据。该结论来自跨日志时间关联，不把文件系统恢复痕迹单独视为根因。',
    correlationWindowMs: Math.max(0, uncleanAt - startedAt)
  };
}

/**
 * 诊断层只提升已经由 Finding 证实的事实：SMART 快照本身可定位设备；多设备同时异常提高整体风险，
 * 但不会据此推断 RAID 或文件系统的因果关系。
 */
function composeDiagnoses(findings: Finding[], events: NormalizedEvent[], topology: Map<string, string[]>, deviceArrays: Map<string, string[]>, deviceAssessments: DeviceAssessment[], raidAssessments: Map<string, RaidAssessment>, externallyDefinedDiagnosisIds: ReadonlySet<string> = new Set()): { diagnoses: Diagnosis[]; recommendationRequests: RecommendationRequest[] } {
  const diagnoses: Diagnosis[] = [];
  const recommendationRequests: RecommendationRequest[] = [];
  const deviceByResource = new Map(deviceAssessments.map((device) => [device.resource, device]));
  const resources = new Set(findings.flatMap((finding) => finding.affectedResources.filter((resource) => resource.startsWith('/dev/'))));
  const smartDevices = [...resources].filter((device) => findings.some((finding) => finding.type === 'storage.smart_risk' && finding.affectedResources.includes(device)));
  const userConclusion = (devices: DeviceAssessment[]) => buildUserConclusion(devices, deviceArrays, raidAssessments);
  const arraysForDevice = (device: string): string[] => {
    const slotNumber = deviceByResource.get(device)?.slot?.match(/^ata(\d+)$/i)?.[1];
    const missingMemberArrays = slotNumber
      ? [...raidAssessments.values()].filter((raid) => raid.degraded && raid.missingMemberIndexes?.includes(Number(slotNumber) - 1)).map((raid) => raid.resource)
      : [];
    return [...new Set([...(deviceArrays.get(device) ?? []), ...missingMemberArrays])];
  };
  const ensureSmartRecommendation = (device: string): string => {
    const id = `recommendation.smart:${device}`;
    if (!recommendationRequests.some((item) => item.kind === 'smart' && item.resource === device)) recommendationRequests.push({ kind: 'smart', resource: device });
    return id;
  };

  if (smartDevices.length >= 2) {
    diagnoses.push({
      id: 'storage.multiple_devices.failure_suspected', category: 'storage', severity: 'critical', confidence: 'high',
      title: '多块硬盘出现 SMART 介质风险',
      summary: `检测到 ${smartDevices.length} 块硬盘的 SMART 属性 05、197 或 198 存在非零原始值，表明已出现介质风险；应优先保护数据并逐块核验。`,
      affectedResources: smartDevices,
      affectedDeviceResources: smartDevices,
      findingIds: findings.filter((finding) => finding.type === 'storage.smart_risk' && smartDevices.some((device) => finding.affectedResources.includes(device))).map((finding) => finding.id),
      recommendationIds: smartDevices.map(ensureSmartRecommendation),
      userConclusion: userConclusion(smartDevices.map((device) => deviceByResource.get(device) ?? { resource: device, smartRiskAttributes: [], ioErrorCount: 0 })),
      engineerConclusion: buildEngineerConclusion(smartDevices.map((device) => deviceByResource.get(device) ?? { resource: device, smartRiskAttributes: [], ioErrorCount: 0 }))
    });
  }

  for (const device of resources) {
    const related = findings.filter((finding) => finding.affectedResources.includes(device));
    const hasIo = related.some((finding) => finding.type === 'storage.io_error');
    const hasMedia = related.some((finding) => finding.type === 'storage.media_error');
    const hasSmart = related.some((finding) => finding.type === 'storage.smart_risk');
    const hasUnavailable = related.some((finding) => finding.type === 'storage.device_unavailable');
    const failed = related.some((finding) => finding.type === 'raid.member_failed');
    const arrays = arraysForDevice(device);
    const pools = arrays.flatMap((array) => topology.get(array) ?? []);
    const filesystemImpacts = findings.filter((finding) => ['filesystem.error', 'filesystem.read_only'].includes(finding.type) && finding.affectedResources.some((resource) => pools.includes(resource)));
    const hasReadOnlyImpact = filesystemImpacts.some((finding) => finding.type === 'filesystem.read_only');
    const recommendationIds = hasSmart ? [ensureSmartRecommendation(device)] : [];
    for (const array of arrays) {
      const id = `recommendation.raid:${array}`;
      if (!recommendationRequests.some((item) => item.kind === 'raid' && item.resource === array)) recommendationRequests.push({ kind: 'raid', resource: array });
      recommendationIds.push(id);
    }

    const assessment = deviceByResource.get(device) ?? { resource: device, smartRiskAttributes: [], ioErrorCount: 0 };
    if (hasMedia) {
      const deviceName = localizeDeviceLabel(assessment.label, device);
      const degradedRaid = arrays.map((array) => raidAssessments.get(array)).find((raid) => raid?.degraded);
      const raidLevel = degradedRaid?.level?.match(/^raid(\d+)$/i)?.[1];
      const raidName = raidLevel ? `RAID ${raidLevel}` : 'RAID';
      const repeated = (assessment.mediaErrorCount ?? 0) > 1 ? '重复的' : '';
      const removed = failed && Boolean(degradedRaid);
      const detail = removed
        ? `${deviceName} 存在${repeated}不可恢复介质读取错误，已被 ${raidName} 移除，${degradedRaid!.resource} 当前处于降级状态。`
        : degradedRaid
          ? `${deviceName} 存在${repeated}不可恢复介质读取错误，${degradedRaid.resource} 当前处于降级状态。`
          : `${deviceName} 存在${repeated}不可恢复介质读取错误。`;
      const mediaFindingIds = related.filter((finding) => finding.type === 'storage.media_error' || finding.type === 'raid.member_failed').map((finding) => finding.id);
      const raidFindingIds = findings.filter((finding) => finding.type === 'raid.degraded' && arrays.some((array) => finding.affectedResources.includes(array))).map((finding) => finding.id);
      diagnoses.unshift({
        id: 'storage.device.media_failure', category: 'storage', severity: 'critical', confidence: 'confirmed',
        title: `${deviceName} 存在介质故障${degradedRaid ? '且 RAID 已降级' : ''}`, summary: detail,
        primaryResource: device,
        affectedResources: [...new Set([device, ...(assessment.slot ? [assessment.slot] : []), ...arrays])],
        affectedDeviceResources: [device], findingIds: [...mediaFindingIds, ...raidFindingIds], recommendationIds,
        userConclusion: `您好，经分析诊断日志，${detail.slice(0, -1)}，建议更换${deviceName}。`,
        engineerConclusion: buildEngineerConclusion([assessment], arrays, pools)
      });
      continue;
    }
    if (hasSmart && !hasIo && !failed) {
      diagnoses.push({ id: 'storage.device.smart_risk', category: 'storage', severity: 'warning', confidence: 'high', title: `${device} 存在 SMART 介质风险`, summary: `${device} 的 SMART 属性 05、197 或 198 存在非零原始值，已出现介质风险；需尽快核验并保护数据。`, primaryResource: device, affectedResources: [device, ...arrays, ...pools], affectedDeviceResources: [device], findingIds: related.filter((finding) => finding.type === 'storage.smart_risk').map((finding) => finding.id), recommendationIds, userConclusion: userConclusion([assessment]), engineerConclusion: buildEngineerConclusion([assessment], arrays, pools) });
      continue;
    }
    if (!hasIo || (!hasSmart && !failed)) continue;
    const deviceName = localizeDeviceLabel(assessment.label, device);
    const storageName = assessment.usedFor ? localizeUsage(assessment.usedFor) : pools[0]?.replace(/^pool(\d+)$/i, '存储池 $1') ?? '关联存储池';
    const confirmedLinkFailure = hasSmart && hasUnavailable && hasReadOnlyImpact;
    const linkedSummary = `${deviceName} 健康信息异常并发生链路掉线，导致${storageName} 写入失败并被强制切换为只读。`;
    diagnoses.push({
      id: 'storage.device.suspected_failure', category: 'storage', severity: 'critical', confidence: hasSmart ? 'high' : 'medium',
      title: confirmedLinkFailure ? `${deviceName} 健康异常并发生链路掉线` : `${device} 高度疑似存在磁盘故障`,
      summary: confirmedLinkFailure ? linkedSummary : `多项独立证据显示 ${device} 持续存在 I/O 异常${hasSmart ? '，SMART 同时存在介质风险' : ''}${filesystemImpacts.length ? '，关联卷出现文件系统挂载异常' : ''}${arrays.length ? `，并影响 ${arrays.join('、')}` : ''}。`,
      primaryResource: device,
      affectedResources: [...new Set([device, ...arrays, ...pools, ...filesystemImpacts.flatMap((finding) => finding.affectedResources)])],
      affectedDeviceResources: hasSmart ? [device] : undefined,
      findingIds: [...new Set([...related, ...filesystemImpacts].map((finding) => finding.id))], recommendationIds,
      userConclusion: confirmedLinkFailure
        ? `您好，经分析诊断日志，${linkedSummary}请关机后重新拔插${deviceName}；如换槽后仍出现相同错误，说明硬盘自身故障，建议更换${deviceName}。`
        : hasSmart ? userConclusion([assessment]) : undefined,
      engineerConclusion: buildEngineerConclusion([assessment], arrays, pools), correlationWindowMs: 5 * 60_000
    });
  }
  const filesystemPools = findings.filter((finding) => ['filesystem.error', 'filesystem.read_only'].includes(finding.type)).flatMap((finding) => finding.affectedResources);
  const filesystemDevices = deviceAssessments.filter((device) => (deviceArrays.get(device.resource) ?? []).some((array) => (topology.get(array) ?? []).some((pool) => filesystemPools.includes(pool))));
  const hasDiskFault = smartDevices.length > 0 || [...resources].some((device) => findings.some((finding) => finding.type === 'storage.io_error' && finding.affectedResources.includes(device)));
  if (filesystemPools.length > 0 && filesystemDevices.length > 0 && !hasDiskFault && filesystemDevices.every((device) => !device.smartRiskAttributes.length && device.ioErrorCount === 0)) {
    diagnoses.push({ id: 'filesystem.storage.repair', category: 'filesystem', severity: 'warning', confidence: 'high', title: '存储空间文件系统异常', summary: '关联存储池下的存储空间文件系统出现错误，需由工程师远程修复。', affectedResources: [...new Set(filesystemPools)], findingIds: findings.filter((finding) => finding.type === 'filesystem.error').map((finding) => finding.id), recommendationIds: [], userConclusion: '您好，经分析诊断日志，当前硬盘健康信息正常，但存储池下的存储空间文件系统存在异常，需要给您修复文件系统。' });
  }
  const knownSlots = new Set(deviceAssessments.map((device) => device.slot?.toLowerCase()).filter((slot): slot is string => Boolean(slot)));
  const missingAtaFindings = findings.filter((finding) => ['storage.sata_link_down', 'storage.device_unrecognized'].includes(finding.type) && finding.affectedResources.some((value) => /^ata\d+$/i.test(value) && !knownSlots.has(value.toLowerCase())));
  const degradedRaidForFinding = (finding: Finding): RaidAssessment | undefined => {
    const slotNumber = finding.affectedResources.find((value) => /^ata\d+$/i.test(value))?.match(/^ata(\d+)$/i)?.[1];
    return slotNumber
      ? [...raidAssessments.values()].find((raid) => raid.degraded && raid.missingMemberIndexes?.includes(Number(slotNumber) - 1))
      : undefined;
  };
  const countMismatchFinding = findings.find((finding) => finding.type === 'storage.device_count_mismatch');
  // 裸 SATA link down 也会出现在空槽位启动探测中；只有 RAID 缺口或设备数量不一致能够把它提升为掉盘结论。
  const missingDeviceFinding = missingAtaFindings.find((finding) => degradedRaidForFinding(finding))
    ?? (countMismatchFinding ? missingAtaFindings[0] : undefined)
    ?? findings.find((finding) => finding.type === 'storage.device_unrecognized' && finding.affectedResources.some((value) => value.startsWith('/dev/')));
  if (missingDeviceFinding) {
    const resource = missingDeviceFinding.affectedResources.find((value) => /^ata\d+$/i.test(value) || value.startsWith('/dev/'));
    const slotNumber = resource?.match(/^ata(\d+)$/i)?.[1];
    const knownDevice = resource?.startsWith('/dev/')
      ? deviceByResource.get(resource)
      : deviceAssessments.find((device) => device.slot?.toLowerCase() === resource?.toLowerCase());
    const deviceName = knownDevice ? localizeDeviceLabel(knownDevice.label, knownDevice.resource) : slotNumber ? `硬盘 ${slotNumber}` : '硬盘';
    // mdstat 的状态字符与成员下标一一对应；只在 ata 槽位编号命中同一缺口时关联降级阵列。
    const degradedRaid = degradedRaidForFinding(missingDeviceFinding);
    if (degradedRaid && resource) {
      const raidFinding = findings.find((finding) => finding.type === 'raid.degraded' && finding.affectedResources.includes(degradedRaid.resource));
      const findingIds = [missingDeviceFinding.id, raidFinding?.id, countMismatchFinding?.id].filter((id): id is string => Boolean(id));
      const conclusion = `${deviceName} 掉盘且 RAID 已降级。`;
      diagnoses.unshift({
        id: 'storage.device.unrecognized', category: 'storage', severity: 'critical', confidence: 'confirmed',
        title: `${deviceName} 掉盘且 RAID 已降级`, summary: conclusion, primaryResource: resource,
        affectedResources: [resource, degradedRaid.resource], findingIds, recommendationIds: [],
        userConclusion: `您好，经分析诊断日志，${conclusion}${dropoutAction(deviceName)}`
      });
    } else {
      diagnoses.unshift({ id: 'storage.device.unrecognized', category: 'storage', severity: 'critical', confidence: 'confirmed', title: '硬盘未被系统识别', summary: '日志记录到硬盘链路或识别异常。', primaryResource: resource, affectedResources: missingDeviceFinding.affectedResources, findingIds: [missingDeviceFinding.id], recommendationIds: [], userConclusion: `您好，经分析诊断日志，${deviceName === '硬盘' ? deviceName : `${deviceName} `}当前未被系统识别，可能存在硬盘接触或槽位异常。${dropoutAction(deviceName)}` });
    }
  }
  if (!diagnoses.length) { const raid = findings.find((finding) => finding.type === 'raid.degraded'); if (raid) diagnoses.push({ id: 'raid.array.degraded', category: 'raid', severity: 'critical', confidence: 'confirmed', title: `${raid.affectedResources[0] ?? 'RAID'} 已降级`, summary: '阵列状态异常，需要确认冗余与成员状态。', primaryResource: raid.affectedResources[0], affectedResources: raid.affectedResources, findingIds: [raid.id], recommendationIds: [] }); }
  if (!externallyDefinedDiagnosisIds.has('power.ups_power_loss_suspected')) {
    const upsDiagnosis = buildUpsPowerLossDiagnosis(findings, events);
    if (upsDiagnosis) {
      recommendationRequests.push({ kind: 'ups', resource: 'system' });
      if (diagnoses.some((diagnosis) => diagnosis.severity === 'critical')) diagnoses.push(upsDiagnosis);
      else diagnoses.unshift(upsDiagnosis);
    }
  }
  return { diagnoses, recommendationRequests }; }

/** Recommendation 的文案物化与排序独立计时，诊断阶段只保留去重后的请求和稳定 ID。 */
function composeRecommendations(requests: RecommendationRequest[]): Recommendation[] {
  return requests.map((request): Recommendation => {
    if (request.kind === 'smart') return { id: `recommendation.smart:${request.resource}`, priority: 1, type: 'inspection', title: `检查 ${request.resource} SMART`, reason: '确认磁盘介质错误及健康状态。', risk: 'safe' };
    if (request.kind === 'ups') return { id: 'recommendation.ups:system', priority: 1, type: 'inspection', title: '检查 UPS 电池与带载续航', reason: '确认 UPS 电池健康、实际负载、可用续航和低电量保护策略。', risk: 'safe' };
    return { id: `recommendation.raid:${request.resource}`, priority: 2, type: 'verification', title: `确认 ${request.resource} 当前冗余状态`, reason: '确认阵列是否仍具有足够冗余。', risk: 'safe' };
  })
    .sort((left, right) => left.priority - right.priority);
}

function duplicateEvidenceCount(evidence: Evidence[]): number {
  const unique = new Set(evidence.map((item) => JSON.stringify([
    item.sourceFile, item.lineNumber, item.timestamp, item.timestampPrecision, item.timestampConfidence,
    item.eventType, item.resource, item.rawMessage, item.contextBefore, item.contextAfter
  ])));
  return evidence.length - unique.size;
}

function duplicateEventCount(events: NormalizedEvent[], evidence: Evidence[]): number {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const unique = new Set(events.map((event) => {
    const item = evidenceById.get(event.evidenceId);
    return JSON.stringify([
      event.ruleId, event.type, event.resource, event.timestamp, event.timestampPrecision,
      event.timestampConfidence, event.attributes, item?.sourceFile, item?.lineNumber, item?.rawMessage
    ]);
  }));
  return events.length - unique.size;
}
