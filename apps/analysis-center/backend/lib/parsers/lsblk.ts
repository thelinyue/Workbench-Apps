export interface LsblkDeviceRow {
  name: string;
  depth: number;
  majorMinor: string;
  removable: string;
  size: string;
  readOnly: string;
  type: string;
  mountpoints: string[];
}

interface HeaderPositions {
  mountpointsStart: number;
}

/**
 * 解析 lsblk 默认树形输出。
 *
 * lsblk 的设备名称和树枝字符位于 NAME 列，不能简单按固定宽度读取整行：长容量值可能
 * 撑开列宽。这里先校验表头，再用主次设备号定位设备名并按标准字段顺序读取，保留层级。
 */
export function parseLsblk(content: string): LsblkDeviceRow[] {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /\bNAME\b/.test(line) && /\bMAJ:MIN\b/.test(line) && /\bTYPE\b/.test(line));
  if (headerIndex < 0) return [];
  const positions = findHeaderPositions(lines[headerIndex]);
  if (!positions) return [];

  const rows: LsblkDeviceRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const row = parseDeviceLine(line, positions);
    if (row) {
      rows.push(row);
      continue;
    }
    const mountpoint = line.slice(positions.mountpointsStart).trim();
    if (rows.length > 0 && line.slice(0, positions.mountpointsStart).trim() === '' && mountpoint) {
      rows[rows.length - 1].mountpoints.push(mountpoint);
    }
  }
  return rows;
}

/** 按 sysinfo 已识别的物理盘筛选根节点，并保留每个根节点的所有树形后代。 */
export function selectStorageBlockDevices(rows: LsblkDeviceRow[], sysinfoDeviceNames: string[]): LsblkDeviceRow[] {
  const allowed = new Set(sysinfoDeviceNames.map(normalizeDeviceName).filter(Boolean));
  const selected: LsblkDeviceRow[] = [];
  let selectedRootDepth: number | undefined;
  for (const row of rows) {
    if (row.depth === 0 && allowed.has(normalizeDeviceName(row.name))) {
      selectedRootDepth = row.depth;
      selected.push(row);
      continue;
    }
    if (selectedRootDepth !== undefined && row.depth > selectedRootDepth) {
      selected.push(row);
      continue;
    }
    selectedRootDepth = undefined;
  }
  return selected;
}

function findHeaderPositions(header: string): HeaderPositions | undefined {
  const tokens = [...header.matchAll(/\S+/g)].map((match) => ({ name: match[0].toUpperCase(), start: match.index ?? 0 }));
  const has = (names: string[]) => tokens.some((token) => names.includes(token.name));
  const mountpoints = tokens.find((token) => ['MOUNTPOINTS', 'MOUNTPOINT'].includes(token.name));
  if (!has(['NAME']) || !has(['MAJ:MIN']) || !has(['RM']) || !has(['SIZE']) || !has(['RO']) || !has(['TYPE']) || !mountpoints) return undefined;
  return { mountpointsStart: mountpoints.start };
}

function parseDeviceLine(line: string, positions: HeaderPositions): LsblkDeviceRow | undefined {
  const majorMatch = line.match(/\d+:\d+/);
  if (!majorMatch || majorMatch.index === undefined) return undefined;
  const rawName = line.slice(0, majorMatch.index).replace(/\s+$/, '');
  if (!rawName.trim()) return undefined;
  const marker = rawName.match(/(├─|└─|\|-|`-)/);
  const name = (marker ? rawName.slice((marker.index ?? 0) + marker[0].length) : rawName).trim();
  if (!name) return undefined;
  const depth = marker ? Math.floor((marker.index ?? 0) / 2) + 1 : 0;
  const fields = line.slice(majorMatch.index + majorMatch[0].length).trim().split(/\s+/);
  if (fields.length < 4) return undefined;
  const [removable, size, readOnly, type, ...mountpoints] = fields;
  return {
    name,
    depth,
    majorMinor: majorMatch[0],
    removable,
    size,
    readOnly,
    type,
    mountpoints
  };
}

function normalizeDeviceName(value: string): string {
  return value.trim().replace(/^\/dev\//i, '');
}
