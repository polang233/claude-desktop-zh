import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { promisify } from 'node:util';
import { assertPlainDirectory } from '../../lib/common.mjs';

const keepRuns = 3;
const graceMs = 2n * 60_000n;
const runFiles = new Set(['status.json', 'stop', 'language.js', 'language.js.spec.json',
  'language.js.picker.js', 'language.js.automation.js', 'language.js.automation.json']);
const bridgeFiles = new Set(['RuntimeConsoleBridge.cs', 'RuntimeConsoleBridge.exe', 'setup-owner.json', 'result.json']);
const terminalStates = new Set(['stopped', 'preparation-failed', 'watcher-start-failed']);
const watcherStates = new Set(['preparing', 'starting', 'watching', 'waiting-for-normal-exit', 'owner-changed',
  'source-unverified', 'stopping', 'rebuilding']);

function ownerExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // 状态文件只有 PID。当前 PID 存在（含复用）或无权查询时都保留。
    return error.code === 'ESRCH';
  }
}

async function windowsProcesses() {
  const command = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name,ExecutablePath FROM Win32_Process' | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name
    path = if ($_.Name -eq 'RuntimeConsoleBridge.exe') { $_.ExecutablePath } }
})
ConvertTo-Json -InputObject $rows -Compress`;
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function legacyGuard(snapshot) {
  try {
    const rows = await snapshot();
    if (!Array.isArray(rows) || !rows.some(row => row.pid === process.pid)) return;
    const busy = new Set(), bridges = [];
    for (const { pid, parent, name, path: executable } of rows) {
      if (![pid, parent].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
          || typeof name !== 'string' || !name.trim()) return;
      busy.add(pid);
      busy.add(parent);
      if (name.toLowerCase() !== 'runtimeconsolebridge.exe') continue;
      if (typeof executable !== 'string' || !path.isAbsolute(executable)
          || path.basename(executable).toLowerCase() !== 'runtimeconsolebridge.exe') return;
      bridges.push(fs.realpathSync.native(executable).toLowerCase());
    }
    return ({ pid, run }) => {
      if (busy.has(pid)) return false;
      if (!bridges.length) return true;
      const prefix = fs.realpathSync.native(run).toLowerCase() + path.sep;
      return !bridges.some(executable => executable.startsWith(prefix));
    };
  } catch { /* 查询失败、快照不完整或辅助程序路径不可读时，保留遗留目录。 */ }
}

function stat(file) {
  return fs.lstatSync(file, { bigint: true });
}

function sameEntry(before, after, file) {
  return before && after && before.ino !== 0n && before.dev === after.dev && before.ino === after.ino
    && before.birthtimeNs === after.birthtimeNs && before.mode === after.mode
    && (before.isDirectory() || before.ctimeNs === after.ctimeNs
      // 另一份运行删除同一缓存的硬链接会改变 ctime。
      || (file && path.basename(file) === 'language.js.spec.json' && before.nlink > after.nlink
        && before.size === after.size && before.mtimeNs === after.mtimeNs));
}

function readRecord(file, info, limit) {
  if (!info.isFile() || info.size > BigInt(limit)) return null;
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameEntry(info, fs.fstatSync(fd, { bigint: true }))) return null;
    const bytes = Buffer.alloc(Number(info.size));
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null;
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } finally {
    fs.closeSync(fd);
  }
}

// 只接受宿主、语言包生成器和 PowerShell 监听器实际写出的三层布局。
// 先核对整棵目录树，再逐项删除；新出现的文件会让 rmdir 失败。
function inventory(dir, depth, entries) {
  // 先释放语言包和二进制；文件占用时留着结束报告供下次复核。
  const last = depth === 0 ? 'bridge' : 'result.json';
  const names = fs.readdirSync(dir).sort((a, b) => Number(a === last) - Number(b === last));
  for (const name of names) {
    const file = path.join(dir, name);
    const info = stat(file);
    const directoryAllowed = depth === 0 ? name === 'bridge' : depth === 1 && /^[0-9a-f]{32}$/.test(name);
    if (info.isDirectory() && directoryAllowed) {
      if (!inventory(file, depth + 1, entries)) return false;
    } else if (!info.isFile() || !(depth === 0 ? runFiles.has(name) : depth === 2 && bridgeFiles.has(name))) {
      return false;
    }
    entries.set(file, info);
  }
  return true;
}

function inspect(run) {
  const root = stat(run);
  if (!root.isDirectory()) return;
  const statusFile = path.join(run, 'status.json');
  const statusInfo = stat(statusFile);
  const status = readRecord(statusFile, statusInfo, 64 * 1024);
  if (status?.reportDirectory !== run || !['zh-Hans', 'zh-Hant'].includes(status.locale)
      || typeof status.automaticNextLaunch !== 'boolean'
      || ('released' in status && typeof status.released !== 'boolean')) return;
  const pid = status.parentProcessId;
  const released = status.released === true;
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || (!released && !ownerExited(pid))) return;
  const terminal = terminalStates.has(status.state) && !status.automaticNextLaunch;
  if (!terminal && !watcherStates.has(status.state)) return;

  const entries = new Map();
  if (!inventory(run, 0, entries) || !sameEntry(statusInfo, entries.get(statusFile))) return;
  let updated = statusInfo.mtimeMs;
  let legacy = false;
  if (!released && !terminal) {
    const bridge = path.join(run, 'bridge');
    const builds = [...entries.keys()].filter(file => path.dirname(file) === bridge);
    legacy = !builds.length;
    for (const build of builds) {
      const file = path.join(build, 'result.json');
      const info = entries.get(file);
      if (!info) { legacy = true; continue; }
      const report = readRecord(file, info, 8 * 1024 * 1024);
      if (report?.mode !== 'Watch' || report.parentBound !== true || report.stopFile !== path.join(run, 'stop')) return;
      if (report.finishedAt == null) legacy = true;
      else if (typeof report.finishedAt !== 'string' || !Number.isFinite(Date.parse(report.finishedAt))) return;
      if (info.mtimeMs > updated) updated = info.mtimeMs;
    }
  }
  entries.delete(statusFile);
  entries.set(statusFile, statusInfo);
  entries.set(run, root);
  if (legacy) {
    const cutoff = BigInt(Date.now()) - graceMs;
    for (const info of entries.values()) if (info.mtimeMs > cutoff) return;
  }
  return { run, entries, updated, pid, legacy, released };
}

function removeRun(candidate, base, baseInfo) {
  assertPlainDirectory(base);
  if (!sameEntry(baseInfo, stat(base))) return false;
  const { run, entries, released, pid } = candidate;
  if (!released && !ownerExited(pid)) return false;
  // 快照查询期间目录可能已变更。先复核整棵树，再开始逐项删除。
  const current = new Map([[run, stat(run)]]);
  if (!sameEntry(entries.get(run), current.get(run)) || !inventory(run, 0, current) || current.size !== entries.size) return false;
  for (const [file, info] of entries) {
    const now = current.get(file);
    if (!sameEntry(info, now, file) || info.mtimeNs !== now.mtimeNs) return false;
  }
  const statusFile = path.join(run, 'status.json');
  for (const [file, info] of entries) {
    // 并发清理可能已删掉该项，或同名路径可能已换成新目录。
    assertPlainDirectory(base);
    for (let dir = path.dirname(file); dir !== base; dir = path.dirname(dir)) {
      if (!sameEntry(entries.get(dir), stat(dir))) return false;
    }
    if (!sameEntry(baseInfo, stat(base)) || !sameEntry(info, stat(file), file)) return false;
    if (file !== run && !sameEntry(entries.get(statusFile), stat(statusFile))) return false;
    if (info.isDirectory()) fs.rmdirSync(file);
    else fs.unlinkSync(file);
  }
  return true;
}

/** 异步回收宿主已释放的运行目录，返回本次完整删除的目录数。 */
export async function pruneRuntimeRuns(base, { platform = process.platform, snapshot = windowsProcesses } = {}) {
  if (typeof base !== 'string' || !path.isAbsolute(base)) return 0;
  base = path.resolve(base);
  let names, baseInfo;
  try {
    assertPlainDirectory(base);
    baseInfo = stat(base);
    names = fs.readdirSync(base);
  } catch { return 0; }

  const candidates = [];
  for (const name of names) {
    if (!/^host-[a-zA-Z0-9]{6}$/.test(name)) continue;
    await yieldToHost();
    try {
      const candidate = inspect(path.join(base, name));
      if (candidate && (!candidate.legacy || platform === 'win32')) candidates.push(candidate);
    } catch { /* 不完整、被占用或已由另一个宿主清理。 */ }
  }
  if (candidates.length <= keepRuns) return 0;
  const canRemoveLegacy = candidates.some(run => run.legacy) ? await legacyGuard(snapshot) : null;
  const eligible = candidates.filter(run => {
    if (!run.legacy) return true;
    try { return canRemoveLegacy?.(run); } catch { return false; }
  });
  eligible.sort((a, b) => {
    if (a.updated !== b.updated) return a.updated > b.updated ? -1 : 1;
    return a.run.localeCompare(b.run, 'en');
  });
  let removed = 0;
  for (const candidate of eligible.slice(keepRuns)) {
    await yieldToHost();
    try {
      if (removeRun(candidate, base, baseInfo)) removed++;
    } catch { /* 单个目录失败不阻塞其他目录或宿主启动。 */ }
  }
  return removed;
}
