import { createHash, verify, type KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AnalyzerRuleCatalog } from '../analysis/log-analyzer';

export const ANALYSIS_RULE_SET_ID = 'analysis-center-runtime-rules';
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const keywordSchema = z.object({
  term: z.string().min(1).max(4096), result: z.string().min(1).max(4096), regex: z.boolean().optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(), context_lines: z.number().int().min(0).max(1000).optional(),
  context_direction: z.enum(['up', 'down']).optional(), search_direction: z.enum(['up', 'down']).optional()
}).strict();
const formatFileSchema = z.object({ name: z.string().min(1).max(255), category: z.string().min(1).max(128), file_patterns: z.array(z.string().min(1).max(1024)).max(32).optional(), keywords: z.array(keywordSchema).max(4096) }).strict();
const eventRuleSchema = z.object({ id: z.string().min(1).max(128), sources: z.array(z.enum(['kernel', 'sysinfo', 'mdstat', 'ugvolume', 'ups'])).min(1), regex: z.string().min(1).max(4096), type: z.string().min(1).max(128) }).strict();
const findingRuleSchema = z.object({ type: z.string().min(1).max(128), category: z.string().min(1).max(128), severity: z.enum(['critical', 'warning', 'info']), confidence: z.enum(['confirmed', 'high', 'medium', 'low']), title: z.string().min(1).max(512), summary: z.string().min(1).max(4096) }).strict();
const conditionSchema = z.object({ type: z.string().min(1).max(128), minCount: z.number().int().min(1).max(1000).optional(), sameResource: z.boolean().optional() }).strict();
const diagnosisRuleSchema = z.object({
  id: z.string().min(1).max(128), priority: z.number().int().min(0).max(10000),
  all: z.array(conditionSchema).max(32).optional(), any: z.array(conditionSchema).max(32).optional(), none: z.array(conditionSchema).max(32).optional(),
  sequence: z.array(z.object({ type: z.string().min(1).max(128), withinMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(), noInterveningTypes: z.array(z.string().min(1).max(128)).max(32).optional() }).strict()).min(2).max(16).optional(),
  category: z.string().min(1).max(128), severity: z.enum(['critical', 'warning', 'info']), confidence: z.enum(['confirmed', 'high', 'medium', 'low']),
  title: z.string().min(1).max(512), summary: z.string().min(1).max(4096), userConclusion: z.string().max(4096).optional(), engineerConclusion: z.string().max(4096).optional(), recommendationIds: z.array(z.string().min(1).max(128)).max(16).default([])
}).strict();
const recommendationSchema = z.object({ id: z.string().min(1).max(128), priority: z.number().int().min(0).max(10000), type: z.enum(['inspection', 'verification', 'repair']), title: z.string().min(1).max(512), reason: z.string().min(1).max(4096), risk: z.enum(['safe', 'confirmation-required', 'high-risk']) }).strict();
const packageSchema = z.object({
  schemaVersion: z.literal(1), ruleSetId: z.literal(ANALYSIS_RULE_SET_ID), version: z.string().regex(VERSION_PATTERN), minimumRuntimeVersion: z.string().regex(VERSION_PATTERN),
  formatRules: z.object({ tgz: z.object({ files: z.array(formatFileSchema).max(512) }).strict(), zip: z.object({ files: z.array(formatFileSchema).max(512) }).strict() }).strict(),
  v1: z.object({ eventRules: z.array(eventRuleSchema).max(512), findingRules: z.array(findingRuleSchema).max(512), diagnosisRules: z.array(diagnosisRuleSchema).max(256), recommendations: z.array(recommendationSchema).max(256) }).strict()
}).strict();
const catalogSchema = z.object({
  schemaVersion: z.literal(1), ruleSetId: z.literal(ANALYSIS_RULE_SET_ID), version: z.string().regex(VERSION_PATTERN), packageUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'packageUrl 必须使用 HTTPS'),
  packageSize: z.number().int().positive().max(MAX_PACKAGE_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/), signatureAlgorithm: z.literal('Ed25519'), keyId: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), signature: z.string().min(1).max(256)
}).strict();

export type AnalysisRulePackage = z.infer<typeof packageSchema>;
export type AnalysisFindingRule = z.infer<typeof findingRuleSchema>;
export type AnalysisDiagnosisRule = z.infer<typeof diagnosisRuleSchema>;
export type AnalysisRecommendationRule = z.infer<typeof recommendationSchema>;
type RuleCatalog = z.infer<typeof catalogSchema>;
type RuleSource = 'bundled' | 'downloaded';

export interface AnalysisRulesServiceOptions {
  directory: string;
  seed: AnalysisRulePackage;
  catalogUrl: string;
  trustedKeys: Record<string, KeyObject | string>;
  runtimeVersion?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 分析中心独立维护可执行规则快照，不借助宿主 IPC。
 *
 * 远程数据只能描述受限规则，不能携带代码；包在验签、结构与正则全部通过前不会写入当前指针。
 * 分析任务通过 getSnapshot 取得不可变副本，因此更新不会改变正在运行任务的判定结果。
 */
export class AnalysisRulesService {
  private readonly currentPath: string;
  private readonly versionsDirectory: string;
  private statePromise?: Promise<{ rulePackage: AnalysisRulePackage; source: RuleSource }>;
  private lock: Promise<void> = Promise.resolve();

  public constructor(private readonly options: AnalysisRulesServiceOptions) {
    this.currentPath = join(options.directory, 'current.json');
    this.versionsDirectory = join(options.directory, 'versions');
    validateRulePackage(options.seed, options.runtimeVersion ?? '1.0.0');
  }

  public async getState(): Promise<{ currentVersion: string; source: RuleSource }> {
    const state = await this.loadState();
    return { currentVersion: state.rulePackage.version, source: state.source };
  }

  public async getSnapshot(): Promise<AnalysisRulePackage> {
    return structuredClone((await this.loadState()).rulePackage);
  }

  public async update(): Promise<{ status: 'updated' | 'up-to-date'; previousVersion: string; currentVersion: string }> {
    const previous = (await this.loadState()).rulePackage.version;
    if (new URL(this.options.catalogUrl).protocol !== 'https:') throw new Error('官方规则目录地址必须使用 HTTPS。');
    const catalog = parseCatalog(await this.download(this.options.catalogUrl, MAX_CATALOG_BYTES, '规则目录'));
    if (compareVersions(catalog.version, previous) <= 0) return { status: 'up-to-date', previousVersion: previous, currentVersion: previous };
    const bytes = await this.download(catalog.packageUrl, MAX_PACKAGE_BYTES, '规则包');
    const rulePackage = verifyRulePackage(bytes, catalog, this.options.trustedKeys, this.options.runtimeVersion ?? '1.0.0');
    return this.withLock(async () => {
      const current = await this.loadState();
      if (compareVersions(rulePackage.version, current.rulePackage.version) <= 0) return { status: 'up-to-date', previousVersion: current.rulePackage.version, currentVersion: current.rulePackage.version };
      await atomicWriteFile(join(this.versionsDirectory, `${rulePackage.version}.json`), bytes);
      await atomicWriteFile(this.currentPath, Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`));
      this.statePromise = Promise.resolve({ rulePackage, source: 'downloaded' });
      console.info(`分析中心规则已更新：${current.rulePackage.version} -> ${rulePackage.version}。`);
      return { status: 'updated', previousVersion: current.rulePackage.version, currentVersion: rulePackage.version };
    });
  }

  private async loadState(): Promise<{ rulePackage: AnalysisRulePackage; source: RuleSource }> {
    this.statePromise ??= this.loadStateFromDisk();
    return this.statePromise;
  }

  private async loadStateFromDisk(): Promise<{ rulePackage: AnalysisRulePackage; source: RuleSource }> {
    try {
      const catalog = parseCatalog(await readFile(this.currentPath));
      const bytes = await readFile(join(this.versionsDirectory, `${catalog.version}.json`));
      return { rulePackage: verifyRulePackage(bytes, catalog, this.options.trustedKeys, this.options.runtimeVersion ?? '1.0.0'), source: 'downloaded' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`已下载分析规则无法使用，回退到内置规则：${error instanceof Error ? error.message : String(error)}`);
      return { rulePackage: structuredClone(this.options.seed), source: 'bundled' };
    }
  }

  private async download(url: string, maximumBytes: number, label: string): Promise<Buffer> {
    let response: Response;
    let currentUrl = url;
    try {
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (new URL(currentUrl).protocol !== 'https:') throw new Error(`${label}地址必须使用 HTTPS。`);
        response = await (this.options.fetchImpl ?? fetch)(currentUrl, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (!location) throw new Error(`${label}重定向缺少目标地址。`);
        currentUrl = new URL(location, currentUrl).toString();
        if (redirects === 3) throw new Error(`${label}重定向次数超过上限。`);
      }
    }
    catch (error) { throw new Error(`${label}下载失败：${error instanceof Error ? error.message : String(error)}`); }
    if (new URL(response!.url || currentUrl).protocol !== 'https:') throw new Error(`${label}下载失败：最终地址必须使用 HTTPS。`);
    if (!response!.ok) throw new Error(`${label}下载失败：HTTP ${response!.status}。`);
    if (Number(response!.headers.get('content-length') ?? 0) > maximumBytes) throw new Error(`${label}超过允许的大小上限。`);
    const bytes = Buffer.from(await response!.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error(`${label}超过允许的大小上限。`);
    return bytes;
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
}

export function toAnalyzerRuleCatalog(rulePackage: AnalysisRulePackage): AnalyzerRuleCatalog {
  return {
    tgz: { version: rulePackage.version, files: structuredClone(rulePackage.formatRules.tgz.files) },
    zip: { version: rulePackage.version, files: structuredClone(rulePackage.formatRules.zip.files) }
  };
}

function parseCatalog(bytes: Uint8Array): RuleCatalog {
  if (bytes.byteLength > MAX_CATALOG_BYTES) throw new Error('规则目录超过允许的大小上限。');
  try { return catalogSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))); }
  catch (error) { throw new Error(`规则目录格式无效：${formatError(error)}`); }
}

function verifyRulePackage(bytes: Uint8Array, catalog: RuleCatalog, trustedKeys: Record<string, KeyObject | string>, runtimeVersion: string): AnalysisRulePackage {
  if (bytes.byteLength !== catalog.packageSize) throw new Error('规则包大小与目录不一致。');
  if (createHash('sha256').update(bytes).digest('hex') !== catalog.sha256) throw new Error('规则包 SHA-256 与目录不一致。');
  const key = trustedKeys[catalog.keyId];
  if (!key) throw new Error(`规则包签名密钥不受信任：${catalog.keyId}。`);
  if (!verify(null, bytes, key, decodeSignature(catalog.signature))) throw new Error('规则包 Ed25519 签名校验失败。');
  let rulePackage: AnalysisRulePackage;
  try { rulePackage = packageSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))); }
  catch (error) { throw new Error(`规则包格式无效：${formatError(error)}`); }
  if (rulePackage.version !== catalog.version) throw new Error('规则包版本与目录不一致。');
  validateRulePackage(rulePackage, runtimeVersion);
  return rulePackage;
}

function validateRulePackage(rulePackage: AnalysisRulePackage, runtimeVersion: string): void {
  if (compareVersions(rulePackage.minimumRuntimeVersion, runtimeVersion) > 0) throw new Error(`规则包需要分析中心规则运行时 ${rulePackage.minimumRuntimeVersion}，当前版本为 ${runtimeVersion}。`);
  assertUniqueIds(rulePackage.v1.eventRules.map((rule) => rule.id), '事件规则');
  assertUniqueIds(rulePackage.v1.findingRules.map((rule) => rule.type), 'Finding 规则类型');
  assertUniqueIds(rulePackage.v1.diagnosisRules.map((rule) => rule.id), '诊断规则');
  assertUniqueIds(rulePackage.v1.recommendations.map((rule) => rule.id), '建议');
  for (const rule of rulePackage.v1.findingRules) {
    assertSupportedFindingTemplate(rule.title);
    assertSupportedFindingTemplate(rule.summary);
  }
  const recommendationIds = new Set(rulePackage.v1.recommendations.map((rule) => rule.id));
  for (const rule of rulePackage.v1.diagnosisRules) {
    if (!(rule.all?.length || rule.any?.length || rule.sequence?.length)) throw new Error(`诊断规则 ${rule.id} 必须包含正向触发条件。`);
    for (const recommendationId of rule.recommendationIds) {
      if (!recommendationIds.has(recommendationId)) throw new Error(`诊断规则 ${rule.id} 引用了不存在的建议：${recommendationId}。`);
    }
  }
  for (const eventRule of rulePackage.v1.eventRules) {
    try { new RegExp(eventRule.regex, 'i'); } catch { throw new Error(`规则包事件正则无效：${eventRule.id}。`); }
  }
  for (const format of ['tgz', 'zip'] as const) for (const file of rulePackage.formatRules[format].files) {
    for (const pattern of file.file_patterns ?? []) try { new RegExp(pattern, 'i'); } catch { throw new Error(`规则包文件匹配正则无效：${format}/${file.name}。`); }
    for (const keyword of file.keywords) if (keyword.regex) try { new RegExp(keyword.term, 'i'); } catch { throw new Error(`规则包关键词正则无效：${format}/${file.name}/${keyword.term}。`); }
  }
}

/** 远程包中的同名规则会造成覆盖顺序不确定，必须在激活前拒绝。 */
function assertUniqueIds(ids: string[], label: string): void {
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error(`${label} ID 重复。`);
}

/** Finding 模板不解释表达式，只允许运行时已实现的只读字段。 */
function assertSupportedFindingTemplate(template: string): void {
  const allowedTokens = new Set(['resource', 'resourcePrefix', 'occurrenceCount', 'title']);
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (!allowedTokens.has(match[1]!)) throw new Error(`Finding 模板包含未支持的占位符：${match[0]}。`);
  }
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('规则包签名格式无效。');
  const signature = Buffer.from(value, 'base64');
  if (signature.byteLength !== 64 || signature.toString('base64') !== value) throw new Error('规则包签名格式无效。');
  return signature;
}

function compareVersions(left: string, right: string): number {
  const splitVersion = (value: string) => {
    const separator = value.indexOf('-');
    return separator < 0 ? { core: value, prerelease: undefined } : { core: value.slice(0, separator), prerelease: value.slice(separator + 1) };
  };
  const leftVersion = splitVersion(left); const rightVersion = splitVersion(right);
  const leftParts = leftVersion.core.split('.').map(Number); const rightParts = rightVersion.core.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (leftParts[index] !== rightParts[index]) return leftParts[index]! - rightParts[index]!;
  if (leftVersion.prerelease === rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  const leftIdentifiers = leftVersion.prerelease.split('.'); const rightIdentifiers = rightVersion.prerelease.split('.');
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    const leftIdentifier = leftIdentifiers[index]; const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier); const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`).join('；');
  return error instanceof Error ? error.message : String(error);
}

async function atomicWriteFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporaryPath, bytes); await rename(temporaryPath, path); }
  finally { await rm(temporaryPath, { force: true }); }
}
