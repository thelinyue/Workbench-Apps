import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SSH 终端应用发布配置', () => {
  it('以 terminal 标识构建独立运行时应用包', () => {
    const manifestPath = resolve(process.cwd(), 'apps/terminal/manifest.json');
    const buildPath = resolve(process.cwd(), 'tools/build-terminal.mjs');

    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(buildPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const buildSource = readFileSync(buildPath, 'utf8');
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'terminal',
      runtime: { rendererEntry: 'renderer/index.html', backendEntry: 'backend/entry.js' },
      capabilities: ['ssh.credentials', 'file.open', 'file.save', 'clipboard.read', 'clipboard.write']
    });
    expect(buildSource).toContain('getReleaseAssetName(manifest.id,manifest.version)');
    expect(buildSource).toContain('getReleaseUrl(manifest.id,manifest.version)');
  });

  it('准备 2.0.0 并为 workbench-app 协议生成相对资源路径', () => {
    execFileSync(process.execPath, ['tools/build-terminal.mjs'], { cwd: process.cwd(), stdio: 'pipe' });

    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'apps/terminal/manifest.json'), 'utf8'));
    const entry = readFileSync(resolve(process.cwd(), 'apps/terminal/dist/renderer/index.html'), 'utf8');
    expect(manifest.version).toBe('2.0.0');
    expect(entry).toMatch(/(?:src|href)="\.\.\/assets\//);
    expect(entry).not.toMatch(/(?:src|href)="\/assets\//);
  }, 15_000);

  it('在隔离安装目录中加载 SSH 后端所需的全部运行时依赖', () => {
    execFileSync(process.execPath, ['tools/build-terminal.mjs'], { cwd: process.cwd(), stdio: 'pipe' });

    const distPath = resolve(process.cwd(), 'apps/terminal/dist');
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'workbench-terminal-package-'));

    try {
      expect(existsSync(join(distPath, 'node_modules', 'safer-buffer', 'safer.js'))).toBe(true);
      cpSync(distPath, isolatedRoot, { recursive: true });

      expect(() => execFileSync(process.execPath, ['-e', 'require(process.argv[1])', join(isolatedRoot, 'backend', 'entry.js')], { cwd: isolatedRoot, stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('由 Apps 仓库的 terminal 标签触发发布', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain("- 'terminal-v*'");
    expect(workflow).toContain('terminal) npm run build:terminal ;;');
    expect(workflow).not.toContain("- 'ssh-terminal-v*'");
  });
});
