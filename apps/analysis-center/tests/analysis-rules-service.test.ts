import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisRulesService, type AnalysisRulePackage } from '../backend/lib/services/analysis-rules-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('分析中心独立在线规则', () => {
  it('验签后原子激活统一规则包，并为后续任务提供新快照', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).resolves.toEqual({ status: 'updated', previousVersion: '1.0.0', currentVersion: '1.0.1' });
    await expect(service.getState()).resolves.toEqual({ currentVersion: '1.0.1', source: 'downloaded' });
    await expect(service.getSnapshot()).resolves.toMatchObject({ version: '1.0.1', formatRules: { tgz: { files: [] }, zip: { files: [] } }, v1: { eventRules: [] } });
  });

  it('拒绝损坏包并保留最后可用规则', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    const release = signRelease(next, keys.privateKey);
    release.catalog.sha256 = '0'.repeat(64);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).rejects.toThrow('SHA-256');
    await expect(service.getSnapshot()).resolves.toMatchObject({ version: '1.0.0' });
  });

  it('重启且离线时复用最后一次已验签的规则包', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    const release = signRelease(next, keys.privateKey);
    const options = {
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey }
    };
    await new AnalysisRulesService({ ...options, fetchImpl: makeFetch(release.catalog, release.bytes) }).update();

    const restarted = new AnalysisRulesService({ ...options, fetchImpl: (async () => { throw new Error('离线'); }) as typeof fetch });
    await expect(restarted.getState()).resolves.toEqual({ currentVersion: '1.0.1', source: 'downloaded' });
  });

  it('拒绝签名有效但包含无效事件正则的规则包', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    next.v1.eventRules = [{ id: 'broken', sources: ['ups'], regex: '[', type: 'power.broken' }];
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).rejects.toThrow('事件正则无效');
    await expect(service.getState()).resolves.toEqual({ currentVersion: '1.0.0', source: 'bundled' });
  });

  it('拒绝包含重复规则 ID 的已签名规则包', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    next.v1.eventRules = [
      { id: 'power.state', sources: ['ups'], regex: 'status OB', type: 'power.on_battery' },
      { id: 'power.state', sources: ['ups'], regex: 'status OL', type: 'power.online' }
    ];
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).rejects.toThrow('事件规则 ID 重复');
    await expect(service.getState()).resolves.toEqual({ currentVersion: '1.0.0', source: 'bundled' });
  });

  it('拒绝引用不存在建议的已签名诊断规则包', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    next.v1.diagnosisRules = [{
      id: 'power.loss', priority: 1, all: [{ type: 'power.on_battery' }],
      category: 'power', severity: 'warning', confidence: 'high', title: '供电中断', summary: '检测到供电中断。', recommendationIds: ['recommendation.missing']
    }];
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).rejects.toThrow('引用了不存在的建议');
    await expect(service.getState()).resolves.toEqual({ currentVersion: '1.0.0', source: 'bundled' });
  });

  it('拒绝包含未支持 Finding 模板占位符的已签名规则包', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    next.v1.findingRules = [{
      type: 'storage.io_error', category: 'storage', severity: 'warning', confidence: 'medium',
      title: '{{process.exit()}}', summary: '检测到 I/O 错误。'
    }];
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).rejects.toThrow('Finding 模板包含未支持的占位符');
    await expect(service.getState()).resolves.toEqual({ currentVersion: '1.0.0', source: 'bundled' });
  });

  it('拒绝经重定向降级为 HTTP 的规则目录', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: (async () => redirectedResponse('{}', 'http://example.test/catalog.json')) as typeof fetch
    });

    await expect(service.update()).rejects.toThrow('HTTPS');
    await expect(service.getState()).resolves.toEqual({ currentVersion: '1.0.0', source: 'bundled' });
  });

  it('按语义化版本顺序接受 rc.2 之后的 rc.10', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.0-rc.10');
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0-rc.2'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).resolves.toMatchObject({ status: 'updated', currentVersion: '1.0.0-rc.10' });
  });

  it('拒绝没有正向触发条件的已签名诊断规则包', async () => {
    const directory = await createDirectory();
    const keys = generateKeyPairSync('ed25519');
    const next = makePackage('1.0.1');
    next.v1.diagnosisRules = [{
      id: 'system.always', priority: 1, category: 'system', severity: 'warning', confidence: 'medium',
      title: '无条件诊断', summary: '不应无条件命中。', recommendationIds: []
    }];
    const release = signRelease(next, keys.privateKey);
    const service = new AnalysisRulesService({
      directory,
      seed: makePackage('1.0.0'),
      catalogUrl: 'https://example.test/catalog.json',
      trustedKeys: { 'test-key': keys.publicKey },
      fetchImpl: makeFetch(release.catalog, release.bytes)
    });

    await expect(service.update()).rejects.toThrow('必须包含正向触发条件');
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'analysis-rules-'));
  directories.push(directory);
  return directory;
}

function makePackage(version: string): AnalysisRulePackage {
  return {
    schemaVersion: 1,
    ruleSetId: 'analysis-center-runtime-rules',
    version,
    minimumRuntimeVersion: '1.0.0',
    formatRules: { tgz: { files: [] }, zip: { files: [] } },
    v1: { eventRules: [], findingRules: [], diagnosisRules: [], recommendations: [] }
  };
}

function signRelease(rulePackage: AnalysisRulePackage, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const bytes = Buffer.from(`${JSON.stringify(rulePackage)}\n`);
  return {
    bytes,
    catalog: {
      schemaVersion: 1,
      ruleSetId: 'analysis-center-runtime-rules',
      version: rulePackage.version,
      packageUrl: 'https://example.test/package.json',
      packageSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signatureAlgorithm: 'Ed25519' as const,
      keyId: 'test-key',
      signature: sign(null, bytes, privateKey).toString('base64')
    }
  };
}

function makeFetch(catalog: object, bytes: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => String(input).endsWith('catalog.json')
    ? new Response(JSON.stringify(catalog), { status: 200 })
    : new Response(bytes, { status: 200 })) as typeof fetch;
}

function redirectedResponse(body: string, url: string): Response {
  const response = new Response(body, { status: 200 });
  Object.defineProperties(response, { redirected: { value: true }, url: { value: url } });
  return response;
}
