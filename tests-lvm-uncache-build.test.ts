import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('LVM 应用构建产物', () => {
  it('构建入口保留可由 workbench-app 协议解析的相对 CSS 和 JS 资源', async () => {
    await execFileAsync(process.execPath, ['tools/build-lvm-uncache-tool.mjs'], { cwd: process.cwd() });
    const rendererDirectory = resolve('apps/lvm-uncache-tool/dist/renderer');
    const entry = await readFile(resolve(rendererDirectory, 'index.html'), 'utf8');
    const references = [...entry.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);

    expect(references.length).toBe(2);
    expect(references.every((reference) => reference.startsWith('../assets/'))).toBe(true);
    await Promise.all(references.map((reference) => access(resolve(rendererDirectory, reference))));
    await expect(access(resolve(rendererDirectory, 'icon.svg'))).resolves.toBeUndefined();
  }, 30_000);

  it('相同源码重复构建时生成相同 ZIP SHA-256', async () => {
    await execFileAsync(process.execPath, ['tools/build-lvm-uncache-tool.mjs'], { cwd: process.cwd() });
    const first = JSON.parse(await readFile('apps/lvm-uncache-tool/dist/release.json', 'utf8')) as { sha256: string };
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await execFileAsync(process.execPath, ['tools/build-lvm-uncache-tool.mjs'], { cwd: process.cwd() });
    const second = JSON.parse(await readFile('apps/lvm-uncache-tool/dist/release.json', 'utf8')) as { sha256: string };

    expect(second.sha256).toBe(first.sha256);
  }, 30_000);
});
