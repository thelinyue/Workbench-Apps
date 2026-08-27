import { z } from 'zod';
import rulePackJson from './event-rule-pack.json';

export type Severity = 'critical' | 'warning' | 'info';
export type Confidence = 'confirmed' | 'high' | 'medium' | 'low';
export type TimestampPrecision = 'exact' | 'derived' | 'relative' | 'unknown';

export interface Evidence { id: string; timestamp?: string; timestampPrecision: TimestampPrecision; timestampConfidence: Confidence; sourceFile: string; lineNumber?: number; eventType: string; resource?: string; rawMessage: string; contextBefore?: string[]; contextAfter?: string[]; }
export interface NormalizedEvent { id: string; ruleId: string; type: string; resource?: string; timestamp?: string; timestampPrecision: TimestampPrecision; timestampConfidence: Confidence; evidenceId: string; attributes: Record<string, string | number>; }
export interface Finding { id: string; type: string; category: string; severity: Severity; confidence: Confidence; title: string; summary: string; affectedResources: string[]; evidenceIds: string[]; firstSeen?: string; lastSeen?: string; occurrenceCount: number; }
export interface Recommendation { id: string; priority: number; type: 'inspection' | 'verification' | 'repair'; title: string; reason: string; risk: 'safe' | 'confirmation-required' | 'high-risk'; }
export interface SmartRiskAttribute { id: number; name: string; raw: number; }
export interface DeviceAssessment { resource: string; label?: string; model?: string; serial?: string; slot?: string; usedFor?: string; smartRiskAttributes: SmartRiskAttribute[]; ioErrorCount: number; }
export interface Diagnosis { id: string; category: string; severity: Severity; confidence: Confidence; title: string; summary: string; primaryResource?: string; affectedResources: string[]; affectedDeviceResources?: string[]; findingIds: string[]; recommendationIds: string[]; userConclusion?: string; engineerConclusion?: string; correlationWindowMs?: number; }
export interface AnalysisResult { schemaVersion: 1; id: string; status: 'completed' | 'partial'; summary: { criticalCount: number; warningCount: number; infoCount: number; primaryDiagnosisId?: string; complete: boolean }; diagnoses: Diagnosis[]; findings: Finding[]; evidence: Evidence[]; deviceAssessments: DeviceAssessment[]; recommendations: Recommendation[]; metadata: { source: string; startTime: string; completeTime: string; duration: number; processedFiles: number; processedLines: number; processedEvents: number; analyzerVersion: string; rulePackVersion: string; missingData: string[] }; }

interface DeviceIdentity { resource: string; label?: string; model?: string; serial?: string; slot?: string; usedFor?: string; }
interface RaidAssessment { resource: string; level?: string; expectedMembers?: number; activeMembers?: number; degraded: boolean; }

const rulePackSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), eventRules: z.array(z.object({ id: z.string(), sources: z.array(z.enum(['kernel', 'sysinfo', 'mdstat', 'ugvolume'])), regex: z.string(), type: z.string() })) });
const rulePack = rulePackSchema.parse(rulePackJson);

/** V1 只分析白名单来源，所有后续规则只消费这里生成的结构化事件。 */
export function analyzeV1Sources(input: { sourceName: string; files: Record<string, string> }): AnalysisResult {
  const started = new Date();
  const evidence: Evidence[] = [];
  const events: NormalizedEvent[] = [];
  const topology = new Map<string, string[]>();
  const deviceArrays = new Map<string, string[]>();
  const raidAssessments = new Map<string, RaidAssessment>();
  const deviceIdentities = new Map<string, DeviceIdentity>();
  let processedLines = 0;
  let evidenceNumber = 0;
  const add = (ruleId: string, type: string, sourceFile: string, line: string, lineNumber: number | undefined, resource?: string, attributes: Record<string, string | number> = {}) => {
    const time = parseTimestamp(line);
    const id = `evidence-${++evidenceNumber}`;
    evidence.push({ id, timestamp: time.timestamp, timestampPrecision: time.precision, timestampConfidence: time.confidence, sourceFile, lineNumber, eventType: type, resource, rawMessage: line.slice(0, 4000) });
    events.push({ id: `event-${evidenceNumber}`, ruleId, type, resource, timestamp: time.timestamp, timestampPrecision: time.precision, timestampConfidence: time.confidence, evidenceId: id, attributes });
  };

  for (const [sourceFile, content] of Object.entries(input.files)) {
    const source = classify(sourceFile);
    if (!source) continue;
    if (source === 'sysinfo') parseSysinfo(content, sourceFile, add, deviceIdentities);
    else {
      const lines = content.split(/\r?\n/);
      const mdstatContext: { currentArray?: string } = {};
      processedLines += lines.length;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const emittedTypes = new Set<string>();
        for (const rule of rulePack.eventRules) {
          if (!rule.sources.includes(source)) continue;
          if (source === 'mdstat' && rule.type === 'raid.degraded') continue;
          const match = new RegExp(rule.regex, 'i').exec(line);
          if (!match || emittedTypes.has(rule.type)) continue;
          const device = match.groups?.device;
          const resource = device ? `/dev/${device.replace(/\d+$/, '')}` : source === 'ugvolume' && rule.type === 'filesystem.error' ? poolFromMountLine(line) : undefined;
          add(rule.id, rule.type, sourceFile, line, index + 1, resource);
          emittedTypes.add(rule.type);
        }
        if (source === 'mdstat') parseMdstatLine(line, sourceFile, index + 1, add, deviceArrays, raidAssessments, mdstatContext);
        if (source === 'ugvolume') parseTopology(line, topology);
      }
    }
  }
  for (const event of events.filter((item) => item.type === 'raid.degraded')) {
    const linked = topology.get(event.resource ?? '') ?? [];
    for (const resource of linked) event.attributes.affected = resource;
  }
  const findings = aggregateFindings(events, evidence, topology);
  const deviceAssessments = buildDeviceAssessments(deviceIdentities, events);
  const { diagnoses, recommendations } = composeDiagnoses(findings, events, topology, deviceArrays, deviceAssessments, raidAssessments);
  const missingData = ['sysinfo', 'mdstat'].filter((source) => !Object.keys(input.files).some((file) => classify(file) === source));
  const ended = new Date();
  const criticalCount = diagnoses.filter((item) => item.severity === 'critical').length;
  const warningCount = diagnoses.filter((item) => item.severity === 'warning').length;
  return { schemaVersion: 1, id: `analysis-${started.getTime()}`, status: missingData.length ? 'partial' : 'completed', summary: { criticalCount, warningCount, infoCount: diagnoses.filter((item) => item.severity === 'info').length, primaryDiagnosisId: diagnoses[0]?.id, complete: missingData.length === 0 }, diagnoses, findings, evidence, deviceAssessments, recommendations, metadata: { source: input.sourceName, startTime: started.toISOString(), completeTime: ended.toISOString(), duration: ended.getTime() - started.getTime(), processedFiles: Object.keys(input.files).filter((file) => classify(file)).length, processedLines, processedEvents: events.length, analyzerVersion: '1.0.0', rulePackVersion: rulePack.version, missingData } };
}

function classify(file: string): 'kernel' | 'sysinfo' | 'mdstat' | 'ugvolume' | undefined { const name = file.replaceAll('\\', '/').toLowerCase(); if (name.endsWith('sysinfo.json')) return 'sysinfo'; if (name.endsWith('mdstat.log')) return 'mdstat'; if (name.endsWith('ugvolume.log')) return 'ugvolume'; return /(?:^|\/)(?:kern(?:\.log(?:\.\d+)?)?|syslog(?:\.\d+)?|journal[^/]*|dmesg[^/]*)$/.test(name) ? 'kernel' : undefined; }
function parseTimestamp(line: string): { timestamp?: string; precision: TimestampPrecision; confidence: Confidence } { const match = line.match(/\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)\b/); return match ? { timestamp: new Date(match[1].replace(' ', 'T')).toISOString(), precision: 'exact', confidence: 'confirmed' } : { precision: 'unknown', confidence: 'low' }; }
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
      const nestedDevice = diskInfo && typeof diskInfo.dev_name === 'string' ? diskInfo.dev_name : undefined;
      const deviceName = typeof item.dev_name === 'string' ? item.dev_name : nestedDevice ?? device;
      const currentDevice = deviceName ? normalizeDeviceName(deviceName) : undefined;
      if (diskInfo && currentDevice) {
        // disk_info 是唯一的硬盘身份来源；只保存诊断与定位所需字段，避免复制整份 sysinfo。
        deviceIdentities.set(currentDevice, {
          resource: currentDevice,
          label: readString(diskInfo.label),
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
    return { ...identity, smartRiskAttributes, ioErrorCount: events.filter((event) => event.type === 'storage.io_error' && event.resource === resource).length };
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
  assessment.degraded ||= assessment.activeMembers < assessment.expectedMembers || status[3].includes('_');
  if (assessment.degraded) add('raid.array.degraded', 'raid.degraded', file, line, lineNumber, assessment.resource);
}
function parseTopology(line: string, topology: Map<string, string[]>): void { const match = line.match(/pool\[([^\]]+)\].*\/dev\/(md\d+)/i); if (match) topology.set(match[2], [...new Set([...(topology.get(match[2]) ?? []), match[1]])]); const mount = line.match(/pool(\d+)-[^,\s]+.*mntPath:?(\/volume\d+)/i); if (mount) { const pool = `pool${mount[1]}`; topology.set(pool, [...new Set([...(topology.get(pool) ?? []), mount[2]])]); } }
function poolFromMountLine(line: string): string | undefined { const match = line.match(/pool(\d+)-/i); return match ? `pool${match[1]}` : undefined; }
function aggregateFindings(events: NormalizedEvent[], evidence: Evidence[], topology: Map<string, string[]>): Finding[] { const groups = new Map<string, NormalizedEvent[]>(); for (const event of events) { const key = `${event.type}:${event.resource ?? 'system'}`; groups.set(key, [...(groups.get(key) ?? []), event]); } return [...groups.entries()].map(([key, grouped]) => { const event = grouped[0]; const resource = event.resource; const extra = resource ? topology.get(resource) ?? [] : []; const title = titleFor(event.type, resource); return { id: key, type: event.type, category: event.type.split('.')[0], severity: severityFor(event.type), confidence: event.type.startsWith('raid.') ? 'confirmed' : event.type === 'storage.smart_risk' ? 'high' : 'medium', title, summary: `${title}，共 ${grouped.length} 次。`, affectedResources: [...new Set([...(resource ? [resource] : []), ...extra])], evidenceIds: grouped.map((item) => item.evidenceId), firstSeen: grouped.map((item) => item.timestamp).filter(Boolean).sort()[0], lastSeen: grouped.map((item) => item.timestamp).filter(Boolean).sort().at(-1), occurrenceCount: grouped.length }; }); }
function titleFor(type: string, resource?: string): string { const names: Record<string, string> = { 'storage.io_error': '检测到块设备 I/O 错误', 'storage.smart_risk': '检测到 SMART 介质风险指标', 'raid.member_failed': 'RAID 成员已失败', 'raid.degraded': 'RAID 阵列已降级', 'filesystem.error': '检测到文件系统错误', 'system.unclean_shutdown': '检测到异常关机线索', 'system.kernel_panic': '检测到 Kernel Panic', 'system.oom': '检测到内存耗尽', 'system.oom_killer': '检测到 OOM Killer', 'system.watchdog': '检测到 Watchdog 锁死' }; return `${resource ? `${resource} ` : ''}${names[type] ?? type}`; }
function severityFor(type: string): Severity { return type.startsWith('raid.') || type === 'system.kernel_panic' || type === 'system.watchdog' ? 'critical' : type.startsWith('storage.') || type.startsWith('filesystem.') || type.startsWith('system.') ? 'warning' : 'info'; }
function localizeDeviceLabel(label: string | undefined, resource: string): string { if (!label) return resource; const m2 = label.match(/^M\.2\s+Hard Drive\s+(\d+)$/i); if (m2) return `M.2 硬盘 ${m2[1]}`; const disk = label.match(/^Hard Drive\s+(\d+)$/i); return disk ? `硬盘 ${disk[1]}` : label; }
function localizeUsage(usage: string | undefined): string { return usage?.replace(/^Storage Pool\s+(\d+)$/i, '存储池 $1') ?? '日志未提供'; }
/** 用户结论只转换已确认的设备、阵列事实，不让用户重复执行已经完成的诊断检查。 */
function buildUserConclusion(devices: DeviceAssessment[], deviceArrays: Map<string, string[]>, raidAssessments: Map<string, RaidAssessment>): string {
  const deviceLines = devices.map((device) => {
    const facts = [device.ioErrorCount > 0 ? '检测到多次读写错误（I/O Error）' : '', device.smartRiskAttributes.length ? '硬盘健康信息存在异常' : ''].filter(Boolean);
    return `${localizeDeviceLabel(device.label, device.resource)}（序列号：${device.serial ?? '日志未提供'}）：${facts.join('；')}。`;
  });
  const arrays = [...new Set(devices.flatMap((device) => deviceArrays.get(device.resource) ?? []))];
  const raidLines = arrays.map((array) => raidRiskMessage(raidAssessments.get(array))).filter((value): value is string => Boolean(value));
  const conclusion = devices.length === 1 ? '该硬盘存在较高故障风险。' : '以上硬盘均存在较高故障风险。';
  return ['您好，经分析诊断日志，发现 ' + `${devices.length} 块硬盘存在异常：`, deviceLines.join('\n'), raidLines.join('\n'), `综合当前日志信息，${conclusion}建议您尽快备份存储池中的重要数据，并及时更换异常硬盘。`].filter(Boolean).join('\n\n');
}

/** RAID 10 的多盘容错依赖镜像组位置，因此仅说明降级事实，不按成员数量承诺数据安全。 */
function raidRiskMessage(raid: RaidAssessment | undefined): string | undefined {
  if (!raid?.level) return undefined;
  const level = raid.level.toLowerCase();
  if (level === 'raid0') return 'RAID 0 无冗余，一块硬盘故障可能导致整个阵列数据不可用，请立即备份数据。';
  if (level === 'linear' || level === 'jbod') return 'JBOD 无冗余，故障硬盘上的数据可能无法访问，请立即备份数据。';
  if (level === 'raid1') return 'RAID 1 已降级，当前冗余降低，请尽快备份并更换故障硬盘。';
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
    return `${localizeDeviceLabel(device.label, device.resource)}：型号 ${device.model ?? '日志未提供'}，序列号 ${device.serial ?? '日志未提供'}，槽位 ${device.slot ?? '日志未提供'}，设备名 ${device.resource}，用途 ${localizeUsage(device.usedFor)}；${smart}；${io}`;
  });
  const topologyFacts = [arrays.length ? `关联 RAID ${arrays.join('、')}` : '', pools.length ? `关联存储池 ${pools.join('、')}` : ''].filter(Boolean).join('；');
  return `${deviceFacts.join('。')}${topologyFacts ? `。${topologyFacts}` : ''}。以上为日志记录的设备与事件事实，未据此推断未经证实的因果关系。`;
}
/**
 * 诊断层只提升已经由 Finding 证实的事实：SMART 快照本身可定位设备；多设备同时异常提高整体风险，
 * 但不会据此推断 RAID 或文件系统的因果关系。
 */
function composeDiagnoses(findings: Finding[], events: NormalizedEvent[], topology: Map<string, string[]>, deviceArrays: Map<string, string[]>, deviceAssessments: DeviceAssessment[], raidAssessments: Map<string, RaidAssessment>): { diagnoses: Diagnosis[]; recommendations: Recommendation[] } {
  const diagnoses: Diagnosis[] = [];
  const recommendations: Recommendation[] = [];
  const deviceByResource = new Map(deviceAssessments.map((device) => [device.resource, device]));
  const resources = new Set(findings.flatMap((finding) => finding.affectedResources.filter((resource) => resource.startsWith('/dev/'))));
  const smartDevices = [...resources].filter((device) => findings.some((finding) => finding.type === 'storage.smart_risk' && finding.affectedResources.includes(device)));
  const userConclusion = (devices: DeviceAssessment[]) => buildUserConclusion(devices, deviceArrays, raidAssessments);
  const ensureSmartRecommendation = (device: string): string => {
    const id = `recommendation.smart:${device}`;
    if (!recommendations.some((item) => item.id === id)) recommendations.push({ id, priority: 1, type: 'inspection', title: `检查 ${device} SMART`, reason: '确认磁盘介质错误及健康状态。', risk: 'safe' });
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
    const hasSmart = related.some((finding) => finding.type === 'storage.smart_risk');
    const failed = related.some((finding) => finding.type === 'raid.member_failed');
    const arrays = deviceArrays.get(device) ?? [];
    const pools = arrays.flatMap((array) => topology.get(array) ?? []);
    const filesystemImpacts = findings.filter((finding) => finding.type === 'filesystem.error' && finding.affectedResources.some((resource) => pools.includes(resource)));
    const recommendationIds = hasSmart ? [ensureSmartRecommendation(device)] : [];
    for (const array of arrays) {
      const id = `recommendation.raid:${array}`;
      if (!recommendations.some((item) => item.id === id)) recommendations.push({ id, priority: 2, type: 'verification', title: `确认 ${array} 当前冗余状态`, reason: '确认阵列是否仍具有足够冗余。', risk: 'safe' });
      recommendationIds.push(id);
    }

    const assessment = deviceByResource.get(device) ?? { resource: device, smartRiskAttributes: [], ioErrorCount: 0 };
    if (hasSmart && !hasIo && !failed) {
      diagnoses.push({ id: 'storage.device.smart_risk', category: 'storage', severity: 'warning', confidence: 'high', title: `${device} 存在 SMART 介质风险`, summary: `${device} 的 SMART 属性 05、197 或 198 存在非零原始值，已出现介质风险；需尽快核验并保护数据。`, primaryResource: device, affectedResources: [device, ...arrays, ...pools], affectedDeviceResources: [device], findingIds: related.filter((finding) => finding.type === 'storage.smart_risk').map((finding) => finding.id), recommendationIds, userConclusion: userConclusion([assessment]), engineerConclusion: buildEngineerConclusion([assessment], arrays, pools) });
      continue;
    }
    if (!hasIo || (!hasSmart && !failed)) continue;
    diagnoses.push({ id: 'storage.device.suspected_failure', category: 'storage', severity: 'critical', confidence: hasSmart ? 'high' : 'medium', title: `${device} 高度疑似存在磁盘故障`, summary: `多项独立证据显示 ${device} 持续存在 I/O 异常${hasSmart ? '，SMART 同时存在介质风险' : ''}${filesystemImpacts.length ? '，关联卷出现文件系统挂载异常' : ''}${arrays.length ? `，并影响 ${arrays.join('、')}` : ''}。`, primaryResource: device, affectedResources: [...new Set([device, ...arrays, ...pools, ...filesystemImpacts.flatMap((finding) => finding.affectedResources)])], affectedDeviceResources: hasSmart ? [device] : undefined, findingIds: [...related, ...filesystemImpacts].map((finding) => finding.id), recommendationIds, userConclusion: hasSmart ? userConclusion([assessment]) : undefined, engineerConclusion: buildEngineerConclusion([assessment], arrays, pools), correlationWindowMs: 5 * 60_000 });
  }
  const filesystemPools = findings.filter((finding) => finding.type === 'filesystem.error').flatMap((finding) => finding.affectedResources);
  const filesystemDevices = deviceAssessments.filter((device) => (deviceArrays.get(device.resource) ?? []).some((array) => (topology.get(array) ?? []).some((pool) => filesystemPools.includes(pool))));
  const hasDiskFault = smartDevices.length > 0 || [...resources].some((device) => findings.some((finding) => finding.type === 'storage.io_error' && finding.affectedResources.includes(device)));
  if (filesystemPools.length > 0 && filesystemDevices.length > 0 && !hasDiskFault && filesystemDevices.every((device) => !device.smartRiskAttributes.length && device.ioErrorCount === 0)) {
    diagnoses.push({ id: 'filesystem.storage.repair', category: 'filesystem', severity: 'warning', confidence: 'high', title: '存储空间文件系统异常', summary: '关联存储池下的存储空间文件系统出现错误，需由工程师远程修复。', affectedResources: [...new Set(filesystemPools)], findingIds: findings.filter((finding) => finding.type === 'filesystem.error').map((finding) => finding.id), recommendationIds: [], userConclusion: '您好，经分析诊断日志，当前硬盘健康信息正常，但存储池下的存储空间文件系统存在异常，需要给您修复文件系统。' });
  }
  const missingDeviceFinding = findings.find((finding) => finding.type === 'storage.device_unrecognized');
  if (missingDeviceFinding) {
    const resource = missingDeviceFinding.affectedResources.find((value) => value.startsWith('/dev/'));
    const deviceName = resource ? localizeDeviceLabel(deviceByResource.get(resource)?.label, resource) : '硬盘';
    diagnoses.unshift({ id: 'storage.device.unrecognized', category: 'storage', severity: 'critical', confidence: 'confirmed', title: '硬盘未被系统识别', summary: '日志记录到硬盘链路或识别异常。', primaryResource: resource, affectedResources: missingDeviceFinding.affectedResources, findingIds: [missingDeviceFinding.id], recommendationIds: [], userConclusion: `您好，经分析诊断日志，${deviceName === '硬盘' ? deviceName : `${deviceName} `}当前未被系统识别，可能存在硬盘接触或槽位异常。请先关机后重新插拔硬盘，或更换其他硬盘槽位接入后再观察。` });
  }
  if (!diagnoses.length) { const raid = findings.find((finding) => finding.type === 'raid.degraded'); if (raid) diagnoses.push({ id: 'raid.array.degraded', category: 'raid', severity: 'critical', confidence: 'confirmed', title: `${raid.affectedResources[0] ?? 'RAID'} 已降级`, summary: '阵列状态异常，需要确认冗余与成员状态。', primaryResource: raid.affectedResources[0], affectedResources: raid.affectedResources, findingIds: [raid.id], recommendationIds: [] }); }
  return { diagnoses, recommendations: recommendations.sort((left, right) => left.priority - right.priority) }; }
