import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { transformVgText, LvmUncacheError } from "../app.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function findVgFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await findVgFiles(path));
    else if (entry.name.toLowerCase().endsWith(".vg")) result.push(path);
  }
  return result;
}

test("所有带缓存样例都能清理并移除缓存配置", async () => {
  const files = await findVgFiles(root);
  const cached = [];
  for (const path of files) {
    const text = await readFile(path, "utf8");
    if (/cache\+CACHE_USES_CACHEVOL|\[\s*"CACHE_VOL"\s*\]|tags\s*=\s*\[[^\]]*lvmcache/i.test(text)) cached.push({ path, text });
  }
  assert.ok(cached.length >= 1);
  for (const item of cached) {
    const result = transformVgText(item.text, "sample.vg");
    assert.equal(result.summary.hasCache, true, item.path);
    assert.doesNotMatch(result.processedText, /cache\+CACHE_USES_CACHEVOL/i, item.path);
    assert.doesNotMatch(result.processedText, /flags\s*=\s*\[\s*"CACHE_VOL"\s*\]/i, item.path);
    assert.doesNotMatch(result.processedText, /tags\s*=\s*\[[^\]]*lvmcache/i, item.path);
    assert.match(result.processedText, /type\s*=\s*"striped"/i, item.path);
    assert.equal(result.originalText, item.text, item.path);
  }
});

test("无缓存样例保持原文不变", async () => {
  const files = await findVgFiles(root);
  const noCache = [];
  for (const path of files) {
    const text = await readFile(path, "utf8");
    if (!/cache\+CACHE_USES_CACHEVOL|\[\s*"CACHE_VOL"\s*\]|tags\s*=\s*\[[^\]]*lvmcache/i.test(text)) noCache.push({ path, text });
  }
  assert.ok(noCache.length >= 1);
  for (const item of noCache) {
    const result = transformVgText(item.text, "no-cache.vg");
    assert.equal(result.summary.hasCache, false, item.path);
    assert.equal(result.processedText, item.text, item.path);
  }
});

test("缺少 origin 或 cache_pool 时拒绝生成结果", async () => {
  const source = await readFile(join(root, "cached.vg"), "utf8");
  assert.throws(() => transformVgText(source.replace(/\s+origin\s*=\s*"[^"]+"/i, "")), LvmUncacheError);
  assert.throws(() => transformVgText(source.replace(/\s+cache_pool\s*=\s*"[^"]+"/i, "")), LvmUncacheError);
});

test("损坏结构和多 segment 缓存布局会被拒绝", async () => {
  const source = await readFile(join(root, "cached.vg"), "utf8");
  assert.throws(() => transformVgText(`${source}\nlogical_volumes {`), LvmUncacheError);
  const multi = source.replace(/segment_count\s*=\s*1/, "segment_count = 2");
  assert.throws(() => transformVgText(multi), LvmUncacheError);
});

test("保留 CRLF 输入的末尾换行并生成安全文件名", async () => {
  const source = await readFile(join(root, "cached.vg"), "utf8");
  const result = transformVgText(source.replaceAll("\n", "\r\n"), "设备备份.vg");
  assert.equal(result.suggestedFilename, "设备备份_nocache.vg");
  assert.equal(result.processedText.endsWith("\n"), true);
  assert.equal(result.processedText.endsWith("\r\n"), false);
});
