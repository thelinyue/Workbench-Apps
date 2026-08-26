import { createWriteStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import yazl from 'yazl';

const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const FIXED_FILE_MODE = 0o100664;

/**
 * 以稳定的文件顺序、时间和权限生成 ZIP，避免构建机器的文件系统元数据进入发布哈希。
 * 应用 ZIP 的内容哈希会写入 Catalog，因此同一源码必须产生同一字节序列。
 */
export async function createDeterministicZip(sourceRoot, outputPath) {
  const zip = new yazl.ZipFile();
  const files = await listFiles(sourceRoot, outputPath);
  files.sort((left, right) => zipPath(sourceRoot, left).localeCompare(zipPath(sourceRoot, right)));
  for (const file of files) {
    zip.addFile(file, zipPath(sourceRoot, file), {
      mtime: FIXED_MTIME,
      forceDosTimestamp: true,
      mode: FIXED_FILE_MODE
    });
  }
  await new Promise((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(outputPath)).on('close', resolve).on('error', reject);
    zip.on('error', reject);
    zip.end();
  });
}

async function listFiles(directory, excludedPath) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (file === excludedPath) continue;
    if (entry.isDirectory()) files.push(...await listFiles(file, excludedPath));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function zipPath(sourceRoot, file) {
  return relative(sourceRoot, file).replaceAll('\\', '/');
}
