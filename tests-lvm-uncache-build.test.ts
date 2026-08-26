import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('LVM 应用构建产物', () => {
  it('相同源码重复构建时生成相同 ZIP SHA-256', async () => {
    await execFileAsync(process.execPath, ['tools/build-lvm-uncache-tool.mjs'], { cwd: process.cwd() });
    const first = JSON.parse(await readFile('apps/lvm-uncache-tool/dist/release.json', 'utf8')) as { sha256: string };
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await execFileAsync(process.execPath, ['tools/build-lvm-uncache-tool.mjs'], { cwd: process.cwd() });
    const second = JSON.parse(await readFile('apps/lvm-uncache-tool/dist/release.json', 'utf8')) as { sha256: string };

    expect(second.sha256).toBe(first.sha256);
  }, 30_000);
});
