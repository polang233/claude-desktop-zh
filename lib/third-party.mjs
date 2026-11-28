import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLayout, discoverInstall } from './discover.mjs';
import { localeValue, readJSON, sha256, writeJSON } from './common.mjs';

const VENDOR = fileURLToPath(new URL('../vendor/javaht/', import.meta.url));
const INSTALLER = path.join(VENDOR, 'scripts', 'install_windows.ps1');
const LAUNCHER = path.join(VENDOR, 'scripts', 'run_plugin_patch.ps1');
const RECOVERY = path.join(VENDOR, 'scripts', 'recover_third_party.ps1');
const STATE = 'third-party-state.json';
const UPSTREAM_COMMIT = 'f23b0292646bdd912f759cec1096d9814ebb01ef';
// Hash after normalizing PowerShell line endings so Git checkouts stay verifiable.
const INSTALLER_SHA256 = '5f844f1fc26006f28607290edb88a7247cfa8bc8b4ab1ccc08acebf167462f70';
const LAUNCHER_SHA256 = '4ca3211a2724a4961cafdc3c35aec160585174ca73477d0dd32daa6366c4e69f';
const RECOVERY_SHA256 = '3ec318a61e6ed0c4ac833a77c5b16e0577b58b8d0b6c082b029f28cd2881f552';
const LANGUAGES = Object.freeze({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' });
const MARKERS = ['zh-CN.json', 'zh-TW.json', 'zh-HK.json'];
const REQUIRED_RESOURCES = [
  'slash-command-glosses.json',
  'slash-command-menu-patch.json',
  ...Object.values(LANGUAGES).flatMap(language => [
    `frontend-${language}.json`,
    `frontend-hardcoded-${language}.json`,
    `desktop-${language}.json`,
    `desktop-extra-${language}.json`,
    `statsig-${language}.json`,
    `dynamic-${language}.json`
  ])
];

function normalizedHash(file) {
  return sha256(Buffer.from(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')));
}

function bundleStatus() {
  if (!fs.existsSync(INSTALLER) || !fs.existsSync(LAUNCHER) || !fs.existsSync(RECOVERY)) {
    return { commit: UPSTREAM_COMMIT, verified: false, reason: '缺少内置补丁文件，请重新安装或更新插件。' };
  }
  let installerHash, launcherHash, recoveryHash;
  try {
    installerHash = normalizedHash(INSTALLER);
    launcherHash = normalizedHash(LAUNCHER);
    recoveryHash = normalizedHash(RECOVERY);
  }
  catch { return { commit: UPSTREAM_COMMIT, verified: false, reason: '无法读取内置补丁文件。' }; }
  if (installerHash !== INSTALLER_SHA256 || launcherHash !== LAUNCHER_SHA256 || recoveryHash !== RECOVERY_SHA256) {
    return { commit: UPSTREAM_COMMIT, verified: false, reason: '内置补丁文件校验失败，请重新安装或更新插件。' };
  }
  const missing = REQUIRED_RESOURCES.filter(name => !fs.existsSync(path.join(VENDOR, 'resources', name)));
  if (missing.length) {
    return { commit: UPSTREAM_COMMIT, verified: false, reason: '内置中文资源不完整，请重新安装或更新插件。' };
  }
  return { commit: UPSTREAM_COMMIT, verified: true };
}

function stateFile(directory) {
  return path.join(path.resolve(directory), STATE);
}

function readState(directory) {
  try {
    const value = readJSON(stateFile(directory));
    return value?.schema === 1 && typeof value.status === 'string' ? value : null;
  } catch { return null; }
}

function resourcesAt(source) {
  for (const candidate of [path.join(source, 'resources'), path.join(source, 'app', 'resources')]) {
    if (fs.existsSync(path.join(candidate, 'ion-dist.asar')) || fs.existsSync(path.join(candidate, 'ion-dist'))) {
      return candidate;
    }
  }
  return null;
}

function resolveSource(explicit, recorded) {
  const candidates = [explicit, recorded].filter(value => typeof value === 'string' && path.isAbsolute(value));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'claude.exe')) && resourcesAt(candidate)) return path.resolve(candidate);
  }
  return path.resolve(discoverInstall().source);
}

function markerFiles(resources) {
  return MARKERS.filter(name => fs.existsSync(path.join(resources, name)));
}

function backupSets(resources) {
  const root = path.join(resources, '.zh-cn-backups');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => path.join(root, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch { return []; }
}

function publicStatus(directory, source, resources, bundle, state) {
  const files = resources ? markerFiles(resources) : [];
  const backups = resources ? backupSets(resources) : [];
  let status = 'not-installed';
  if (files.length) status = backups.length ? 'installed' : 'incomplete';
  else if (state?.status === 'applying' || state?.status === 'restoring' || state?.status === 'failed') status = 'incomplete';
  else if (state?.status === 'restored') status = 'restored';
  const backupDirectory = state?.backupDirectory && fs.existsSync(state.backupDirectory)
    ? state.backupDirectory : backups[0] ?? null;
  return {
    schema: 1,
    mode: 'third-party',
    supported: true,
    status,
    source,
    resources,
    locale: state?.locale ?? null,
    language: state?.language ?? null,
    files,
    backupDirectory,
    backups: backups.length,
    bundle,
    stateDirectory: path.resolve(directory),
    canApply: Boolean(source && resources && bundle.verified),
    canRestore: Boolean(source && resources && bundle.verified &&
      (files.length || (backups.length && ['applying', 'restoring', 'failed'].includes(state?.status))))
  };
}

export function thirdPartyStatus(options = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const directory = options.stateDirectory ?? path.join(defaultLayout().originalStateDirectory, 'third-party');
  const bundle = bundleStatus();
  if (platform !== 'win32') {
    return {
      schema: 1, mode: 'third-party', supported: false, status: 'unsupported',
      reason: '第三方补丁仅支持 Windows。', bundle, stateDirectory: path.resolve(directory),
      canApply: false, canRestore: false
    };
  }
  const state = readState(directory);
  let source;
  try { source = resolveSource(options.source, state?.source); }
  catch {
    return {
      schema: 1, mode: 'third-party', supported: true, status: 'unavailable',
      reason: '未找到可用的 Claude Desktop 安装。', bundle, stateDirectory: path.resolve(directory),
      recordedSource: state?.source ?? null, canApply: false, canRestore: false
    };
  }
  return publicStatus(directory, source, resourcesAt(source), bundle, state);
}

function assertNoClaudeRunning(source) {
  if (process.platform !== 'win32') throw new Error('第三方补丁仅支持 Windows。');
  const query = [
    '$source = $env:CLAUDE_3P_ZH_SOURCE',
    '@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {',
    '  $path = $_.ExecutablePath',
    '  if (-not $path) { return $false }',
    "  $desktopPath = $path.StartsWith($source, [System.StringComparison]::OrdinalIgnoreCase) -or $path -match '(?i)\\\\WindowsApps\\\\[^\\\\]*Claude[^\\\\]*\\\\' -or $path -match '(?i)\\\\AnthropicClaude\\\\app-' -or $path -match '(?i)\\\\scoop\\\\apps\\\\(?:claude|claude-desktop)'",
    "  ($_.Name -ieq 'claude.exe' -or $_.Name -ieq 'cowork-svc.exe') -and $desktopPath",
    '}).Count'
  ].join('; ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, CLAUDE_3P_ZH_SOURCE: source }
  }).trim();
  if (output !== '0') throw new Error('请先通过 Claude 的「文件 → 退出」完全退出，并等待 Cowork 服务结束。');
}

function runLauncher(action, language, source, directory, backupDirectory) {
  const resultFile = path.join(path.resolve(directory), `third-party-${action}-result.json`);
  try { fs.unlinkSync(resultFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(directory, { recursive: true });
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER,
    '-Action', action, '-Language', language, '-ClaudePath', source, '-ResultFile', resultFile,
    ...(backupDirectory ? ['-BackupDirectory', backupDirectory] : [])
  ];
  return new Promise(resolve => {
    execFile('powershell.exe', args, {
      windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      let result;
      try { result = readJSON(resultFile); } catch { result = null; }
      resolve({
        exitCode: result?.exitCode ?? error?.code ?? (error ? 1 : 0),
        cancelled: result?.cancelled === true,
        message: result?.message,
        log: result?.log,
        errorLog: result?.errorLog,
        report: result?.report,
        stdout: String(stdout || '').slice(-4000),
        stderr: String(stderr || '').slice(-4000)
      });
    });
  });
}

function assertBundle(bundle) {
  if (!bundle.verified) throw new Error(bundle.reason || '内置补丁文件不可用。');
}

function settledState(state) {
  if (!state || typeof state !== 'object') return {};
  const next = { ...state };
  delete next.failedAt;
  delete next.error;
  delete next.restoringAt;
  return next;
}

export async function applyThirdParty(options = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('第三方补丁仅支持 Windows。');
  const locale = localeValue(options.locale);
  const language = LANGUAGES[locale];
  const directory = options.stateDirectory ?? path.join(defaultLayout().originalStateDirectory, 'third-party');
  const bundle = bundleStatus();
  assertBundle(bundle);
  const current = thirdPartyStatus({ ...options, locale, stateDirectory: directory }, { platform });
  if (!current.source || !current.resources) throw new Error(current.reason || '未找到可用的 Claude Desktop 安装。');
  await (dependencies.assertStopped ?? assertNoClaudeRunning)(current.source);
  const startedAt = new Date().toISOString();
  writeJSON(stateFile(directory), {
    schema: 1, status: 'applying', source: current.source, locale, language,
    upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256, startedAt
  });
  const result = await (dependencies.runLauncher ?? runLauncher)('install', language, current.source, directory);
  if (result.exitCode !== 0) {
    writeJSON(stateFile(directory), {
      schema: 1, status: 'failed', source: current.source, locale, language,
      upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256, startedAt,
      failedAt: new Date().toISOString(), error: result.cancelled ? 'elevation-cancelled' : 'installer-failed'
    });
    if (result.cancelled) throw new Error('未获得管理员授权，补丁没有应用。');
    throw new Error('第三方补丁执行失败。请确认 Claude 已退出、当前账户可授权管理员，并查看插件状态目录中的日志。');
  }
  const after = thirdPartyStatus({ ...options, locale, stateDirectory: directory }, { platform });
  if (after.status !== 'installed') {
    writeJSON(stateFile(directory), {
      schema: 1, status: 'failed', source: current.source, locale, language,
      upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256, startedAt,
      failedAt: new Date().toISOString(), error: 'install-incomplete'
    });
    throw new Error('补丁命令已结束，但没有检测到完整的中文资源和恢复备份。请打开日志检查。');
  }
  const installed = {
    schema: 1, status: 'installed', source: current.source, locale, language,
    upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256, startedAt,
    installedAt: new Date().toISOString(), backupDirectory: after.backupDirectory
  };
  writeJSON(stateFile(directory), installed);
  return {
    mode: 'third-party', status: 'installed', locale, source: current.source,
    backupDirectory: after.backupDirectory, upstream: UPSTREAM_COMMIT,
    log: result.log ?? null
  };
}

export async function restoreThirdParty(options = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('第三方补丁仅支持 Windows。');
  const directory = options.stateDirectory ?? path.join(defaultLayout().originalStateDirectory, 'third-party');
  const bundle = bundleStatus();
  assertBundle(bundle);
  const current = thirdPartyStatus({ ...options, stateDirectory: directory }, { platform });
  if (!current.source || !current.resources) throw new Error(current.reason || '未找到可用的 Claude Desktop 安装。');
  if (!current.files.length && (current.status === 'restored' || !current.backups)) {
    return { mode: 'third-party', status: 'not-installed', alreadyRestored: true, source: current.source };
  }
  await (dependencies.assertStopped ?? assertNoClaudeRunning)(current.source);
  const state = readState(directory);
  writeJSON(stateFile(directory), {
    ...(state || {}), schema: 1, status: 'restoring', source: current.source,
    locale: state?.locale ?? null, language: state?.language ?? null,
    upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256, restoringAt: new Date().toISOString()
  });
  if (!current.backupDirectory) throw new Error('找不到可用的补丁恢复备份。');
  const result = await (dependencies.runLauncher ?? runLauncher)('recover', state?.language ?? 'zh-CN', current.source, directory, current.backupDirectory);
  if (result.exitCode !== 0) {
    writeJSON(stateFile(directory), {
      ...(state || {}), schema: 1, status: 'failed', source: current.source,
      upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256,
      failedAt: new Date().toISOString(), error: result.cancelled ? 'elevation-cancelled' : 'restore-failed'
    });
    if (result.cancelled) throw new Error('未获得管理员授权，原始资源没有恢复。');
    throw new Error('恢复命令执行失败。请确认 Claude 已退出，并查看插件状态目录中的日志。');
  }
  const after = thirdPartyStatus({ ...options, stateDirectory: directory }, { platform });
  if (after.files.length) {
    writeJSON(stateFile(directory), {
      ...(state || {}), schema: 1, status: 'failed', source: current.source,
      upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256,
      failedAt: new Date().toISOString(), error: 'restore-incomplete'
    });
    throw new Error('恢复命令已结束，但仍有中文资源未移除。请查看日志后重试。');
  }
  const restored = {
    ...settledState(state), schema: 1, status: 'restored', source: current.source,
    locale: state?.locale ?? null, language: state?.language ?? null,
    upstream: UPSTREAM_COMMIT, scriptSha256: INSTALLER_SHA256,
    restoredAt: new Date().toISOString()
  };
  writeJSON(stateFile(directory), restored);
  return {
    mode: 'third-party', status: 'restored', source: current.source,
    retained: 'Claude 的登录和会话没有由插件改写；语言配置已恢复为英文。',
    log: result.log ?? null
  };
}
