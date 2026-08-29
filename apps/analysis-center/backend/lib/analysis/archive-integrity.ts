import * as tar from 'tar';

export const INVALID_DIAGNOSTIC_ARCHIVE_MESSAGE = '诊断包文件不完整或已损坏，请重新导出或重新下载后再导入。';

/**
 * 在分析任务入队前完整读取 gzip/tar 归档，尽早发现下载未完成或文件被截断的问题。
 * 这里只校验归档，不会解压、修改或删除用户的原始诊断包。
 */
export async function assertDiagnosticArchiveIntegrity(sourcePath: string): Promise<void> {
  try {
    await tar.t({ file: sourcePath, gzip: true, strict: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`诊断包完整性校验失败：${sourcePath}：${detail}`);
    if (isMissingFileError(error)) throw new Error('诊断包文件不存在或无法读取，请确认文件仍然存在。');
    throw new Error(INVALID_DIAGNOSTIC_ARCHIVE_MESSAGE);
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
