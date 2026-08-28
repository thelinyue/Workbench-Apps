import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TransferService, type TransferChannel } from '../backend/transfer-service';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-transfer-'));
  directories.push(directory);
  return directory;
}

function completed(serviceEvents: Array<(state: string) => void>) {
  return new Promise<void>((resolve, reject) => serviceEvents.push((state) => state === 'completed' ? resolve() : state === 'failed' ? reject(new Error('transfer failed')) : undefined));
}

function stateReached(serviceEvents: Array<(state: string) => void>, expected: string) {
  return new Promise<void>((resolve) => serviceEvents.push((state) => state === expected ? resolve() : undefined));
}

describe('后台传输任务', () => {
  it('下载先写同目录临时文件，完整结束后再提交目标文件', async () => {
    const directory = await temporaryDirectory();
    const localPath = join(directory, 'system.log');
    const listeners: Array<(state: string) => void> = [];
    const done = completed(listeners);
    const channel: TransferChannel = {
      stat(_path, callback) { callback(undefined, { size: 11 }); },
      createReadStream() { return Readable.from([Buffer.from('hello '), Buffer.from('world')]); },
      createWriteStream() { throw new Error('not used'); },
      rename(_from, _to, callback) { callback(undefined); },
      unlink(_path, callback) { callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: (_event, task) => listeners.forEach((listener) => listener((task as { state: string }).state)) });

    const task = await service.download({ sessionId: 'session-1', remotePath: '/var/log/system.log', localPath, overwrite: false });
    await done;

    expect(await readFile(localPath, 'utf8')).toBe('hello world');
    expect((await readdir(directory)).some((name) => name.includes('.workbench-part-'))).toBe(false);
    expect(service.list()).toMatchObject([{ id: task.id, state: 'completed', transferredBytes: 11, totalBytes: 11 }]);
  });

  it('暂停和恢复只改变对应后台任务且不依赖 renderer', async () => {
    const directory = await temporaryDirectory();
    const source = new PassThrough();
    const listeners: Array<(state: string) => void> = [];
    const done = completed(listeners);
    const channel: TransferChannel = {
      stat(_path, callback) { callback(undefined, { size: 4 }); },
      createReadStream() { return source; },
      createWriteStream() { throw new Error('not used'); },
      rename(_from, _to, callback) { callback(undefined); },
      unlink(_path, callback) { callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: (_event, task) => listeners.forEach((listener) => listener((task as { state: string }).state)) });
    const task = await service.download({ sessionId: 'session-a', remotePath: '/tmp/data', localPath: join(directory, 'data'), overwrite: false });

    service.pause(task.id);
    expect(service.list()).toMatchObject([{ id: task.id, state: 'paused' }]);
    service.resume(task.id);
    expect(service.list()).toMatchObject([{ id: task.id, state: 'running' }]);
    source.end('data');
    await done;
  });

  it('上传使用远端临时文件并在完整写入后重命名', async () => {
    const directory = await temporaryDirectory();
    const localPath = join(directory, 'metrics.log');
    await writeFile(localPath, 'metrics-data', 'utf8');
    const remote = new Map<string, string>();
    const listeners: Array<(state: string) => void> = [];
    const done = completed(listeners);
    const channel: TransferChannel = {
      stat(_path, callback) { callback(new Error('不存在')); },
      createReadStream() { throw new Error('not used'); },
      createWriteStream(path) {
        const stream = new PassThrough();
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('finish', () => remote.set(path, Buffer.concat(chunks).toString('utf8')));
        return stream;
      },
      rename(from, to, callback) { remote.set(to, remote.get(from) ?? ''); remote.delete(from); callback(undefined); },
      unlink(path, callback) { remote.delete(path); callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: (_event, task) => listeners.forEach((listener) => listener((task as { state: string }).state)) });

    const [task] = await service.upload({ sessionId: 'session-1', localPaths: [localPath], remoteDirectory: '/var/log', overwrite: false });
    await done;

    expect(remote.get('/var/log/metrics.log')).toBe('metrics-data');
    expect([...remote.keys()].some((path) => path.includes('.workbench-part-'))).toBe(false);
    expect(service.list()).toMatchObject([{ id: task.id, state: 'completed', direction: 'upload' }]);
  });

  it('取消任务会清理临时文件且清理已完成不会删除失败记录', async () => {
    const directory = await temporaryDirectory();
    const source = new PassThrough();
    const channel: TransferChannel = {
      stat(_path, callback) { callback(undefined, { size: 10 }); },
      createReadStream() { return source; },
      createWriteStream() { throw new Error('not used'); },
      rename(_from, _to, callback) { callback(undefined); },
      unlink(_path, callback) { callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: () => undefined });
    const task = await service.download({ sessionId: 'session-1', remotePath: '/tmp/large', localPath: join(directory, 'large'), overwrite: false });

    await service.cancel(task.id);

    expect(service.list()).toMatchObject([{ id: task.id, state: 'cancelled' }]);
    expect((await readdir(directory)).some((name) => name.includes('.workbench-part-'))).toBe(false);
    expect(service.clearCompleted()).toBe(0);
  });

  it('全部暂停只影响运行中任务，恢复后仍能分别完成', async () => {
    const directory = await temporaryDirectory();
    const sources = [new PassThrough(), new PassThrough()];
    const listeners: Array<(state: string) => void> = [];
    let completedCount = 0;
    const allCompleted = new Promise<void>((resolve) => listeners.push((state) => {
      if (state === 'completed' && ++completedCount === 2) resolve();
    }));
    const channel: TransferChannel = {
      stat(_path, callback) { callback(undefined, { size: 4 }); },
      createReadStream() { return sources.shift()!; },
      createWriteStream() { throw new Error('not used'); },
      rename(_from, _to, callback) { callback(undefined); },
      unlink(_path, callback) { callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: (_event, task) => listeners.forEach((listener) => listener((task as { state: string }).state)) });
    const firstSource = sources[0];
    const secondSource = sources[1];
    const first = await service.download({ sessionId: 'session-1', remotePath: '/a', localPath: join(directory, 'a'), overwrite: false });
    const second = await service.download({ sessionId: 'session-2', remotePath: '/b', localPath: join(directory, 'b'), overwrite: false });

    expect(service.pauseAll()).toBe(2);
    expect(service.list().map((task) => task.state)).toEqual(['paused', 'paused']);
    service.resume(first.id);
    service.resume(second.id);
    firstSource.end('data');
    secondSource.end('data');
    await allCompleted;
  });

  it('失败任务重试时保留原记录并创建新的可完成任务', async () => {
    const directory = await temporaryDirectory();
    const listeners: Array<(state: string) => void> = [];
    let attempt = 0;
    const channel: TransferChannel = {
      stat(_path, callback) { callback(undefined, { size: 4 }); },
      createReadStream() {
        attempt += 1;
        if (attempt === 1) return Readable.from((async function* () { throw new Error('网络中断'); })());
        return Readable.from(['data']);
      },
      createWriteStream() { throw new Error('not used'); },
      rename(_from, _to, callback) { callback(undefined); },
      unlink(_path, callback) { callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: (_event, task) => listeners.forEach((listener) => listener((task as { state: string }).state)) });
    const failed = stateReached(listeners, 'failed');
    const first = await service.download({ sessionId: 'session-1', remotePath: '/data', localPath: join(directory, 'data'), overwrite: false });
    await failed;
    const completedRetry = stateReached(listeners, 'completed');

    const retry = await service.retry(first.id);
    await completedRetry;

    expect(retry.id).not.toBe(first.id);
    expect(service.list()).toMatchObject([{ id: first.id, state: 'failed' }, { id: retry.id, state: 'completed' }]);
    expect(await readFile(join(directory, 'data'), 'utf8')).toBe('data');
  });

  it('backend 完整退出时取消活动任务并清理全部临时文件', async () => {
    const directory = await temporaryDirectory();
    const sources = [new PassThrough(), new PassThrough()];
    const channel: TransferChannel = {
      stat(_path, callback) { callback(undefined, { size: 8 }); },
      createReadStream() { return sources.shift()!; },
      createWriteStream() { throw new Error('not used'); },
      rename(_from, _to, callback) { callback(undefined); },
      unlink(_path, callback) { callback(undefined); }
    };
    const service = new TransferService({ openChannel: async () => channel, emit: () => undefined });
    await service.download({ sessionId: 'session-1', remotePath: '/one', localPath: join(directory, 'one'), overwrite: false });
    await service.download({ sessionId: 'session-2', remotePath: '/two', localPath: join(directory, 'two'), overwrite: false });

    await service.close();

    expect(service.list().map((task) => task.state)).toEqual(['cancelled', 'cancelled']);
    expect((await readdir(directory)).filter((name) => name.includes('.workbench-part-'))).toEqual([]);
  });
});
