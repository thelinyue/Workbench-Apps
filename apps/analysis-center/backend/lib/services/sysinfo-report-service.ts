import { lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DiagnosticPackage } from '../domain/diagnostic-package';
import { parseDmidecodeMemory } from '../parsers/dmidecode-memory';
import { normalizeSysinfo, renderSysinfoReport, SYSINFO_REPORT_FORMAT_VERSION } from '../reports/sysinfo-report';

type SysinfoReportPackage = Pick<DiagnosticPackage, 'extractPath' | 'displayName'>;

/**
 * 完整 sysinfo 报告的文件系统边界。
 *
 * Renderer 只提交 packageId，调用方先从私有数据库取得诊断包记录，再把受信任的解压目录
 * 交给本服务。服务不接受任意源路径，并且只遍历解压目录内的普通目录和普通文件，避免通过
 * 符号链接读取包外文件。报告固定写回解压根目录，不引入新的数据库路径字段。
 */
export class SysinfoReportService {
  public async getReportPath(diagnosticPackage: SysinfoReportPackage): Promise<string> {
    const extractionRoot = resolve(diagnosticPackage.extractPath);
    const reportPath = resolve(extractionRoot, 'sysinfo-report.html');
    assertInside(extractionRoot, reportPath);

    try {
      const rootStat = await stat(extractionRoot).catch(() => undefined);
      if (!rootStat?.isDirectory()) throw new Error('诊断包解压目录已不存在，无法查看完整 sysinfo。');
      const candidates = await findReportSources(extractionRoot, extractionRoot);
      const sourcePath = candidates.sysinfo.sort((left, right) => compareCandidate(extractionRoot, left, right))[0];
      if (!sourcePath) throw new Error('该诊断包未包含 sysinfo.json。');
      const dmidecodePath = candidates.dmidecode.sort((left, right) => compareCandidate(extractionRoot, left, right))[0];
      const lsblkPath = candidates.lsblk.sort((left, right) => compareCandidate(extractionRoot, left, right))[0];
      assertInside(extractionRoot, sourcePath);
      if (dmidecodePath) assertInside(extractionRoot, dmidecodePath);
      if (lsblkPath) assertInside(extractionRoot, lsblkPath);

      // 必须检查目录项本身，不能用会跟随链接的 stat，否则诊断包可把固定输出名指向包外文件。
      const [sourceStat, dmidecodeStat, reportStat] = await Promise.all([
        stat(sourcePath),
        dmidecodePath ? stat(dmidecodePath) : undefined,
        lstatIfExists(reportPath)
      ]);
      if (reportStat?.isSymbolicLink()) throw new Error('sysinfo 报告输出路径不能是符号链接。');
      const lsblkStat = lsblkPath ? await stat(lsblkPath) : undefined;
      const newestSourceMtime = Math.max(sourceStat.mtimeMs, dmidecodeStat?.mtimeMs ?? 0, lsblkStat?.mtimeMs ?? 0);
      if (reportStat?.isFile() && reportStat.mtimeMs >= newestSourceMtime && await isCurrentReportFormat(reportPath)) return reportPath;

      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(`sysinfo.json 格式无效：${error instanceof Error ? error.message : String(error)}`);
      }
      let dmidecode = '';
      if (dmidecodePath) {
        try {
          dmidecode = await readFile(dmidecodePath, 'utf8');
        } catch (error) {
          throw new Error(`无法读取 dmidecode 内存信息：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      let lsblk = '';
      if (lsblkPath) {
        try {
          lsblk = await readFile(lsblkPath, 'utf8');
        } catch (error) {
          throw new Error(`无法读取 lsblk 块设备信息：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const html = renderSysinfoReport(normalizeSysinfo(raw, parseDmidecodeMemory(dmidecode), lsblk), { packageName: diagnosticPackage.displayName, generatedAt: new Date() });
      await writeFile(reportPath, html, 'utf8');
      return reportPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`生成完整 sysinfo 报告失败：${message}`);
      throw error instanceof Error ? error : new Error(message);
    }
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 旧版本报告可能比源文件更新，必须检查格式标记后才能复用缓存。 */
async function isCurrentReportFormat(path: string): Promise<boolean> {
  try {
    const html = await readFile(path, 'utf8');
    return html.includes(`<meta name="sysinfo-report-format" content="${SYSINFO_REPORT_FORMAT_VERSION}">`);
  } catch {
    return false;
  }
}

interface ReportSourceCandidates {
  sysinfo: string[];
  dmidecode: string[];
  lsblk: string[];
}

/** 单次遍历收集报告依赖，避免为每种文件重复扫描大型诊断包。 */
async function findReportSources(root: string, directory: string): Promise<ReportSourceCandidates> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取诊断包解压目录：${error instanceof Error ? error.message : String(error)}`);
  }
  const result: ReportSourceCandidates = { sysinfo: [], dmidecode: [], lsblk: [] };
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    assertInside(root, path);
    if (entry.isDirectory()) {
      const nested = await findReportSources(root, path);
      result.sysinfo.push(...nested.sysinfo);
      result.dmidecode.push(...nested.dmidecode);
      result.lsblk.push(...nested.lsblk);
    } else if (entry.isFile()) {
      const name = basename(entry.name).toLowerCase();
      if (name === 'sysinfo.json') result.sysinfo.push(path);
      else if (name === 'dmidecode' || name === 'dmidecode.log') result.dmidecode.push(path);
      else if (name === 'lsblk' || name === 'lsblk.log') result.lsblk.push(path);
    }
  }
  return result;
}

function compareCandidate(root: string, left: string, right: string): number {
  const leftRelative = relative(root, left);
  const rightRelative = relative(root, right);
  const depthDifference = leftRelative.split(sep).length - rightRelative.split(sep).length;
  return depthDifference || leftRelative.localeCompare(rightRelative);
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) return;
  throw new Error('sysinfo 报告路径超出诊断包解压目录。');
}
