import { describe, expect, it } from 'vitest';
import { createLatestLoad } from '../renderer/load-coordinator';

describe('分析中心刷新协调', () => {
  it('旧请求晚返回时不覆盖较新的完成状态', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    const pending = [first.promise, second.promise];
    const load = createLatestLoad(
      async () => pending.shift()!,
      (value) => applied.push(value)
    );

    const firstLoad = load();
    const secondLoad = load();
    second.resolve('已完成');
    await secondLoad;
    first.resolve('分析中');
    await firstLoad;

    expect(applied).toEqual(['已完成']);
  });

  it('较旧请求失败时不覆盖较新的成功刷新', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    const pending = [first.promise, second.promise];
    const load = createLatestLoad(
      async () => pending.shift()!,
      (value) => applied.push(value)
    );

    const firstLoad = load();
    const secondLoad = load();
    second.resolve('已完成');
    await secondLoad;
    first.reject(new Error('旧请求失败'));

    await expect(firstLoad).resolves.toBeUndefined();
    expect(applied).toEqual(['已完成']);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
