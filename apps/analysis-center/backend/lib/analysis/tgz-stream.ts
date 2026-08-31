import { createGunzip, type Gunzip } from 'node:zlib';

/**
 * Electron Worker 使用 zlib 默认 16 KB 输出块时会产生高频跨线程调度；诊断包通常解压到
 * 数百 MB，因此统一使用 1 MiB 输出块，在不一次性载入归档的前提下恢复顺序解压吞吐。
 */
export function createDiagnosticArchiveGunzip(): Gunzip {
  return createGunzip({ chunkSize: 1024 * 1024 });
}
