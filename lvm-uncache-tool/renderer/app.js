const CACHE_KEYS = [
  "cache_pool", "origin", "metadata_format", "chunk_size", "cache_mode",
  "policy", "metadata_start", "metadata_len", "data_start", "data_len"
];
const CACHE_KEY_SET = new Set(CACHE_KEYS);
const CACHE_TYPE = /^cache\+CACHE_USES_CACHEVOL$/i;

export class LvmUncacheError extends Error {
  constructor(message) {
    super(message);
    this.name = "LvmUncacheError";
  }
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function braceDelta(line) {
  let delta = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && ch === "\\") { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === "#") break;
    if (!quoted && ch === "{") delta += 1;
    if (!quoted && ch === "}") delta -= 1;
  }
  return delta;
}

function splitInput(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { lines: normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n"), trailingNewline: normalized.endsWith("\n") };
}

function blockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += braceDelta(lines[i]);
    if (depth === 0) return i;
    if (depth < 0) throw new LvmUncacheError(`第 ${i + 1} 行的大括号结构无效。`);
  }
  throw new LvmUncacheError(`从第 ${start + 1} 行开始的配置块没有闭合。`);
}

function findSection(lines, name) {
  const pattern = new RegExp(`^\\s*${escapedRegex(name)}\\s*\\{`);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return { start: i, end: blockEnd(lines, i), name };
  }
  return null;
}

function findChildBlocks(lines, parent) {
  const children = [];
  let depth = 1;
  for (let i = parent.start + 1; i < parent.end; i += 1) {
    const line = lines[i];
    const match = /^\s*(.*?)\s*\{\s*(?:#.*)?$/.exec(line);
    if (depth === 1 && match && !match[1].includes("=")) {
      const name = match[1].trim();
      if (!name) throw new LvmUncacheError(`第 ${i + 1} 行存在没有名称的配置块。`);
      const end = blockEnd(lines, i);
      children.push({ name, start: i, end });
      i = end;
      continue;
    }
    depth += braceDelta(line);
    if (depth < 1) throw new LvmUncacheError(`第 ${i + 1} 行的配置嵌套层级无效。`);
  }
  if (depth !== 1) throw new LvmUncacheError(`配置块 ${parent.name} 的嵌套结构无效。`);
  return children;
}

function blockText(lines, block) {
  return lines.slice(block.start, block.end + 1).join("\n");
}

function quotedValue(text, key) {
  const pattern = new RegExp(`\\b${escapedRegex(key)}\\s*=\\s*"([^"]*)"`, "i");
  return pattern.exec(text)?.[1] ?? null;
}

function hasArrayValue(text, key, value) {
  const pattern = new RegExp(`\\b${escapedRegex(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "i");
  const match = pattern.exec(text);
  return Boolean(match && new RegExp(`\\b${escapedRegex(value)}\\b`, "i").test(match[1]));
}

function assignmentKeys(text) {
  const keys = new Set();
  for (const key of CACHE_KEYS) {
    if (new RegExp(`^\\s*${escapedRegex(key)}\\s*=`, "im").test(text)) keys.add(key);
  }
  return keys;
}

function stripePvs(text) {
  const match = /\bstripes\s*=\s*\[([\s\S]*?)\]/i.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function leadingWhitespace(line) {
  return line.match(/^\s*/)?.[0] ?? "";
}

function isAssignment(line, key) {
  return new RegExp(`^\\s*${escapedRegex(key)}\\s*=`, "i").test(line);
}

function transformSegment(lines, segment, targetPv) {
  const segmentLines = lines.slice(segment.start, segment.end + 1);
  const typeIndex = segmentLines.findIndex((line) => {
    const value = quotedValue(line, "type");
    return value && CACHE_TYPE.test(value);
  });
  if (typeIndex < 0) throw new LvmUncacheError(`缓存 segment ${segment.name} 缺少有效的 type 配置。`);

  const indent = leadingWhitespace(segmentLines[typeIndex]);
  const replacement = [
    `${indent}type = "striped"`,
    `${indent}stripe_count = 1        # linear`,
    `${indent}stripes = [`,
    `${indent}        "${targetPv}", 0`,
    `${indent}]`
  ];
  const output = [];
  let skippingStripes = false;
  for (let i = 0; i < segmentLines.length; i += 1) {
    const line = segmentLines[i];
    if (i === typeIndex) {
      output.push(...replacement);
      continue;
    }
    if (skippingStripes) {
      if (/^\s*\]/.test(line)) skippingStripes = false;
      continue;
    }
    if (isAssignment(line, "stripes")) {
      skippingStripes = true;
      continue;
    }
    if (isAssignment(line, "stripe_count")) continue;
    const key = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line)?.[1];
    if (key && CACHE_KEY_SET.has(key)) continue;
    output.push(line);
  }
  return output;
}

function transformLogicalVolume(lines, lv, cachedSegments, targetPvs) {
  const segments = findChildBlocks(lines, lv).filter((block) => /^segment\d*$/i.test(block.name));
  const declaredCount = /^\s*segment_count\s*=\s*(\d+)/im.exec(blockText(lines, lv))?.[1];
  if (segments.length !== 1 || Number(declaredCount || segments.length) !== 1) {
    throw new LvmUncacheError(`逻辑卷 ${lv.name} 包含多个 segment，当前版本拒绝处理这种复杂布局。`);
  }
  const replacements = new Map(cachedSegments.map((segment) => [segment.segment.start, transformSegment(lines, segment.segment, targetPvs.get(segment.segment.start))]));
  const output = [];
  for (let i = lv.start; i <= lv.end; i += 1) {
    const replacement = replacements.get(i);
    if (replacement) {
      output.push(...replacement);
      i = cachedSegments.find((item) => item.segment.start === i).segment.end;
    } else {
      output.push(lines[i]);
    }
  }
  return output;
}

function applyRanges(lines, ranges) {
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  const output = [];
  let cursor = 0;
  for (const range of ordered) {
    if (range.start < cursor) throw new LvmUncacheError("内部处理范围重叠，未生成输出文件。" );
    output.push(...lines.slice(cursor, range.start));
    if (range.replacement) output.push(...range.replacement);
    cursor = range.end + 1;
  }
  output.push(...lines.slice(cursor));
  return output;
}

function cleanupBlankLines(lines) {
  const output = [];
  let blank = false;
  for (const line of lines) {
    if (line.trim() === "") {
      if (blank) continue;
      blank = true;
    } else {
      blank = false;
    }
    output.push(line);
  }
  return output;
}

function suggestedFilename(originalFilename) {
  const fallback = "processed.vg";
  if (!originalFilename?.trim()) return fallback;
  const dot = originalFilename.lastIndexOf(".");
  if (dot > 0) return `${originalFilename.slice(0, dot)}_nocache${originalFilename.slice(dot)}`;
  return `${originalFilename}_nocache`;
}

export function transformVgText(text, originalFilename = "input.vg") {
  const originalText = String(text ?? "");
  if (!originalText.trim()) throw new LvmUncacheError("输入的 VG 配置为空。" );
  const { lines, trailingNewline } = splitInput(originalText);
  let documentDepth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    documentDepth += braceDelta(lines[i]);
    if (documentDepth < 0) throw new LvmUncacheError(`第 ${i + 1} 行的大括号提前闭合。`);
  }
  if (documentDepth !== 0) throw new LvmUncacheError("VG 配置的大括号结构未闭合。" );
  const pvSection = findSection(lines, "physical_volumes");
  const lvSection = findSection(lines, "logical_volumes");
  if (!pvSection || !lvSection) throw new LvmUncacheError("未找到完整的 physical_volumes 或 logical_volumes 配置。" );
  if (pvSection.end >= lvSection.start) throw new LvmUncacheError("physical_volumes 与 logical_volumes 配置顺序或范围无效。" );

  const pvBlocks = findChildBlocks(lines, pvSection);
  const lvBlocks = findChildBlocks(lines, lvSection);
  const cachePvNames = new Set(pvBlocks.filter((pv) => hasArrayValue(blockText(lines, pv), "tags", "lvmcache")).map((pv) => pv.name));
  const cacheVolNames = new Set(lvBlocks.filter((lv) => hasArrayValue(blockText(lines, lv), "flags", "CACHE_VOL")).map((lv) => lv.name));
  const cachedByLv = new Map();
  const cachedSegments = [];
  for (const lv of lvBlocks) {
    const segments = findChildBlocks(lines, lv).filter((block) => /^segment\d*$/i.test(block.name));
    for (const segment of segments) {
      const textBlock = blockText(lines, segment);
      const type = quotedValue(textBlock, "type");
      if (!type || !CACHE_TYPE.test(type)) continue;
      const origin = quotedValue(textBlock, "origin");
      const cachePool = quotedValue(textBlock, "cache_pool");
      if (!origin) throw new LvmUncacheError(`逻辑卷 ${lv.name} 的缓存 segment 缺少 origin。`);
      if (!cachePool) throw new LvmUncacheError(`逻辑卷 ${lv.name} 的缓存 segment 缺少 cache_pool。`);
      if (!cacheVolNames.has(cachePool)) throw new LvmUncacheError(`缓存 segment 引用了未标记为 CACHE_VOL 的缓存卷 ${cachePool}。`);
      const item = { lv, segment, origin, cachePool, removedKeys: assignmentKeys(textBlock) };
      cachedSegments.push(item);
      if (!cachedByLv.has(lv.name)) cachedByLv.set(lv.name, []);
      cachedByLv.get(lv.name).push(item);
    }
  }

  const baseSummary = {
    hasCache: cachedSegments.length > 0,
    cacheSegmentCount: cachedSegments.length,
    cachePvNames: [...cachePvNames],
    cacheLvNames: [...cacheVolNames],
    originNames: [...new Set(cachedSegments.map((item) => item.origin))],
    changedSegments: cachedSegments.length,
    removedKeys: cachedSegments.reduce((total, item) => total + [...item.removedKeys].filter((key) => CACHE_KEY_SET.has(key)).length, 0),
    removedPvNames: [...cachePvNames],
    removedLvNames: [...new Set([...cacheVolNames, ...cachedSegments.map((item) => item.origin)])],
    warning: ""
  };
  if (!cachedSegments.length) {
    return { originalText, processedText: originalText, suggestedFilename: suggestedFilename(originalFilename), summary: baseSummary };
  }

  const lvByName = new Map(lvBlocks.map((lv) => [lv.name, lv]));
  const targetPvs = new Map();
  for (const item of cachedSegments) {
    const originLv = lvByName.get(item.origin);
    if (!originLv) throw new LvmUncacheError(`缓存 segment 引用的 origin 逻辑卷 ${item.origin} 不存在。`);
    const originSegments = findChildBlocks(lines, originLv).filter((block) => /^segment\d*$/i.test(block.name));
    const originPvs = originSegments.flatMap((segment) => stripePvs(blockText(lines, segment)).filter((pv) => !cachePvNames.has(pv)));
    if (!originPvs.length) throw new LvmUncacheError(`origin 逻辑卷 ${item.origin} 没有可用的非缓存 PV。`);
    targetPvs.set(item.segment.start, originPvs[0]);
  }

  const ranges = [];
  for (const pv of pvBlocks) if (cachePvNames.has(pv.name)) ranges.push({ start: pv.start, end: pv.end });
  for (const lv of lvBlocks) {
    if (cacheVolNames.has(lv.name) || baseSummary.originNames.includes(lv.name)) {
      ranges.push({ start: lv.start, end: lv.end });
      continue;
    }
    const cached = cachedByLv.get(lv.name);
    if (cached) ranges.push({ start: lv.start, end: lv.end, replacement: transformLogicalVolume(lines, lv, cached, targetPvs) });
  }
  const outputLines = cleanupBlankLines(applyRanges(lines, ranges));
  const processedText = outputLines.join("\n") + (trailingNewline ? "\n" : "");
  return { originalText, processedText, suggestedFilename: suggestedFilename(originalFilename), summary: baseSummary };
}

function byId(id) { return document.getElementById(id); }
let latestResult = null;
let selectedFilename = "input.vg";

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function setText(id, value) { byId(id).textContent = String(value); }

function addDetail(container, label, value) {
  const row = document.createElement("div");
  row.className = "detail";
  const labelNode = document.createElement("span");
  labelNode.textContent = `${label}：`;
  row.append(labelNode, document.createTextNode(value || "无"));
  container.append(row);
}

function renderResult(result) {
  latestResult = result;
  const summary = result.summary;
  setText("status-value", summary.hasCache ? "发现缓存" : "未发现缓存");
  setText("segment-count", summary.cacheSegmentCount);
  setText("pv-count", summary.cachePvNames.length);
  setText("lv-count", summary.cacheLvNames.length);
  setText("original-lines", `${result.originalText.split(/\r?\n/).length} 行`);
  setText("processed-lines", `${result.processedText.split(/\r?\n/).length} 行`);
  setText("suggested-name", result.suggestedFilename);
  byId("original-text").value = result.originalText;
  byId("processed-text").value = result.processedText;
  byId("save-button").disabled = false;
  const details = byId("details");
  details.replaceChildren();
  addDetail(details, "缓存 PV", summary.cachePvNames.join(", "));
  addDetail(details, "缓存 LV", summary.cacheLvNames.join(", "));
  addDetail(details, "origin", summary.originNames.join(", "));
  addDetail(details, "删除缓存键", `${summary.removedKeys} 个`);
  addDetail(details, "转换 segment", `${summary.changedSegments} 个`);
  addDetail(details, "输出文件", result.suggestedFilename);
  const warning = byId("warning");
  warning.hidden = summary.hasCache;
  warning.textContent = summary.hasCache ? "" : "没有发现 cache 配置，处理结果与原始配置相同。请确认输入的是 LVM2 VG 文本备份。";
  setText("result-message", summary.hasCache ? "已识别缓存配置，请检查差异后保存。" : "未发现需要清理的缓存配置。");
}

function handleProcess() {
  try {
    const text = byId("input-text").value;
    const result = transformVgText(text, selectedFilename);
    renderResult(result);
    showToast(result.summary.hasCache ? "解析完成，请检查清理结果" : "解析完成，未发现缓存");
  } catch (error) {
    latestResult = null;
    byId("save-button").disabled = true;
    setText("status-value", "处理失败");
    byId("warning").hidden = false;
    byId("warning").textContent = error instanceof Error ? error.message : "处理失败，请检查输入。";
    showToast(byId("warning").textContent);
  }
}

function downloadInBrowser(result) {
  const blob = new Blob([result.processedText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.suggestedFilename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("清理结果已下载");
}

function invokeWorkbench(method, payload) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.source !== window.parent || event.data?.type !== "workbench-app-rpc-response" || event.data.appId !== "lvm-uncache-tool" || event.data.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.errorMessage || "宿主请求失败"));
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "workbench-app-rpc", appId: "lvm-uncache-tool", requestId, method, payload }, "*");
  });
}

async function saveResult() {
  if (!latestResult) return;
  if (window.parent !== window) {
    try {
      await invokeWorkbench("host.saveFile", {
        fileName: latestResult.suggestedFilename,
        content: latestResult.processedText,
        overwriteRequested: byId("overwrite-checkbox").checked
      });
      showToast("清理结果已保存");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败");
    }
    return;
  }
  downloadInBrowser(latestResult);
}

function clearAll() {
  latestResult = null;
  selectedFilename = "input.vg";
  byId("file-input").value = "";
  byId("input-text").value = "";
  byId("original-text").value = "";
  byId("processed-text").value = "";
  byId("save-button").disabled = true;
  setText("input-meta", "尚未选择文件");
  setText("status-value", "等待输入");
  setText("segment-count", "0");
  setText("pv-count", "0");
  setText("lv-count", "0");
  setText("original-lines", "0 行");
  setText("processed-lines", "0 行");
  setText("suggested-name", "processed_nocache.vg");
  setText("result-message", "处理后会显示将要删除和转换的配置。");
  byId("details").replaceChildren();
  byId("warning").hidden = true;
}

if (typeof document !== "undefined") {
  byId("file-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    selectedFilename = file.name;
    byId("input-text").value = await file.text();
    setText("input-meta", `${file.name} · ${(file.size / 1024).toFixed(1)} KB`);
  });
  byId("process-button").addEventListener("click", handleProcess);
  byId("clear-button").addEventListener("click", clearAll);
  byId("save-button").addEventListener("click", saveResult);
  window.chrome?.webview?.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "saveSucceeded") showToast(`已保存：${message.path || "清理结果"}`);
    if (message?.type === "saveCanceled") showToast("已取消保存");
    if (message?.type === "saveFailed") showToast(message.message || "保存失败");
  });
}


