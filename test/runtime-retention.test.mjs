import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pruneRuntimeRuns } from '../integrations/magpie/runtime-retention.mjs';

const moduleURL = new URL('../integrations/magpie/runtime-retention.mjs', import.meta.url).href;
const buildId = 'a'.repeat(32);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'runtime-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'runtime');
  fs.mkdirSync(base);
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  function run(index, overrides = {}, name = 'host-' + String(index).padStart(6, '0')) {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'status.json');
    fs.writeFileSync(file, JSON.stringify({ reportDirectory: dir, parentProcessId: child.pid,
      state: 'stopped', automaticNextLaunch: false, locale: 'zh-Hans', ...overrides }));
    fs.utimesSync(file, 1700000000 + index, 1700000000 + index);
    return dir;
  }
  const keep = [run(100), run(101), run(102)];
  return { base, root, run, keep, deadPid: child.pid };
}

function bridge(run, overrides, id = buildId) {
  const build = path.join(run, 'bridge', id);
  fs.mkdirSync(build, { recursive: true });
  const file = path.join(build, 'result.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ mode: 'Watch', parentBound: true,
    stopFile: path.join(run, 'stop'), finishedAt: '2023-11-14T22:13:20Z', ...overrides }));
  fs.utimesSync(file, 1700000010, 1700000010);
  return build;
}

test('按诊断更新时间保留最近三份，重复回收不再删除', async t => {
  const { base, run, keep } = fixture(t);
  const old = run(1, { state: 'preparation-failed' });
  const stopped = run(2, { state: 'watcher-start-failed', locale: 'zh-Hant' });
  const watch = run(3, { state: 'watching', automaticNextLaunch: true });
  const build = bridge(watch);
  fs.writeFileSync(path.join(build, 'RuntimeConsoleBridge.exe'), 'fixture');
  fs.writeFileSync(path.join(watch, 'language.js.spec.json'), '{}');
  const newest = run(4, { state: 'watching', automaticNextLaunch: true });
  const report = path.join(bridge(newest), 'result.json');
  fs.utimesSync(report, 1700000200, 1700000200);
  assert.equal(await pruneRuntimeRuns(base), 4);
  assert.deepEqual([old, stopped, watch, keep[0]].map(fs.existsSync), [false, false, false, false]);
  assert.deepEqual([newest, ...keep.slice(1)].map(fs.existsSync), [true, true, true]);
  assert.equal(await pruneRuntimeRuns(base), 0);
});

test('活跃或复用的 PID、探测拒绝和非法 PID 均不参与保留配额', async t => {
  const { base, run, deadPid } = fixture(t);
  const probe = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0);
    if (pid === 42 && pid !== deadPid) throw Object.assign(new Error(), { code: 'EPERM' });
    return probe(pid, signal);
  });
  const protectedRuns = [process.pid, 0, -1, 2 ** 31, null, '1234', 1.5].map((parentProcessId, i) =>
    run(i, { parentProcessId }));
  if (deadPid !== 42) protectedRuns.push(run(30, { parentProcessId: 42 }));
  const old = run(31);
  assert.equal(await pruneRuntimeRuns(base), 1);
  assert.ok(protectedRuns.every(fs.existsSync));
  assert.equal(fs.existsSync(old), false);
});

test('宿主已退但监听未确认结束，或报告指向别处，保留整个目录', async t => {
  const { base, run } = fixture(t);
  for (const [index, overrides] of [undefined, { finishedAt: null }, { stopFile: base }, { parentBound: false }].entries()) {
    const dir = run(index, { state: 'watching', automaticNextLaunch: true });
    if (overrides) bridge(dir, overrides);
  }
  const mixed = run(4, { state: 'stopping' });
  bridge(mixed);
  bridge(mixed, { finishedAt: undefined }, 'b'.repeat(32));
  const before = fs.readdirSync(base);
  assert.equal(await pruneRuntimeRuns(base), 0);
  assert.deepEqual(fs.readdirSync(base), before);
});

test('拒绝冒名目录、残缺状态、未知文件、设置与备份，单项失败不影响其他回收', async t => {
  const { base, run } = fixture(t);
  for (const name of ['host-abcde', 'host-abcdef-copy', 'setup-state', 'backup']) run(1, {}, name);
  run(2, { reportDirectory: base });
  run(3, { state: 'unknown' });
  run(4, { locale: 'en' });
  run(5, { automaticNextLaunch: 'false' });
  const corrupt = run(6);
  fs.writeFileSync(path.join(corrupt, 'status.json'), '{');
  fs.mkdirSync(path.join(base, 'host-empty0'));
  const oversized = run(7);
  fs.appendFileSync(path.join(oversized, 'status.json'), ' '.repeat(70_000));
  const nested = bridge(run(8));
  const backup = path.join(nested, 'settings.bak');
  fs.writeFileSync(backup, 'backup');
  const before = fs.readdirSync(base);
  run(9);
  assert.equal(await pruneRuntimeRuns(base), 1);
  assert.deepEqual(fs.readdirSync(base), before);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'backup');
});

test('根、上级、候选目录和目录内的链接均保留，链接目标内容完整', async t => {
  const { root, base, run } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'settings.json');
  fs.writeFileSync(sentinel, 'saved');
  const link = (target, file) => fs.symlinkSync(target, file, 'junction');
  link(outside, path.join(base, 'host-linked'));
  const inner = run(1);
  link(outside, path.join(inner, 'bridge'));
  const marker = run(2);
  fs.unlinkSync(path.join(marker, 'status.json'));
  link(outside, path.join(marker, 'status.json'));
  const valid = run(3);
  link(base, path.join(root, 'alias'));
  link(root, path.join(outside, 'parent'));
  assert.equal(await pruneRuntimeRuns(path.join(root, 'alias')), 0);
  assert.equal(await pruneRuntimeRuns(path.join(outside, 'parent', 'runtime')), 0);
  assert.ok(fs.existsSync(valid));
  assert.equal(await pruneRuntimeRuns(base), 1);
  for (const file of [path.join(base, 'host-linked'), path.join(inner, 'bridge'), path.join(marker, 'status.json')]) {
    assert.ok(fs.lstatSync(file).isSymbolicLink());
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'saved');
  assert.equal(await pruneRuntimeRuns(path.join(root, 'missing')), 0);
});

test('删除失败可重试；复核发现状态已换成活跃宿主时保留', async t => {
  const { base, run } = fixture(t);
  const busy = run(1);
  const replaced = run(2);
  const status = path.join(replaced, 'status.json');
  const unlink = fs.unlinkSync.bind(fs);
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === path.join(busy, 'status.json')) {
      throw Object.assign(new Error(), { code: 'EBUSY' });
    }
    return unlink(file);
  });
  const read = fs.lstatSync.bind(fs);
  let visits = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === status && ++visits === 3) {
      const record = JSON.parse(fs.readFileSync(status));
      fs.writeFileSync(status, JSON.stringify({ ...record, parentProcessId: process.pid }));
    }
    return read(file, ...args);
  });
  assert.equal(await pruneRuntimeRuns(base), 0);
  assert.ok(fs.existsSync(busy) && fs.existsSync(replaced));
  t.mock.restoreAll();
  assert.equal(await pruneRuntimeRuns(base), 1);
  assert.ok(fs.existsSync(replaced));
});

function ageTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) ageTree(file);
    else fs.utimesSync(file, 1700000000, 1700000000);
  }
  fs.utimesSync(dir, 1700000000, 1700000000);
}

const self = { pid: process.pid, parent: process.ppid, name: 'node.exe' };

test('一次异步快照识别缺少 finishedAt、无 bridge 和仅有状态的遗留目录', async t => {
  const { base, run, keep } = fixture(t);
  const watching = run(1, { state: 'watching', automaticNextLaunch: true });
  bridge(watching, { finishedAt: undefined });
  const preparing = run(2, { state: 'preparing' });
  const ownerChanged = run(3, { state: 'owner-changed' });
  [watching, preparing, ownerChanged].forEach(ageTree);
  let calls = 0;
  const snapshot = async () => { calls++; await Promise.resolve(); return [self]; };
  assert.equal(await pruneRuntimeRuns(base, { platform: 'linux', snapshot }), 0);
  assert.equal(calls, 0);
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot }), 3);
  assert.ok(keep.every(fs.existsSync));
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot }), 0);
  assert.equal(calls, 1);
});

test('遗留目录受直接子进程、PID 复用、辅助程序路径和快照失败保护', async t => {
  const { base, root, run, deadPid } = fixture(t);
  const dir = run(1, { state: 'watching', automaticNextLaunch: true });
  const build = bridge(dir, { finishedAt: undefined });
  const exe = path.join(build, 'RuntimeConsoleBridge.exe');
  fs.writeFileSync(exe, '');
  ageTree(dir);
  const helper = { pid: 91, parent: 0, name: 'runtimeconsolebridge.EXE', path: exe };
  for (const rows of [[], [self, {}], [self, { ...self, parent: deadPid }], [self, { ...self, pid: deadPid }],
    [self, helper], [self, { ...helper, path: null }], [self, { ...helper, path: 'relative' }]]) {
    assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot: () => rows }), 0);
  }
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot() { throw new Error('timeout'); } }), 0);
  assert.ok(fs.existsSync(exe));
  const other = path.join(root, 'RuntimeConsoleBridge.exe');
  fs.writeFileSync(other, '');
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot: () => [self, { ...helper, path: other }] }), 1);
});

test('宽限期内、报告绑定错误和快照期间变化的目录保留', async t => {
  const { base, run } = fixture(t);
  const recent = run(1, { state: 'preparing' });
  const wrong = run(2, { state: 'watching', automaticNextLaunch: true });
  bridge(wrong, { stopFile: base, finishedAt: undefined });
  ageTree(wrong);
  const snapshot = t.mock.fn(() => [self]);
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot }), 0);
  assert.equal(snapshot.mock.callCount(), 0);
  const changed = run(3, { state: 'preparing' });
  ageTree(changed);
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot() {
    fs.writeFileSync(path.join(changed, 'settings.bak'), 'backup');
    return [self];
  } }), 0);
  assert.ok([recent, wrong, changed].every(fs.existsSync));
});

test('released:true 独立于宿主 PID 和快照，仍检查内容并保留最近三份', async t => {
  const { base, run, keep } = fixture(t);
  const fields = { released: true, parentProcessId: process.pid, state: 'watching', automaticNextLaunch: true };
  const old = run(1, fields);
  const newest = run(200, fields);
  const unknown = run(2, fields);
  fs.writeFileSync(path.join(unknown, 'settings.bak'), 'backup');
  const ambiguous = run(3, { ...fields, released: 'true' });
  const original = process.kill.bind(process);
  const probes = t.mock.method(process, 'kill', (pid, signal) => original(pid, signal));
  const snapshot = t.mock.fn(() => []);
  assert.equal(await pruneRuntimeRuns(base, { platform: 'win32', snapshot }), 2);
  assert.ok(probes.mock.calls.every(call => call.arguments[0] !== process.pid));
  assert.equal(snapshot.mock.callCount(), 0);
  assert.ok([newest, unknown, ambiguous, ...keep.slice(1)].every(fs.existsSync));
  assert.equal(fs.existsSync(old), false);
});

test('多个独立进程同时回收，以相同顺序保留时间相同的诊断', async t => {
  const { base, run, keep } = fixture(t);
  for (let i = 0; i < 24; ++i) {
    const dir = run(i);
    fs.utimesSync(path.join(dir, 'status.json'), 1700000100, 1700000100);
  }
  const script = 'import { pruneRuntimeRuns } from ' + JSON.stringify(moduleURL)
    + '; console.log(await pruneRuntimeRuns(process.argv[1]))';
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', script, base], { windowsHide: true })));
  assert.deepEqual(fs.readdirSync(base).sort(), ['host-000000', ...keep.slice(1).map(dir => path.basename(dir))]);
  assert.equal(await pruneRuntimeRuns(base), 0);
});

test('已结束的监听器文件被占用时保留结束证据，重试只移除缓存的运行目录硬链接', async t => {
  const { base, run } = fixture(t);
  const cache = path.join(base, 'catalog-cache');
  fs.mkdirSync(cache);
  const data = path.join(cache, 'catalog.json');
  fs.writeFileSync(data, 'cached catalog');
  const dir = run(1, { state: 'watching', automaticNextLaunch: true });
  fs.linkSync(data, path.join(dir, 'language.js.spec.json'));
  const build = bridge(dir);
  const exe = path.join(build, 'RuntimeConsoleBridge.exe');
  fs.writeFileSync(exe, 'fixture');
  const unlink = fs.unlinkSync.bind(fs);
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === exe) throw Object.assign(new Error(), { code: 'EBUSY' });
    unlink(file);
  });
  assert.equal(await pruneRuntimeRuns(base), 0);
  assert.ok(fs.existsSync(path.join(build, 'result.json')));
  t.mock.restoreAll();
  assert.equal(await pruneRuntimeRuns(base), 1);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(data, 'utf8'), 'cached catalog');
});

test('多份已释放的运行共享缓存硬链接时，一轮回收到保留数量', async t => {
  const { base, root, run, keep } = fixture(t);
  const cache = path.join(root, 'catalog.json');
  fs.writeFileSync(cache, '{}');
  for (let i = 0; i < 6; i++) {
    const dir = run(i, { state: 'rebuilding', released: true, parentProcessId: process.pid });
    fs.linkSync(cache, path.join(dir, 'language.js.spec.json'));
  }
  assert.equal(await pruneRuntimeRuns(base), 6);
  assert.deepEqual(fs.readdirSync(base).sort(), keep.map(dir => path.basename(dir)));
  assert.equal(fs.readFileSync(cache, 'utf8'), '{}');
});
