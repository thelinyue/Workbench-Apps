import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('分析中心规则独立发布', () => {
  it('生成已签名统一规则包与指向不可变 Release 资产的目录', () => {
    const directory = mkdtempSync(join(tmpdir(), 'analysis-rules-publish-'));
    const keys = generateKeyPairSync('ed25519');
    try {
      execFileSync(process.execPath, ['tools/build-analysis-rules.mjs', '1.0.1', directory], {
        cwd: root,
        env: {
          ...process.env,
          HEPHAESTUS_APP_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          HEPHAESTUS_APP_SIGNING_KEY_ID: 'test-key'
        },
        stdio: 'pipe'
      });

      const bytes = readFileSync(join(directory, 'analysis-center-rules-v1.0.1.json'));
      const catalog = JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8'));
      expect(catalog).toMatchObject({
        ruleSetId: 'analysis-center-runtime-rules', version: '1.0.1', packageSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'), keyId: 'test-key',
        packageUrl: 'https://github.com/thelinyue/Workbench-Apps/releases/download/workbench-apps/analysis-center-rules-v1.0.1.json'
      });
      expect(verify(null, bytes, keys.publicKey, Buffer.from(catalog.signature, 'base64'))).toBe(true);
      expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ version: '1.0.1', formatRules: { tgz: { files: expect.any(Array) }, zip: { files: expect.any(Array) } }, v1: { eventRules: expect.any(Array) } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
