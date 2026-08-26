import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicZip } from './create-deterministic-zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps', 'lvm-uncache-tool');
const dist = join(appRoot, 'dist');
const manifestPath = join(appRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(appRoot, 'vite.config.mjs')], { cwd: appRoot, stdio: 'inherit' });
await copyFile(manifestPath, join(dist, 'manifest.json'));
await copyFile(join(appRoot, 'renderer', 'icon.svg'), join(dist, 'renderer', 'icon.svg'));
await copyFile(join(appRoot, 'LICENSE'), join(dist, 'LICENSE'));

const zipPath = join(dist, `lvm-uncache-tool-v${manifest.version}.zip`);
await createDeterministicZip(dist, zipPath);
const bytes = await readFile(zipPath);
const release = {
  appId: manifest.id,
  version: manifest.version,
  hostApiVersion: manifest.hostApiVersion,
  minWorkbenchVersion: manifest.minWorkbenchVersion,
  url: `https://github.com/thelinyue/Workbench-Apps/releases/download/lvm-uncache-tool-v${manifest.version}/lvm-uncache-tool-v${manifest.version}.zip`,
  size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex')
};
const privateKeyPem = process.env.HEPHAESTUS_APP_SIGNING_PRIVATE_KEY;
const keyId = process.env.HEPHAESTUS_APP_SIGNING_KEY_ID;
if (privateKeyPem && keyId) release.signature = { keyId, signature: sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64') };
await writeFile(join(dist, 'release.json'), JSON.stringify(release, null, 2));
console.log(`已构建 LVM 缓存清理工具：${zipPath}`);
console.log(`SHA-256：${release.sha256}`);
if (!release.signature) console.warn('警告：未提供签名私钥，当前 ZIP 只能用于构建检查，不能通过正式安装校验。');
