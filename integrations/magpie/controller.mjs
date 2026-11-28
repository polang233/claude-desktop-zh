import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { defaultLayout } from '../../lib/discover.mjs';

// Fixed CLI commands only. Explicit paths take priority; discovery is lazy so
// restoring a managed copy never depends on the original app or gateway.
export const WRITES = ['install', 'prepare', 'switch', 'restore', 'import-cache', 'third-party-apply', 'third-party-restore'];
export const ACTIONS = ['check', 'install', 'discover', 'detect', 'status', 'plan', 'import-cache', 'prepare', 'switch', 'restore', 'launch',
  'third-party-status', 'third-party-apply', 'third-party-restore'];

export function createController(options = {}, runProcess = runCLI) {
  let busy = false, phase;
  let lastSync = { state: 'not-run' };
  const defaults = defaultLayout();
  const root = options.managedRoot || defaults.managedRoot;
  const mode = options.mode ?? 'original';
  if (!['original', 'copy'].includes(mode)) throw new Error('Mode must be original or copy.');
  const preferenceDirectory = options.stateDirectory || defaults.originalStateDirectory;
  const thirdPartyStateDirectory = path.join(preferenceDirectory, 'third-party');
  // Historical CLI transactions live alongside preferences. New backups need an empty directory.
  const legacyManifest = path.join(preferenceDirectory, 'original-state.json');
  const stateDirectory = fs.existsSync(legacyManifest) ? preferenceDirectory : path.join(preferenceDirectory, 'resource-backup');
  const catalog = options.catalogDirectory || defaults.catalogDirectory;
  function configuration() {
    const project = path.resolve(options.projectDirectory || fileURLToPath(new URL('../../', import.meta.url)));
    const metadata = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    if (metadata.name !== 'magpie-claude-zh') throw new Error('projectDirectory is not this project.');
    // Bun on Windows can reject scandir in a readable WindowsApps package.
    // Use the project's required Node runtime for CLI filesystem operations.
    const executable = options.nodeExecutable || (process.platform === 'win32' && process.versions.bun ? 'node.exe' : process.execPath);
    return { executable, cli: path.join(project, 'bin', 'claude-3p-zh.mjs'), cwd: project };
  }
  function locale(value = options.locale ?? 'zh-Hans') {
    if (!['zh-Hans', 'zh-Hant'].includes(value)) throw new Error('Language must be zh-Hans or zh-Hant.');
    return value;
  }
  function optional(flag, value) { return value ? [flag, value] : []; }
  const catalogArgs = () => ['--catalog-dir', catalog];
  const profileArgs = () => optional('--profile-dir', options.profileDirectory);
  const sourceArgs = () => optional('--source', options.sourceDirectory);
  async function command(action, language = locale(), source = options.sourceDirectory) {
    let args;
    switch (action) {
      case 'discover': args = ['discover', ...sourceArgs(), ...profileArgs(), '--root', root, ...catalogArgs()]; break;
      case 'detect': args = ['detect-3p', ...profileArgs()]; break;
      case 'check': args = ['original-check', ...sourceArgs(), '--state-dir', stateDirectory]; break;
      case 'install': args = ['original-install', ...optional('--source', source), '--state-dir', stateDirectory, '--locale', language, ...catalogArgs()]; break;
      case 'status': args = mode === 'original' ? ['original-status', '--state-dir', stateDirectory] : ['status', '--root', root]; break;
      case 'plan': args = mode === 'original' ? ['original-plan', ...optional('--source', source), '--state-dir', stateDirectory, '--locale', language, ...catalogArgs()] : ['plan', ...sourceArgs(), '--locale', language, ...catalogArgs()]; break;
      case 'import-cache': args = ['catalog', 'cache', ...optional('--cache', options.cacheDirectory), '--locale', language, ...catalogArgs()]; break;
      case 'prepare': args = ['prepare-copy', ...sourceArgs(), '--destination', root, ...optional('--gateway-profile', options.gatewayProfile), ...profileArgs(), '--locale', language, ...catalogArgs()]; break;
      case 'switch': args = mode === 'original' ? ['original-switch', '--state-dir', stateDirectory, '--locale', language, ...catalogArgs()] : ['switch', '--root', root, '--locale', language, ...catalogArgs()]; break;
      case 'restore': args = mode === 'original' ? ['original-restore', '--state-dir', stateDirectory] : ['restore', '--root', root]; break;
      case 'launch': args = ['launch', '--root', root]; break;
      case 'third-party-status': args = ['third-party-status', ...optional('--source', source), '--state-dir', thirdPartyStateDirectory]; break;
      case 'third-party-apply': args = ['third-party-apply', ...optional('--source', source), '--state-dir', thirdPartyStateDirectory, '--locale', language]; break;
      case 'third-party-restore': args = ['third-party-restore', ...optional('--source', source), '--state-dir', thirdPartyStateDirectory]; break;
      default: throw new Error('Unsupported action.');
    }
    phase = action;
    return runProcess(configuration(), args);
  }
  async function execute(action, confirmation = '', selection = {}) {
    if (!ACTIONS.includes(action)) throw new Error('Unsupported action.');
    const language = locale(selection.locale);
    if (mode === 'original' && ['prepare', 'launch'].includes(action)) throw new Error('Copy actions require explicit mode: copy. Original mode never creates or launches a separate profile.');
    if (mode === 'copy' && ['install', 'check'].includes(action)) throw new Error('Original-install actions require mode: original.');
    if (mode === 'copy' && action.startsWith('third-party-')) throw new Error('Third-party patch actions require mode: original.');
    if (action === 'third-party-apply' && options.method !== 'third-party') throw new Error('请先在插件页选择「内置补丁」。');
    if (action === 'launch' && confirmation !== action) throw new Error('Confirm the exact action.');
    if (busy) throw new Error('Another plugin operation is running.');
    if (WRITES.includes(action)) {
      if (options.allowWrites === false) throw new Error('Writes disabled by saved allowWrites: false.');
      if (confirmation !== action) throw new Error('Confirm the exact action.');
    }
    const resourceWrite = mode === 'original' && ['install', 'switch', 'restore'].includes(action);
    if (resourceWrite && action !== 'restore' && options.method && options.method !== 'in-place') throw new Error('请先在插件页选择「写入安装资源」。');
    busy = true;
    let source = options.sourceDirectory;
    try {
      if (action === 'prepare' || action === 'install') {
        if (action === 'install') {
          const check = await command('check');
          if (check.protectedInstall || check.runtimeOnly || !check.eligible) throw new Error(check.reason || 'This installation does not support original-mode localization. No copy was created.');
          source = check.source ?? source;
          if (selection.expectedSource && selection.expectedSource !== source) throw new Error('安装位置已改变，请刷新后重新确认。');
        }
        // An explicitly chosen Gateway file is validated by prepare-copy itself.
        if (action === 'install' || !options.gatewayProfile) {
          const detected = await command('detect');
          if (!detected.configured3p || detected.provider !== 'gateway') throw new Error('Claude is not configured for 3p Gateway. Configure it in magpie first.');
        }
        try { await command('plan', language, source); }
        catch (error) {
          if (!/^(?:Error: )?Missing compatible zh-Han[st] base\/dynamic catalogs\./.test(error.message)) throw error;
          await command('import-cache', language);
          await command('plan', language, source);
        }
      }
      if (mode === 'original' && action === 'switch') {
        try { return await command('switch', language); }
        catch (error) {
          // original-switch validates state, hashes and stopped processes before
          // planning. A missing-catalog failure occurs before resource writes.
          if (!/^(?:Error: )?Missing compatible zh-Han[st] base\/dynamic catalogs\./.test(error.message)) throw error;
          await command('import-cache', language);
          return await command('switch', language);
        }
      }
      return await command(action, language, source);
    } catch (error) {
      if (resourceWrite && /\b(?:EACCES|EPERM|EROFS)\b|access (?:is )?denied/i.test(error.message)) {
        throw new Error('当前账户无法写入应用或备份目录。请检查目录是否只读，以及当前账户是否有正常写入权限。可在恢复已有更改后选择「启动时加载」。', { cause: error });
      }
      throw error;
    } finally { busy = false; phase = undefined; }
  }
  async function sync() {
    if ((mode === 'original' && options.method) || options.autoSync !== true || options.allowWrites === false) return { state: 'disabled' };
    if (busy) return { state: 'busy' };
    busy = true;
    try {
      const detected = await command('detect');
      if (!detected.configured3p || detected.provider !== 'gateway') return lastSync = { state: 'not-3p-gateway' };
      const current = await command('status');
      if (current.status !== 'installed' || !current.intact) return lastSync = { state: 'not-installed-or-modified' };
      if (current.locale === locale()) return lastSync = { state: 'up-to-date', locale: locale() };
      await command('switch');
      return lastSync = { state: 'switched', locale: locale() };
    } catch (error) { return lastSync = { state: 'deferred', reason: error.message }; }
    finally { busy = false; phase = undefined; }
  }
  return {
    execute, sync,
    hasOriginalTransaction: () => fs.existsSync(path.join(stateDirectory, 'original-state.json')),
    runtimeConfiguration: configuration,
    runtimeSource: () => runProcess(configuration(), ['runtime-source', ...sourceArgs()]),
    async prepareRuntime(output, sourceDirectory = options.sourceDirectory, runtimeCache) {
      if (mode !== 'original' || options.method === 'in-place' || options.allowWrites === false) throw new Error('Runtime localization is disabled.');
      if (busy) throw new Error('Another plugin operation is running.');
      busy = true;
      try {
        const detected = await command('detect');
        if (!detected.configured3p || detected.provider !== 'gateway') throw new Error('Configure the original Claude for 3p Gateway first.');
        const config = configuration();
        const localCatalog = path.join(config.cwd, '.catalogs');
        const selectedCatalog = options.catalogDirectory ?? (fs.existsSync(localCatalog) ? localCatalog : catalog);
        const exportRuntime = () => runProcess(config, ['runtime-export', ...optional('--source', sourceDirectory), '--locale', locale(), '--catalog-dir', selectedCatalog, '--output', output, ...optional('--runtime-cache', runtimeCache)]);
        try { return { ...await exportRuntime(), profileDirectory: detected.directory }; }
        catch (error) {
          if (!/^(?:Error: )?Missing compatible zh-Han[st] base\/dynamic catalogs\./.test(error.message)) throw error;
          try { await runProcess(config, ['catalog', 'cache', ...optional('--cache', options.cacheDirectory), '--locale', locale(), '--catalog-dir', selectedCatalog]); }
          catch (cacheError) {
            if (!/^(?:Error: )?No (?:language cache found\.|readable zh-Han[st] catalog in discovered caches\.)/.test(cacheError.message)) throw cacheError;
          }
          try { return { ...await exportRuntime(), profileDirectory: detected.directory }; }
          catch (missing) {
            if (!/^(?:Error: )?Missing compatible zh-Han[st] base\/dynamic catalogs\./.test(missing.message)) throw missing;
          }
          // Fresh installs need no manual cache/import command. Fetch accepts
          // official catalog URLs only; export still verifies compatibility.
          for (const kind of ['base', 'dynamic']) await runProcess(config, ['catalog', 'fetch', '--kind', kind, '--locale', locale(), '--catalog-dir', selectedCatalog]);
          return { ...await exportRuntime(), profileDirectory: detected.directory };
        }
      } finally { busy = false; phase = undefined; }
    },
    state: () => ({ ...lastSync, busy, phase: busy ? phase : undefined, locale: locale(), allowWrites: options.allowWrites !== false }),
    paths: async () => {
      const discovered = await command('discover');
      return { mode, stateDirectory, source: options.sourceDirectory || discovered.source, root, profile: options.profileDirectory || discovered.profileDirectory,
        gateway: options.gatewayProfile || discovered.gatewayProfile, catalog, cache: options.cacheDirectory || '',
        caches: options.cacheDirectory ? [options.cacheDirectory] : discovered.caches || [], issues: discovered.issues || {},
        locale: locale(), allowWrites: options.allowWrites !== false, autoSync: false };
    }
  };
}
// Keep page and tool actions on the same controller while replacing runtime hosts.
export async function createLocalizationSession(options, store, makeRuntime, ownerCurrent, controllerFactory = createController) {
  const initial = store.snapshot();
  let preferences = initial.value, revision = initial.revision;
  const exclusive = action => store.exclusive ? store.exclusive(action) : action();
  function assertCurrent(expectedRevision) {
    ownerCurrent();
    if (store.revision && (store.revision() !== revision || (expectedRevision !== undefined && expectedRevision !== revision))) {
      throw Object.assign(new Error('汉化设置已在另一个页面或宿主更改，请重新打开插件页。'), { status: 409 });
    }
  }
  let controller = controllerFactory({ ...options, ...preferences });
  const original = options.mode !== 'copy';
  async function resourcesRestored() {
    if (!controller.hasOriginalTransaction()) return true;
    try { return ['restored', 'not-installed'].includes((await controller.execute('status')).status); }
    catch { return false; }
  }
  if (original && preferences.method === 'runtime' && preferences.runtimeAutoLoad && !await resourcesRestored()) {
    // Older plugin versions could write resources without saving a method.
    preferences = { ...preferences, method: 'in-place', runtimeAutoLoad: false };
    controller = controllerFactory({ ...options, ...preferences });
  }
  let changing = false;
  let runtime;
  function start(skipExisting) {
    runtime = makeRuntime({ ...preferences, runtimeAutoLoad: preferences.method === 'runtime' && preferences.runtimeAutoLoad }, controller, skipExisting);
    void runtime.start();
  }
  await exclusive(() => { assertCurrent(); start(false); });
  return {
    paths: () => controller.paths(),
    state: () => ({ ...controller.state(), busy: changing || controller.state().busy }),
    checkCurrent: assertCurrent,
    revision: () => revision,
    execute: async (action, confirm, selection) => {
      if (changing) throw new Error('正在切换汉化设置，请稍后重试。');
      const run = () => {
        assertCurrent(selection?.revision);
        return controller.execute(action, confirm, selection);
      };
      return WRITES.includes(action) || action === 'launch' ? exclusive(run) : run();
    },
    get: () => ({ ...preferences }),
    runtime: () => runtime.state(),
    async save(next, expectedRevision, confirmMethod) {
      if (changing || controller.state().busy) throw new Error('其他操作进行中，请稍后重试。');
      changing = true;
      try { return await exclusive(async () => {
        assertCurrent(expectedRevision);
        const methodChanged = next.method !== preferences.method;
        if (methodChanged) {
          if (!original) throw new Error('独立测试副本不支持切换汉化方式。');
          if (confirmMethod !== next.method) throw Object.assign(new Error('请确认切换汉化方式。'), { status: 400 });
          if (preferences.method === 'third-party' && next.method !== 'third-party') {
            const patch = await controller.execute('third-party-status').catch(() => null);
            if (patch && ['installed', 'incomplete'].includes(patch.status)) {
              throw Object.assign(new Error('请先恢复 Claude 原样，再切换汉化方式。'), { status: 409 });
            }
          }
          if (next.method === 'third-party' && !await resourcesRestored()) {
            throw Object.assign(new Error('请先恢复已写入的安装资源，再启用内置补丁。'), { status: 409 });
          }
        }
        if (methodChanged || next.method !== 'runtime') next = { ...next, runtimeAutoLoad: false };
        if (original && next.method === 'runtime' && next.runtimeAutoLoad && !await resourcesRestored()) {
          throw Object.assign(new Error('请先恢复原始资源，再启用启动时加载。'), { status: 409 });
        }
        await runtime.stopped();
        // Only replace the old listener after its shutdown and owner check succeed.
        assertCurrent(expectedRevision);
        try { preferences = store.write(next); revision = store.revision(); }
        catch (error) { start(true); throw error; }
        controller = controllerFactory({ ...options, ...preferences });
        start(true);
        return { ...preferences };
      }); } finally { changing = false; }
    }
  };
}
function runCLI(config, args) {
  return new Promise((resolve, reject) => {
    execFile(config.executable, [config.cli, ...args], { cwd: config.cwd, windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr.trim() || 'CLI failed or exceeded 45 seconds. Inspect the managed copy before retrying.')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('CLI did not return JSON.')); }
    });
  });
}
