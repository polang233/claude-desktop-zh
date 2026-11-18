import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defaultLayout } from '../../lib/discover.mjs';
import { assertPlainDirectory, localeValue, sha256 } from '../../lib/common.mjs';

const pluginDirectory = fileURLToPath(new URL('.', import.meta.url));
const projectDirectory = fileURLToPath(new URL('../../', import.meta.url));
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))
  : value);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const UPDATE_POLL_MS = 15_000;

// Publish only fixed explanations. CLI errors can contain private paths or URLs.
function preparationFailure(error) {
  const text = error instanceof Error ? error.message : '';
  if (/Official catalog returned HTTP 403/.test(text)) return {
    failureCode: 'catalog-download-denied',
    message: '官方语言文件下载被拒绝。现有中文资源不足，请稍后重新启用插件重试。'
  };
  if (/Missing compatible zh-Han[st] base\/dynamic catalogs/.test(text)) return {
    failureCode: 'catalog-coverage-low',
    message: '中文资源覆盖率需达到 90%。请更新语言资源后重新启用插件。'
  };
  if (/Gateway|No 3p/.test(text)) return {
    failureCode: 'gateway-not-configured', message: '请先将 Claude 配置为第三方 Gateway 模式，再重新启用插件。'
  };
  if (/Unsupported|anchor changed|Language runtime changed/.test(text)) return {
    failureCode: 'frontend-changed', message: '当前 Claude 的语言模块尚未适配，请检查插件更新。'
  };
  return { failureCode: 'preparation-failed', message: '中文准备失败。请检查 Node.js 22 或以上版本及网络连接，再重新启用插件。' };
}

function identifiesPlugin(spec) {
  if (path.isAbsolute(spec)) {
    return [projectDirectory, pluginDirectory, path.join(pluginDirectory, 'server.mjs')].some(directory => samePath(spec, directory));
  }
  if (/^magpie-claude-zh(?:@[^/\s]+)?$/.test(spec)) return true;
  // GitHub installs use github:owner/repo until npm has a matching release.
  // Keep the previous repository URL working through GitHub's rename redirect.
  return /^(?:github:|(?:git\+)?https:\/\/github\.com\/)polang233\/claude-desktop(?:-3p)?-zh(?:\.git)?(?:#[a-z0-9._/-]+)?$/i.test(spec);
}

export function registrySnapshot(directory, options) {
  const file = path.join(directory, 'plugins.json');
  const bytes = fs.readFileSync(file), list = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(list.plugins)) throw new Error('Unknown plugin registry.');
  const ours = list.plugins.filter(entry => typeof entry.spec === 'string' && identifiesPlugin(entry.spec));
  if (ours.length !== 1 || ours[0].off === true || canonical(ours[0].options ?? {}) !== canonical(options)) throw new Error('Plugin registry changed or does not identify this plugin.');
  return { file, hash: sha256(bytes) };
}

// The Windows watcher checks both owner identity and this registry revision
// before UI operations. A retired but busy magpie host cannot keep an old
// language watcher alive after options are saved or the plugin is disabled.
export function createRuntimeHost(input, options, controller, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const startProcess = dependencies.spawn ?? spawn;
  const registry = dependencies.registrySnapshot ?? registrySnapshot;
  let current = { state: 'not-started', locale: options.locale ?? 'zh-Hans', automaticNextLaunch: false };
  let starting, pending, timer, watcher, stateFile, owner, attemptedRevision;
  let stopRequested = false, ownerChanged = false;
  function publish(next) {
    const previous = current;
    current = next;
    if (stateFile) {
      try { fs.writeFileSync(stateFile, JSON.stringify({ ...current, parentProcessId: process.pid }, null, 2)); } catch {}
    }
    const message = next.state === 'waiting-for-normal-exit' && previous.state !== next.state
      ? '请通过 Claude 的“文件 → 退出”正常退出，等待中文准备完成。'
      : next.state === 'watching' && previous.state !== next.state && next.setupChanged === true
        ? '中文已准备好，从原来的入口打开 Claude 即可。'
        : next.state === 'preparation-failed' && previous.state !== next.state ? next.message : null;
    if (message) {
      try { Promise.resolve(input.client?.tui?.showToast({ body: { title: 'Claude 中文', message, variant: 'info' } })).catch(() => {}); } catch {}
    }
  }
  function ownsRegistry() {
    if (stopRequested || ownerChanged) return false;
    try { if (sha256(fs.readFileSync(owner.file)) === owner.hash) return true; } catch {}
    ownerChanged = true;
    publish({ ...current, state: 'owner-changed', automaticNextLaunch: false });
    return false;
  }
  function stopWatcher() {
    if (!watcher) return;
    if (!watcher.stopping) {
      fs.writeFileSync(watcher.stopFile, 'Plugin requested normal watcher stop.\n');
      watcher.stopping = true;
    }
    return watcher.finished;
  }
  function stop() {
    stopRequested = true;
    clearTimeout(timer);
    stopWatcher();
    publish({ ...current, state: watcher ? 'stopping' : 'stopped', automaticNextLaunch: false });
  }
  async function stopped() {
    stop();
    let timeout;
    try {
      await Promise.race([
        (async () => { await pending; await stopWatcher(); })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Watcher has not stopped yet. Try again shortly.')), 10_000); })
      ]);
    } finally { clearTimeout(timeout); }
  }
  function startWatcher(config, base, run, bundle) {
    const stopFile = path.join(run, 'stop');
    const args = ['-NoProfile', '-NonInteractive', '-File', path.join(config.cwd, 'scripts', 'test-runtime-autoload.ps1'),
      '-Manifest', bundle.automationManifest, '-Watch', '-ActivateClaude', '-BuildDirectory', path.join(run, 'bridge'),
      '-ParentProcessId', String(process.pid), '-ParentExecutable', process.execPath, '-ParentStartedBefore', new Date().toISOString(),
      '-RegistryFile', owner.file, '-RegistrySha256', owner.hash, '-StopFile', stopFile,
      '-SetupProfileDirectory', bundle.profileDirectory, '-SetupStateDirectory', path.join(base, 'setup-state'),
      '-SetupNodeExecutable', config.executable, '-SetupCliPath', config.cli];
    if (dependencies.skipClaudeStartedThrough) args.push('-SkipClaudeStartedThrough', dependencies.skipClaudeStartedThrough);
    const child = startProcess('powershell.exe', args, { cwd: config.cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let resolveExit;
    const active = { stopFile, finished: new Promise(resolve => { resolveExit = resolve; }), stopping: false };
    watcher = active;
    publish({ ...current, state: 'starting' });
    let output = '';
    child.stdout.on('data', chunk => {
      if (watcher !== active || active.stopping) return;
      output = (output + chunk.toString()).slice(-32768);
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end).trim(); output = output.slice(end + 1);
        if (line.startsWith('Watching original Claude')) publish({ ...current, state: 'watching', automaticNextLaunch: true });
        else if (line.startsWith('{')) {
          try {
            const result = JSON.parse(line);
            if (result.state === 'WaitingForNormalExit') publish({ ...current, state: 'waiting-for-normal-exit', setupState: result.state, automaticNextLaunch: false });
            else if (result.state === 'RuntimeSetupReady') publish({ ...current, setupState: result.state, setupChanged: result.changed === true, setupJournal: result.journal });
            else if (typeof result.state === 'string') publish({ ...current, lastResult: result.state, lastApplicationPid: result.applicationPid ?? 0 });
          } catch { /* Only fixed JSON result lines are consumed. */ }
        }
      }
    });
    child.stderr.on('data', () => {
      if (watcher === active && !active.stopping) publish({ ...current, runnerReportedError: true });
    });
    function ended(state, exitCode) {
      if (watcher !== active) return;
      watcher = undefined;
      if (stopRequested || !active.stopping) publish({ ...current, state: stopRequested ? 'stopped' : state, exitCode, automaticNextLaunch: false });
      resolveExit();
    }
    child.once('error', () => ended('watcher-start-failed'));
    child.once('exit', code => ended(code === 0 ? 'stopped' : 'watcher-start-failed', code));
    child.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  }
  async function probeSource() {
    const binding = await controller.runtimeSource();
    if (!path.isAbsolute(binding.source) || !/^[a-f0-9]{64}$/.test(binding.revision)) throw new Error('Invalid runtime source identity.');
    return binding;
  }
  async function reconcile() {
    if (!ownsRegistry()) return;
    let binding;
    try { binding = await probeSource(); }
    catch {
      if (!ownsRegistry()) return;
      attemptedRevision = undefined;
      publish({ state: 'source-unverified', locale: current.locale, automaticNextLaunch: false });
      await stopWatcher();
      return;
    }
    if (!ownsRegistry() || binding.revision === attemptedRevision) return;
    if (controller.state?.().busy) return;
    const state = attemptedRevision ? 'rebuilding' : 'preparing';
    publish({ state, locale: current.locale, automaticNextLaunch: false });
    await stopWatcher();
    if (!ownsRegistry()) return;
    if (controller.state?.().busy) return;
    attemptedRevision = binding.revision;
    const base = dependencies.runtimeDirectory ?? path.join(defaultLayout().originalStateDirectory, 'runtime');
    assertPlainDirectory(base);
    fs.mkdirSync(base, { recursive: true });
    const run = fs.mkdtempSync(path.join(base, 'host-'));
    stateFile = path.join(run, 'status.json');
    publish({ ...current, reportDirectory: run });
    const bundle = await controller.prepareRuntime(path.join(run, 'language.js'), binding.source);
    if (!ownsRegistry()) return;
    if (!bundle.profileDirectory || !path.isAbsolute(bundle.profileDirectory)) throw new Error('Missing original profile binding.');
    let confirmed;
    try { confirmed = await probeSource(); } catch {}
    if (!ownsRegistry()) return;
    if (confirmed?.revision !== binding.revision) {
      attemptedRevision = undefined;
      publish({ ...current, state: 'rebuilding' });
      return;
    }
    startWatcher(controller.runtimeConfiguration(), base, run, bundle);
  }
  function cycle() {
    pending = reconcile().catch(error => {
      if (!stopRequested && !ownerChanged) publish({ ...current, state: 'preparation-failed', automaticNextLaunch: false, ...preparationFailure(error) });
    }).then(() => {
      if (!stopRequested && !ownerChanged) {
        timer = setTimeout(cycle, dependencies.pollIntervalMs ?? UPDATE_POLL_MS);
        timer.unref();
      }
      return current;
    });
    return pending;
  }
  function start() {
    if (starting) return starting;
    if (stopRequested) return Promise.resolve(current);
    if (platform !== 'win32' || options.mode === 'copy' || options.allowWrites === false || options.runtimeAutoLoad === false) {
      current = { ...current, state: 'disabled' };
    } else if (!input?.directory || !path.isAbsolute(input.directory)) {
      current = { ...current, state: 'unsupported-host' };
    } else {
      try {
        current = { ...current, locale: localeValue(options.locale) };
        owner = registry(input.directory, options);
        return starting = cycle();
      } catch (error) {
        publish({ ...current, state: 'preparation-failed', ...preparationFailure(error) });
      }
    }
    return starting = Promise.resolve(current);
  }
  return { start, stop, stopped, state: () => ({ ...current }) };
}
