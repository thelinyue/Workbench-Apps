import { describe, expect, it } from 'vitest';
import { parseConnectionTemplate } from '../renderer/connection-template';

describe('SSH JSON 连接模板', () => {
  it('严格接受 ip 和 port 并映射为主机表单值', () => {
    expect(parseConnectionTemplate('{"port": 2222, "ip": "example.com"}')).toEqual({ host: 'example.com', port: 2222 });
  });

  it.each([
    ['', '请粘贴 JSON 连接模板。'],
    ['{"ip":"host"}', '模板必须同时包含 ip 和 port。'],
    ['{"ip":"host","port":0}', '端口必须在 1 到 65535 之间。'],
    ['{"ip":"host","port":22,"extra":true}', '模板只能包含 ip 和 port。'],
    ['not-json', 'JSON 格式不正确。']
  ])('拒绝无效模板 %#', (input, message) => {
    expect(() => parseConnectionTemplate(input)).toThrow(message);
  });
});
