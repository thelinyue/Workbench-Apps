import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UNIFIED_RELEASE_TAG,
  getReleaseAssetName,
  getReleaseUrl
} from './tools/release-config.mjs';

const root = process.cwd();

describe('统一应用发布配置', () => {
  it('为所有应用生成统一 Release 的唯一 ZIP 资产地址', () => {
    expect(UNIFIED_RELEASE_TAG).toBe('workbench-apps');
    expect(getReleaseAssetName('terminal', '1.0.2')).toBe('terminal-v1.0.2.zip');
    expect(getReleaseUrl('terminal', '1.0.2')).toBe(
      'https://github.com/thelinyue/Workbench-Apps/releases/download/workbench-apps/terminal-v1.0.2.zip'
    );
  });

  it('四个构建脚本都使用统一 Release URL 生成器', () => {
    for (const appId of ['analysis-center', 'lvm-uncache-tool', 'terminal', 'log-rule-editor']) {
      const source = readFileSync(resolve(root, `tools/build-${appId}.mjs`), 'utf8');
      expect(source).toContain('getReleaseUrl');
      expect(source).not.toContain(`/releases/download/${appId}-v${'${manifest.version}'}`);
    }
  });

  it('目录校验同时接受历史 Release URL 和统一 Release URL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-release-catalog-'));
    const catalogPath = join(directory, 'catalog.json');
    const signature = { keyId: 'test-key', signature: Buffer.alloc(64).toString('base64') };

    try {
      writeFileSync(catalogPath, JSON.stringify({
        schemaVersion: 1,
        apps: [
          {
            id: 'analysis-center',
            name: '分析中心',
            description: '测试应用',
            publisherId: 'thelinyue',
            releases: [
              {
                version: '1.0.0',
                hostApiVersion: '1.0',
                minWorkbenchVersion: '0.1.0',
                url: 'https://github.com/thelinyue/Workbench-Apps/releases/download/analysis-center-v1.0.0/analysis-center-v1.0.0.zip',
                size: 1,
                sha256: 'a'.repeat(64),
                signature
              },
              {
                version: '1.1.0',
                hostApiVersion: '1.0',
                minWorkbenchVersion: '0.1.0',
                url: getReleaseUrl('analysis-center', '1.1.0'),
                size: 1,
                sha256: 'b'.repeat(64),
                signature
              }
            ]
          }
        ]
      }, null, 2));

      expect(() => execFileSync(process.execPath, ['tools/validate-catalog.mjs', catalogPath], {
        cwd: root,
        stdio: 'pipe'
      })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('同一应用同一版本的目录记录会被新发布替换', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-release-update-'));
    const catalogPath = join(directory, 'catalog.json');
    const releasePath = join(directory, 'release.json');
    const manifestPath = join(directory, 'manifest.json');
    const signature = { keyId: 'new-key', signature: Buffer.alloc(64, 1).toString('base64') };

    try {
      writeFileSync(catalogPath, JSON.stringify({
        schemaVersion: 1,
        apps: [{
          id: 'terminal',
          name: 'SSH 终端',
          description: '测试应用',
          publisherId: 'thelinyue',
          releases: [
            {
              version: '1.0.0',
              hostApiVersion: '1.0',
              minWorkbenchVersion: '0.1.0',
              url: getReleaseUrl('terminal', '1.0.0'),
              size: 10,
              sha256: 'a'.repeat(64),
              signature: { keyId: 'old-key', signature: Buffer.alloc(64).toString('base64') }
            },
            {
              version: '1.0.1',
              hostApiVersion: '1.0',
              minWorkbenchVersion: '0.1.0',
              url: getReleaseUrl('terminal', '1.0.1'),
              size: 11,
              sha256: 'b'.repeat(64),
              signature: { keyId: 'old-key', signature: Buffer.alloc(64).toString('base64') }
            }
          ]
        }]
      }, null, 2));
      writeFileSync(manifestPath, JSON.stringify({
        id: 'terminal',
        name: 'SSH 终端',
        description: '测试应用',
        publisherId: 'thelinyue'
      }));
      writeFileSync(releasePath, JSON.stringify({
        appId: 'terminal',
        version: '1.0.1',
        hostApiVersion: '1.0',
        minWorkbenchVersion: '0.1.0',
        url: getReleaseUrl('terminal', '1.0.1'),
        size: 12,
        sha256: 'c'.repeat(64),
        signature
      }));

      execFileSync(process.execPath, ['tools/update-app-catalog.mjs', catalogPath, releasePath, manifestPath], {
        cwd: root,
        stdio: 'pipe'
      });

      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
      expect(catalog.apps[0].releases).toHaveLength(2);
      expect(catalog.apps[0].releases).toEqual(expect.arrayContaining([
        expect.objectContaining({ version: '1.0.0', size: 10, sha256: 'a'.repeat(64) }),
        expect.objectContaining({ version: '1.0.1', size: 12, sha256: 'c'.repeat(64), signature })
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('工作流将应用资产发布到固定 Release 并串行执行', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('group: workbench-apps-release');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('workbench-apps');
    expect(workflow).toContain('gh release upload');
    expect(workflow).toContain('--clobber');
    expect(workflow).toContain('release_asset_name');
    expect(workflow).toContain('metadata_asset_name');
    expect(workflow).toContain('metadata_path="apps/$app_id/dist/$metadata_asset_name"');
    expect(workflow).toContain('cp "$release_path" "$metadata_path"');
    expect(workflow).toContain('"$metadata_path" --clobber');
    expect(workflow).toContain("'analysis-rules-v*'");
    expect(workflow).toContain('publish-analysis-rules');
    expect(workflow).toContain('tools/build-analysis-rules.mjs');
    expect(workflow).toContain('rules/analysis-center/catalog.json');
    expect(workflow).toContain('git fetch origin main');
    expect(workflow).toContain('git checkout -B analysis-rules-catalog origin/main');
  });
});
