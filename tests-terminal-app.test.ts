import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
      capabilities: ['ssh.credentials']
    });
    expect(buildSource).toContain('terminal-v${manifest.version}.zip');
    expect(buildSource).toContain('/terminal-v${manifest.version}/terminal-v${manifest.version}.zip');
  });

  it('发布 1.0.1 并为 workbench-app 协议生成相对资源路径', () => {
    execFileSync(process.execPath, ['tools/build-terminal.mjs'], { cwd: process.cwd(), stdio: 'pipe' });

    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'apps/terminal/manifest.json'), 'utf8'));
    const entry = readFileSync(resolve(process.cwd(), 'apps/terminal/dist/renderer/index.html'), 'utf8');
    expect(manifest.version).toBe('1.0.1');
    expect(entry).toMatch(/(?:src|href)="\.\.\/assets\//);
    expect(entry).not.toMatch(/(?:src|href)="\/assets\//);
  });

  it('由 Apps 仓库的 terminal 标签触发发布', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain("- 'terminal-v*'");
    expect(workflow).toContain('terminal) npm run build:terminal ;;');
    expect(workflow).not.toContain("- 'ssh-terminal-v*'");
  });
});
