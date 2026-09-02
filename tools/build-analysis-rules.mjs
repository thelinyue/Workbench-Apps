import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAnalysisRulesReleaseUrl } from './release-config.mjs';

const [version, outputDirectory] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('用法：node tools/build-analysis-rules.mjs <语义化版本> <输出目录>');
if (!outputDirectory) throw new Error('请提供规则构建输出目录。');
const privateKeyPem = process.env.HEPHAESTUS_APP_SIGNING_PRIVATE_KEY;
const keyId = process.env.HEPHAESTUS_APP_SIGNING_KEY_ID;
if (!privateKeyPem || !keyId) throw new Error('规则正式发布需要 HEPHAESTUS_APP_SIGNING_PRIVATE_KEY 和 HEPHAESTUS_APP_SIGNING_KEY_ID。');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps', 'analysis-center');
const [formatRules, eventRulePack, definitions] = await Promise.all([
  readJson(join(appRoot, 'backend', 'lib', 'analysis', 'rules.json')),
  readJson(join(appRoot, 'backend', 'lib', 'analysis-v1', 'event-rule-pack.json')),
  readJson(join(appRoot, 'backend', 'lib', 'analysis-rules', 'rule-definitions.json'))
]);
const rulePackage = {
  schemaVersion: 1,
  ruleSetId: 'analysis-center-runtime-rules',
  version,
  minimumRuntimeVersion: '1.0.0',
  formatRules: {
    tgz: { files: formatRules.tgz.files },
    zip: { files: formatRules.zip.files }
  },
  v1: {
    eventRules: eventRulePack.eventRules,
    findingRules: definitions.findingRules,
    diagnosisRules: definitions.diagnosisRules,
    recommendations: definitions.recommendations
  }
};
const bytes = Buffer.from(`${JSON.stringify(rulePackage, null, 2)}\n`);
const assetName = `analysis-center-rules-v${version}.json`;
const catalog = {
  schemaVersion: 1,
  ruleSetId: 'analysis-center-runtime-rules',
  version,
  packageUrl: getAnalysisRulesReleaseUrl(version),
  packageSize: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  signatureAlgorithm: 'Ed25519',
  keyId,
  signature: sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, assetName), bytes);
await writeFile(join(outputDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`已构建并签名分析中心规则：${join(outputDirectory, assetName)}`);

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
