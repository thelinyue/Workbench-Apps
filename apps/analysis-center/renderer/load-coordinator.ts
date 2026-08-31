/**
 * 只应用最后一次加载请求的结果。
 *
 * 页面刷新可能由初始加载、任务事件和用户操作同时触发；旧请求即使晚返回，也不能把较新的
 * 持久化状态覆盖回去。旧请求的错误同样被忽略，避免已经有更新请求接管后仍弹出过时错误。
 */
export function createLatestLoad<T>(load: () => Promise<T>, apply: (value: T) => void): () => Promise<void> {
  let latestRequest = 0;

  return async () => {
    const request = ++latestRequest;
    try {
      const value = await load();
      if (request === latestRequest) apply(value);
    } catch (error) {
      if (request === latestRequest) throw error;
    }
  };
}
