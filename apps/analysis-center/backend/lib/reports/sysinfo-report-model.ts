import type { MemoryModule } from '../parsers/dmidecode-memory';

export interface SysinfoSystemOverview {
  deviceName: string;
  serialNumber: string;
  systemVersion: string;
  platform: string;
}

export interface SysinfoNetworkInterface {
  name: string;
  running?: boolean;
  mac: string;
  ipv4: string[];
  ipv6: string[];
  mtu: string;
}

export interface SysinfoSmartAttribute {
  /** 数值 ID 用于识别重点属性；sourceId 保留 sysinfo 的原始十进制展示值。 */
  id: number;
  sourceId: string;
  name: string;
  current: string;
  worst: string;
  threshold: string;
  raw: string;
  sourceStatus: string;
}

export interface SysinfoDisk {
  label: string;
  name: string;
  device: string;
  usedFor: string;
  slot: string;
  model: string;
  serial: string;
  brand: string;
  interfaceType: string;
  sizeBytes?: number;
  sizeSource: string;
  temperature: string;
  powerOnHours: string;
  sourceStatus: string;
  smart: SysinfoSmartAttribute[];
  keySmart: SysinfoSmartAttribute[];
}

export interface SysinfoStoragePool {
  name: string;
  diskCount: number;
  totalSizeBytes?: number;
  disks: SysinfoDisk[];
}

export interface SysinfoReportModel {
  system: SysinfoSystemOverview;
  memory: MemoryModule[];
  networks: SysinfoNetworkInterface[];
  storagePools: SysinfoStoragePool[];
  raw: Record<string, unknown>;
}

/**
 * sysinfo 报告的规范化边界。
 *
 * 这里不复用诊断引擎的数据模型：诊断引擎会根据规则形成风险判断，而完整 sysinfo 报告
 * 只负责忠实展示采集快照。除容量合计和 used_for 分组外，不从字段组合推导 RAID、健康分
 * 或新的故障结论，避免可视化页面与正式诊断结果出现语义冲突。
 */
export function normalizeSysinfo(value: unknown, memory: MemoryModule[] = []): SysinfoReportModel {
  if (!isRecord(value)) throw new Error('sysinfo.json 顶层必须是 JSON 对象。');
  const network = record(value.network);
  const disk = record(value.disk);
  const networks = array(network.interface).filter(isRecord).map(normalizeNetwork);
  const disks = array(disk.devices).filter(isRecord).map(normalizeDisk).filter((item): item is SysinfoDisk => Boolean(item));
  const pools = new Map<string, SysinfoDisk[]>();
  for (const item of disks) {
    const name = item.usedFor || '未分配存储池';
    pools.set(name, [...(pools.get(name) ?? []), item]);
  }

  return {
    system: {
      deviceName: text(value.deviceName),
      serialNumber: text(value.sn),
      systemVersion: text(value.systemVersion),
      platform: text(value.platform)
    },
    memory,
    networks,
    storagePools: [...pools].map(([name, poolDisks]) => {
      const sizes = poolDisks.map((item) => item.sizeBytes).filter((size): size is number => size !== undefined);
      return { name, diskCount: poolDisks.length, totalSizeBytes: sizes.length > 0 ? sizes.reduce((sum, size) => sum + size, 0) : undefined, disks: poolDisks };
    }),
    raw: value
  };
}

function normalizeNetwork(value: Record<string, unknown>): SysinfoNetworkInterface {
  const details = record(value.NetInterface);
  return {
    name: text(value.name),
    running: typeof value.is_running === 'boolean' ? value.is_running : undefined,
    mac: text(value.mac),
    ipv4: strings(value.ipv4),
    ipv6: strings(value.ipv6),
    mtu: text(value.mtu ?? details.MTU)
  };
}

/** 同级 smart_info 必须与当前 disk_info 绑定，不能在全局递归后按数组顺序猜测归属。 */
function normalizeDisk(value: Record<string, unknown>): SysinfoDisk | undefined {
  const info = record(value.disk_info);
  if (Object.keys(info).length === 0) return undefined;
  const smart = array(record(value.smart_info).report).filter(isRecord).map(normalizeSmart);
  const size = numeric(info.size);
  return {
    label: text(info.label),
    name: text(info.name),
    device: text(info.dev_name),
    usedFor: text(info.used_for),
    slot: text(info.slot),
    model: text(info.model),
    serial: text(info.serial),
    brand: text(info.brand),
    interfaceType: text(info.interface_type),
    sizeBytes: size,
    sizeSource: text(info.size),
    temperature: text(info.temperature),
    powerOnHours: text(info.power_on_hours),
    sourceStatus: text(info.status),
    smart,
    keySmart: smart.filter((attribute) => [5, 197, 198].includes(attribute.id) || sourceMarksAbnormal(attribute.sourceStatus))
  };
}

function normalizeSmart(value: Record<string, unknown>): SysinfoSmartAttribute {
  return {
    id: numeric(value.id) ?? 0,
    sourceId: text(value.id),
    name: text(value.name || value.label),
    current: text(value.value ?? value.current),
    worst: text(value.worst),
    threshold: text(value.thresh ?? value.threshold),
    raw: text(value.raw_string ?? value.raw ?? value.raw_value),
    sourceStatus: text(value.status)
  };
}

function sourceMarksAbnormal(value: string): boolean {
  return /fail|warn|error|critical|bad|abnormal|异常|风险|故障/i.test(value);
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function numeric(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
