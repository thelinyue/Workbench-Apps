/**
 * 为 SSH 任意分块的输出保存尾部未闭合 OSC 控制序列。
 *
 * 只暂存从最后一个 ESC ] 开始且尚未遇到 BEL 的短尾部，普通终端文本会立即交给调用方。
 * 缓冲完全位于本地 Session 内存，Session 销毁后随对象一起释放。
 */
export class OscStreamBuffer {
  private pending = '';

  public consume(data: string, transform: (completeData: string) => string): string {
    const combined = this.pending + data;
    this.pending = '';
    const start = incompleteOscStart(combined);
    if (start < 0) return transform(combined);
    this.pending = combined.slice(start);
    return transform(combined.slice(0, start));
  }
}

function incompleteOscStart(data: string): number {
  const escapeIndex = data.lastIndexOf('\u001b');
  if (escapeIndex < 0) return -1;
  const suffix = data.slice(escapeIndex);
  if (suffix === '\u001b') return escapeIndex;
  return suffix.startsWith('\u001b]') && !suffix.includes('\u0007') ? escapeIndex : -1;
}
