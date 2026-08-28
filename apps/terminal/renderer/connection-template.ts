export interface ParsedConnectionTemplate {
  host: string;
  port: number;
}

/** 严格解析设计约定的短 JSON 模板，避免静默忽略拼错或多余字段。 */
export function parseConnectionTemplate(input: string): ParsedConnectionTemplate {
  const value = input.trim();
  if (!value) throw new Error('请粘贴 JSON 连接模板。');
  if (value.length > 200) throw new Error('JSON 连接模板不能超过 200 个字符。');
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('JSON 格式不正确。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模板必须是 JSON 对象。');
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some((key) => key !== 'ip' && key !== 'port')) throw new Error('模板只能包含 ip 和 port。');
  if (!keys.includes('ip') || !keys.includes('port')) throw new Error('模板必须同时包含 ip 和 port。');
  if (typeof record.ip !== 'string' || !record.ip.trim()) throw new Error('ip 必须是非空字符串。');
  if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65_535) throw new Error('端口必须在 1 到 65535 之间。');
  return { host: record.ip.trim(), port: record.port as number };
}
