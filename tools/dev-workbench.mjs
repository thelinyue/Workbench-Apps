import { access, watch } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedAppIds = new Set(['analysis-center', 'lvm-uncache-tool', 'terminal', 'log-rule-editor']);

/**
 * 校验本地联调所需的两个同级仓库和目标应用。
 *
 * 启动器只传入一个应用的 dist，Workbench 因此不会自动加载工作目录中的其他未发布代码。
 */
export async function validateDevWorkbenchPaths(appId, appsRoot = root, workbenchRoot = resolve(root, '..', 'Hephaestus Workbench')) {
  if (!supportedAppIds.has(appId)) throw new Error(`不支持本地联调的应用：${appId ?? '未指定'}。可选值：${[...supportedAppIds].join('、')}。`);
  try {
    await access(join(workbenchRoot, 'package.json'));
  } catch {
    throw new Error(`找不到 Workbench：${workbenchRoot}。请确认 Workbench-Apps 与 Hephaestus Workbench 位于同级目录。`);
  }
  const appDirectory = join(appsRoot, 'apps', appId);
  try {
    await access(join(appDirectory, 'manifest.json'));
  } catch {
    throw new Error(`本地应用目录缺少 manifest.json：${appDirectory}`);
  }
  return { appDirectory, distDirectory: join(appDirectory, 'dist'), workbenchRoot };
}

async function main() {
  const appId = process.argv[2];
  const paths = await validateDevWorkbenchPaths(appId);
  await buildApp(appId);
  console.log(`已构建本地应用：${appId}。正在启动 Workbench 开发模式…`);

  let rebuildTimer;
  let buildRunning = false;
  let rebuildQueued = false;
  let stopped = false;
  const watcher = watch(paths.appDirectory, { recursive: true });
  const devCommand = getWorkbenchDevCommand();
  const workbench = spawn(devCommand.command, devCommand.args, {
    cwd: paths.workbenchRoot,
    env: { ...process.env, HEPHAESTUS_DEV_APP_ID: appId, HEPHAESTUS_DEV_APP_DIST: paths.distDirectory },
    stdio: 'inherit',
    windowsHide: true
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(rebuildTimer);
    void watcher.return();
    terminate(workbench);
  };
  const scheduleBuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (buildRunning) { rebuildQueued = true; return; }
      void rebuildAfterChange();
    }, 150);
  };
  const rebuildAfterChange = async () => {
    buildRunning = true;
    try {
      console.log(`检测到 ${appId} 源码变化，正在重新构建…`);
      await buildApp(appId);
      console.log(`本地应用构建完成：${appId}。请在工作台窗口中点击“重新加载开发应用”。`);
    } catch (error) {
      console.error(`本地应用构建失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      buildRunning = false;
      if (rebuildQueued) { rebuildQueued = false; scheduleBuild(); }
    }
  };

  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  workbench.once('error', (error) => { console.error(`无法启动 Workbench 开发模式：${error.message}`); stop(); process.exitCode = 1; });
  workbench.once('exit', (code) => { if (!stopped) { stop(); process.exitCode = code ?? 0; } });

  try {
    for await (const event of watcher) {
      const file = typeof event.filename === 'string' ? event.filename : '';
      const changedPath = relative(paths.appDirectory, resolve(paths.appDirectory, file)).replaceAll('\\', '/');
      if (!changedPath || changedPath === 'dist' || changedPath.startsWith('dist/')) continue;
      scheduleBuild();
    }
  } catch (error) {
    if (!stopped) {
      console.error(`本地应用文件监听失败：${error instanceof Error ? error.message : String(error)}`);
      stop();
      process.exitCode = 1;
    }
  }
}

function buildApp(appId) {
  return new Promise((resolveBuild, rejectBuild) => {
    const command = getNpmRunCommand(`build:${appId}`);
    const child = spawn(command.command, command.args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => rejectBuild(new Error(`无法启动应用构建：${error.message}`)));
    child.once('exit', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`构建命令退出码：${code ?? '未知'}`)));
  });
}

/** Windows 不能可靠地直接由 Node spawn .cmd；通过 cmd.exe 保持本机 npm 的调用语义。 */
export function getWorkbenchDevCommand(platform = process.platform) {
  return getNpmRunCommand('dev', platform);
}

/** 统一包装 npm 调用，避免 Windows 下直接 spawn .cmd 返回 EINVAL。 */
export function getNpmRunCommand(script, platform = process.platform) {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd run ${script}`] }
    : { command: 'npm', args: ['run', script] };
}

function terminate(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(`本地工作台联调启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
