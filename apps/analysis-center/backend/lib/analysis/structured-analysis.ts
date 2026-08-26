import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DiagnosticPackageFormat } from '../domain/diagnostic-package';
import type { AnalysisResult } from './log-analyzer';

export type HealthLevel = 'critical' | 'attention' | 'normal' | 'unknown';

/** 原始诊断包中的一条内存条，字段缺失时保留空字符串以便报告降级展示。 */
export interface MemoryModule {
  size: string;
  manufacturer: string;
  model: string;
}

/** 将 sysinfo.json 中不同版本的网卡快照规范化为报告使用的统一模型。 */
export interface NetworkInterfaceCard {
  name: string;
  mac: string;
  ipv4: string[];
  ipv6: string[];
  status: string;
  state: string;
  carrier: string;
  mtu: string;
}

/** SMART 属性保留原始字段，重点属性和完整属性表都从同一份数据渲染。 */
export interface SmartAttribute {
  id: number;
  name: string;
  value: string;
  worst: string;
  threshold: string;
  raw: string;
  status: string;
}

/** 原始模板要求的硬盘诊断摘要，兼容不同设备版本的字段命名。 */
export interface StorageDisk {
  name: string;
  label: string;
  device: string;
  usedFor: string;
  slot: string;
  model: string;
  serial: string;
  brand: string;
  interfaceType: string;
  capacity: string;
  temperature: string;
  powerOnHours: string;
  health: HealthLevel;
  smart: SmartAttribute[];
  evidence: string[];
}

export interface StructuredAnalysis {
  sysInfo: Record<string, unknown>;
  memory: MemoryModule[];
  blockDevicesRaw: string;
  blockDevices: string[];
  networks: NetworkInterfaceCard[];
  raids: string[];
  volumes: string[];
  disks: StorageDisk[];
  evidence: string[];
  overallHealth: HealthLevel;
  recommendations: string[];
  customerReply: string;
}

/**
 * 完整引擎的结构化阶段：将 sysinfo、存储快照和共享日志归并为原始报告模板需要的数据模型。
 * 解析器只负责规范化和降级，不把单个缺失字段升级为整份报告失败。
 */
export async function analyzeStructuredExtract(root: string, rules: AnalysisResult, archiveFormat: DiagnosticPackageFormat = 'tgz'): Promise<StructuredAnalysis> {
  const paths = await listFiles(root);
  const sysinfoPath = paths.find((path) => basename(path).toLowerCase() === 'sysinfo.json');
  const sysInfo = sysinfoPath ? await parseJson(sysinfoPath) : {};
  const textFiles = await Promise.all(paths.filter((path) => !path.endsWith('.json')).map(async (path) => ({ path, content: await readText(path, archiveFormat) })));
  const byName = (name: string) => textFiles.filter((item) => basename(item.path).toLowerCase().startsWith(name)).map((item) => item.content).join('\n');
  const blockDevicesRaw = byName('lsblk');
  const blockDevices = blockDevicesRaw.split(/\r?\n/).filter((line) => /^(NAME|\S+\s)/.test(line)).slice(0, 500);
  const networkText = [byName('ifconfig'), byName('ip_addr')].join('\n');
  const networks = extractNetworks(sysInfo, networkText);
  const raids = [byName('mdstat'), byName('mdadm')].join('\n').split(/\r?\n/).filter((line) => /^(md\d+|.*\[.*\])/.test(line)).slice(0, 200);
  const volumes = [byName('lvs'), byName('blkid'), byName('storage_serv')].join('\n').split(/\r?\n/).filter((line) => /\/dev\/|vg|lv|volume/i.test(line)).slice(0, 300);
  const logs = textFiles.filter((item) => isDiagnosticLogFile(basename(item.path), archiveFormat)).map((item) => item.content).join('\n');
  const evidence = logs.split(/\r?\n/).filter((line) => /I\/O error|Device not ready; aborting reset|Removing after probe failure|medium error|uncorrectable|hard resetting|read-only|EXT4-fs.*error|BTRFS error|No space left|SMART.*critical/i.test(line)).slice(0, 300);
  const disks = extractDisks(sysInfo, [byName('smartctl'), byName('nvme'), byName('smart')].join('\n'), evidence);
  const memory = extractMemory(sysInfo, byName('dmidecode'));
  const critical = evidence.some((line) => /I\/O error|medium error|uncorrectable|read-only|No space left/i.test(line)) || disks.some((disk) => disk.health === 'critical');
  const attention = !critical && (evidence.length > 0 || disks.some((disk) => disk.health === 'attention'));
  const overallHealth: HealthLevel = critical ? 'critical' : attention ? 'attention' : disks.length || rules.files.length ? 'normal' : 'unknown';
  const recommendations = critical ? ['立即备份关键数据。', '检查故障磁盘、线缆与 RAID 状态。', '请勿在未确认前执行会写入磁盘的修复操作。'] : attention ? ['持续观察日志与 SMART 变化。', '建议安排现场检查存储连接。'] : ['未发现明确存储故障，请结合现场状态继续观察。'];
  return { sysInfo, memory, blockDevicesRaw, blockDevices, networks, raids, volumes, disks, evidence, overallHealth, recommendations, customerReply: critical ? '检测到存储相关异常，建议尽快备份数据并安排工程师检查。' : '当前未检测到需要立即处理的严重存储风险。' };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'Report') result.push(...await listFiles(path));
    else if (entry.isFile() && (await stat(path)).size < 64 * 1024 * 1024) result.push(path);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function isDiagnosticLogFile(fileName: string, archiveFormat: DiagnosticPackageFormat): boolean {
  return archiveFormat === 'zip'
    ? /(?:.+_syslog|.+_dmsg\.log\.gz|nas_storage\.log\.\d+)$/i.test(fileName)
    : /^(kern|syslog|journal|dmesg)/i.test(fileName);
}

async function readText(path: string, archiveFormat: DiagnosticPackageFormat): Promise<string> {
  try {
    const content = await readFile(path);
    return archiveFormat === 'zip' && path.toLowerCase().endsWith('.gz') ? gunzipSync(content).toString('utf8') : content.toString('utf8');
  } catch (error) {
    console.error(`读取结构化日志失败，已跳过文件：${path}；原因：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

async function parseJson(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isObject(value) ? value : {};
  } catch (error) {
    console.error(`解析 sysinfo.json 失败，已使用空结构化数据继续生成报告：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function extractMemory(info: Record<string, unknown>, dmi: string): MemoryModule[] {
  const modules: MemoryModule[] = [];
  for (const value of findValues(info, ['memory', 'memory_info', 'memory_devices', 'memory_modules', 'ram'])) collectMemoryModules(value, modules);
  collectDmiMemory(dmi, modules);
  return deduplicateMemory(modules);
}

function collectMemoryModules(value: unknown, output: MemoryModule[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMemoryModules(item, output));
    return;
  }
  if (!isObject(value)) return;
  const module = parseMemoryModule(value);
  if (module) output.push(module);
  ['items', 'list', 'devices', 'modules', 'memory_devices'].forEach((key) => {
    const nested = directValue(value, [key]);
    if (nested !== undefined) collectMemoryModules(nested, output);
  });
}

function parseMemoryModule(value: Record<string, unknown>): MemoryModule | null {
  const module = {
    size: firstString(value, ['size', 'memory_size']),
    manufacturer: firstString(value, ['manufacturer', 'vendor', 'brand']),
    model: firstString(value, ['model', 'part_number', 'partNumber'])
  };
  return module.size && !/^no module installed$/i.test(module.size) ? module : null;
}

function collectDmiMemory(content: string, output: MemoryModule[]): void {
  if (!content) return;
  let current: MemoryModule | null = null;
  const flush = () => {
    if (current?.size && !/^no module installed$/i.test(current.size)) output.push(current);
    current = null;
  };
  content.split(/\r?\n/).forEach((line) => {
    if (/Memory Device/i.test(line)) {
      flush();
      current = { size: '', manufacturer: '', model: '' };
      return;
    }
    if (!current) return;
    const match = line.match(/^\s*(Size|Manufacturer|Part Number|Model):\s*(.+?)\s*$/i);
    if (!match) return;
    const field = match[1].toLowerCase();
    if (field === 'size') current.size = match[2];
    else if (field === 'manufacturer') current.manufacturer = match[2];
    else current.model = match[2];
  });
  flush();
}

function deduplicateMemory(modules: MemoryModule[]): MemoryModule[] {
  const seen = new Set<string>();
  return modules.filter((module) => {
    const key = `${module.size}\u0000${module.manufacturer}\u0000${module.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractNetworks(info: Record<string, unknown>, raw: string): NetworkInterfaceCard[] {
  const networks: NetworkInterfaceCard[] = [];
  findValues(info, ['network', 'network_info']).forEach((network) => {
    findValues(network, ['interface', 'interfaces']).forEach((value) => collectNetworkCards(value, networks));
  });
  return networks.length > 0 ? deduplicateNetworks(networks) : parseNetworkText(raw);
}

function collectNetworkCards(value: unknown, output: NetworkInterfaceCard[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNetworkCards(item, output));
    return;
  }
  if (!isObject(value)) return;
  const running = firstValue(value, ['is_running', 'running', 'up']);
  const isRunning = running === undefined ? undefined : toBoolean(running);
  output.push({
    name: firstString(value, ['name', 'interface']),
    mac: firstString(value, ['mac', 'hardware_address']),
    ipv4: stringValues(firstValue(value, ['ipv4'])),
    ipv6: stringValues(firstValue(value, ['ipv6'])),
    status: isRunning === undefined ? '未知' : isRunning ? '正常' : '未连接',
    state: isRunning === undefined ? '未知' : isRunning ? 'UP' : 'DOWN',
    carrier: isRunning === undefined ? '' : isRunning ? 'CARRIER' : 'NO-CARRIER',
    mtu: firstString(value, ['mtu'])
  });
}

function parseNetworkText(raw: string): NetworkInterfaceCard[] {
  const cards = new Map<string, NetworkInterfaceCard>();
  let current = '';
  raw.split(/\r?\n/).forEach((line) => {
    const header = line.match(/^\s*(\w[\w.-]*):?\s+(?:flags=|Link encap|[\w-]+:)/i);
    if (header) {
      current = header[1];
      cards.set(current, { name: current, mac: '', ipv4: [], ipv6: [], status: '未知', state: '未知', carrier: '', mtu: '' });
    }
    if (!current) return;
    const card = cards.get(current);
    if (!card) return;
    const mac = line.match(/(?:ether|HWaddr)\s+([0-9a-f:.-]+)/i);
    const ipv4 = line.match(/\binet\s+(?:addr:)?([0-9.]+)/i);
    const ipv6 = line.match(/\binet6\s+(?:addr:)?([0-9a-f:]+)(?:\/\d+)?/i);
    const mtu = line.match(/\bmtu\s+(\d+)/i);
    if (mac) card.mac = mac[1];
    if (ipv4 && !card.ipv4.includes(ipv4[1])) card.ipv4.push(ipv4[1]);
    if (ipv6 && !card.ipv6.includes(ipv6[1])) card.ipv6.push(ipv6[1]);
    if (mtu) card.mtu = mtu[1];
    if (/\bUP\b/i.test(line)) { card.status = '正常'; card.state = 'UP'; }
    else if (/\bDOWN\b/i.test(line)) { card.status = '未连接'; card.state = 'DOWN'; }
  });
  return [...cards.values()];
}

function deduplicateNetworks(networks: NetworkInterfaceCard[]): NetworkInterfaceCard[] {
  const seen = new Set<string>();
  return networks.filter((network) => {
    const key = `${network.name}\u0000${network.mac}\u0000${network.mtu}`;
    if (!network.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractDisks(info: Record<string, unknown>, smartText: string, evidence: string[]): StorageDisk[] {
  const disks: StorageDisk[] = [];
  findValues(info, ['disk_info', 'disks', 'disk']).forEach((value) => collectDiskSummaries(value, disks));
  findDeviceDisks(info, disks);
  const normalized = deduplicateDisks(disks).map((disk) => attachDiskEvidence(disk, evidence));
  if (normalized.length > 0) return normalized;

  const json = JSON.stringify(info);
  const devices = [...json.matchAll(/"(?:dev_name|device|name)"\s*:\s*"([^"/]*(?:\/dev\/)?[^",}]*)"/gi)]
    .map((match) => match[1])
    .filter((value) => /sd|nvme|disk/i.test(value));
  return [...new Set(devices)].slice(0, 32).map((device) => attachDiskEvidence({
    name: device.replace(/^\/dev\//, ''), label: '', device, usedFor: '', slot: '', model: '', serial: '', brand: '', interfaceType: '', capacity: '', temperature: '', powerOnHours: '', health: 'normal', smart: parseSmartText(smartText), evidence: []
  }, evidence));
}

function collectDiskSummaries(value: unknown, output: StorageDisk[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDiskSummaries(item, output));
    return;
  }
  if (!isObject(value)) return;
  const disk = parseDisk(value);
  if (disk) output.push(disk);
  ['items', 'list', 'devices', 'disks'].forEach((key) => {
    const nested = directValue(value, [key]);
    if (nested !== undefined) collectDiskSummaries(nested, output);
  });
}

function findDeviceDisks(value: unknown, output: StorageDisk[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => findDeviceDisks(item, output));
    return;
  }
  if (!isObject(value)) return;
  const diskInfo = directValue(value, ['disk_info']);
  if (diskInfo !== undefined) {
    const nested: StorageDisk[] = [];
    collectDiskSummaries(diskInfo, nested);
    const smartInfo = directValue(value, ['smart_info']);
    const smart = smartInfo === undefined ? [] : collectSmartAttributes(smartInfo);
    nested.forEach((disk) => {
      if (smart.length > 0) disk.smart = deduplicateSmart([...disk.smart, ...smart]);
      output.push(disk);
    });
  }
  Object.values(value).forEach((child) => findDeviceDisks(child, output));
}

function parseDisk(value: Record<string, unknown>): StorageDisk | null {
  const disk: StorageDisk = {
    name: firstString(value, ['name']),
    label: firstString(value, ['label']),
    device: firstString(value, ['dev_name', 'device_name', 'device_path', 'device']),
    usedFor: firstString(value, ['used_for', 'usage']),
    slot: firstString(value, ['slot']),
    model: firstString(value, ['model']),
    serial: firstString(value, ['serial']),
    brand: firstString(value, ['brand', 'manufacturer']),
    interfaceType: firstString(value, ['interface_type', 'interface']),
    capacity: formatCapacity(firstValue(value, ['size', 'capacity'])),
    temperature: firstString(value, ['temperature', 'temp']),
    powerOnHours: formatPowerOnHours(firstValue(value, ['power_on_hours', 'powerOnHours'])),
    health: normalizeDiskHealth(firstValue(value, ['health', 'status'])),
    smart: deduplicateSmart(findValues(value, ['smart', 'smart_attributes', 'attributes']).flatMap(collectSmartAttributes)),
    evidence: []
  };
  if (!disk.name && !disk.label && !disk.device && !disk.usedFor && !disk.slot && !disk.model && !disk.serial && disk.smart.length === 0) return null;
  if (disk.smart.some(isSmartRisk)) disk.health = 'critical';
  return disk;
}

function attachDiskEvidence(disk: StorageDisk, evidence: string[]): StorageDisk {
  const tokens = [disk.device, disk.name, disk.label].filter(Boolean).map((value) => value.replace(/^\/dev\//, ''));
  const related = evidence.filter((line) => tokens.some((token) => line.includes(token)));
  return { ...disk, evidence: related };
}

function deduplicateDisks(disks: StorageDisk[]): StorageDisk[] {
  const seen = new Set<string>();
  return disks.filter((disk) => {
    const key = `${disk.name}\u0000${disk.label}\u0000${disk.slot}\u0000${disk.model}\u0000${disk.serial}\u0000${disk.device}`;
    if (!key.replaceAll('\u0000', '')) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectSmartAttributes(value: unknown): SmartAttribute[] {
  const output: SmartAttribute[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (!isObject(current)) return;
    const attribute = parseSmartAttribute(current);
    if (attribute) output.push(attribute);
    Object.values(current).forEach(visit);
  };
  visit(value);
  return deduplicateSmart(output);
}

function parseSmartText(content: string): SmartAttribute[] {
  return [...content.matchAll(/(?:ID#|\bid\b)\s*[:#]?\s*(\d+)\s+([^\n]+)/gi)].slice(0, 64).map((match) => {
    const raw = match[2].trim().slice(-40);
    return { id: Number(match[1]), name: match[2].trim().slice(0, 80), value: '', worst: '', threshold: '', raw, status: /fail|critical|warning/i.test(match[2]) ? '风险' : '正常' };
  });
}

function parseSmartAttribute(value: Record<string, unknown>): SmartAttribute | null {
  const id = Number(firstString(value, ['id', 'ID', 'attribute_id']));
  const raw = firstString(value, ['raw_string', 'raw', 'raw_value', 'rawValue', 'raw_val']);
  const name = firstString(value, ['name', 'attribute', 'label']);
  if (!id && !name && !raw) return null;
  const sourceStatus = firstValue(value, ['status']);
  return {
    id,
    name,
    value: firstString(value, ['value', 'current']),
    worst: firstString(value, ['worst']),
    threshold: firstString(value, ['threshold', 'thresh']),
    raw,
    status: normalizeSmartStatus(id, raw, sourceStatus)
  };
}

function deduplicateSmart(attributes: SmartAttribute[]): SmartAttribute[] {
  const seen = new Set<string>();
  return attributes.filter((attribute) => {
    const key = `${attribute.id}\u0000${attribute.name}\u0000${attribute.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSmartRisk(attribute: SmartAttribute): boolean {
  if (/风险|异常|fail|critical|warning/i.test(attribute.status)) return true;
  return [5, 197, 198].includes(attribute.id) && Number.parseInt(attribute.raw, 10) > 0;
}

function normalizeSmartStatus(id: number, raw: string, source: unknown): string {
  if ([5, 197, 198].includes(id)) {
    const numericRaw = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(numericRaw)) return numericRaw === 0 ? '正常' : '风险';
    return '未知';
  }
  const value = asString(source).trim().toLowerCase();
  if (!value) return '普通';
  if (['1', 'ok', 'normal', '正常'].includes(value)) return '正常';
  if (['0', 'unknown', '未知'].includes(value)) return '未知';
  if (['risk', 'warning', 'failed', '风险', '警告'].includes(value)) return '风险';
  return asString(source);
}

function normalizeDiskHealth(value: unknown): HealthLevel {
  const text = asString(value).trim().toLowerCase();
  if (['1', 'ok', 'normal', 'healthy', '正常'].includes(text)) return 'normal';
  if (['0', 'unknown', '未知', ''].includes(text)) return 'unknown';
  if (['risk', 'failed', 'critical', '异常', '风险'].includes(text)) return 'critical';
  if (['warning', 'attention', '警告', '关注'].includes(text)) return 'attention';
  return 'unknown';
}

function formatCapacity(value: unknown): string {
  const raw = asString(value).trim();
  if (!raw) return '';
  if (/[a-zA-Z]/.test(raw)) return raw;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return raw;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let normalized = number;
  while (normalized >= 1024 && unitIndex < units.length - 1) { normalized /= 1024; unitIndex += 1; }
  return `${unitIndex === 0 ? normalized.toFixed(0) : normalized.toFixed(2)} ${units[unitIndex]}`;
}

function formatPowerOnHours(value: unknown): string {
  const raw = asString(value).trim();
  if (!raw) return '';
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return raw;
  return `${Math.floor(hours / 24)} 天 ${Math.floor(hours % 24)} 小时`;
}

function directValue(value: unknown, keys: string[]): unknown {
  if (!isObject(value)) return undefined;
  const wanted = keys.map((key) => key.toLowerCase());
  const entry = Object.entries(value).find(([key]) => wanted.includes(key.toLowerCase()));
  return entry?.[1];
}

function firstValue(value: unknown, keys: string[]): unknown {
  const direct = directValue(value, keys);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstValue(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const child of Object.values(value)) {
    const found = firstValue(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findValues(value: unknown, keys: string[]): unknown[] {
  const wanted = keys.map((key) => key.toLowerCase());
  const result: unknown[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(walk); return; }
    if (!isObject(current)) return;
    Object.entries(current).forEach(([key, child]) => {
      if (wanted.includes(key.toLowerCase())) result.push(child);
      walk(child);
    });
  };
  walk(value);
  return result;
}

function firstString(value: unknown, keys: string[]): string {
  return asString(firstValue(value, keys));
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).map((item) => item.trim()).filter(Boolean);
  return asString(value).split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = asString(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'up' || text === 'running';
}
