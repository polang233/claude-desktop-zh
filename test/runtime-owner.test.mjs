import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sha256 } from '../lib/common.mjs';

test('watcher retries before submission, remembers each HWND, and handles a reopened window or a reused PID',
  { skip: process.platform !== 'win32' }, t => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-window-poll-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const run = (...options) => {
      const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',
        path.resolve('test/window-watch-fixture.ps1'), path.resolve('scripts/test-runtime-autoload.ps1'), scratch, ...options],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const later = [
      '2/202/setup/FocusChangedBeforeExecute', '3/202/setup/Applied',
      '5/202/setup/Applied', '6/101/main/Applied', '6/202/setup/Applied'
    ];
    assert.deepEqual(run(), ['0/101/main/FocusChanged', '1/101/main/Applied', ...later]);
    assert.deepEqual(run('-ExistingProcess'), later);
  });

test('parent-bound watcher stops naturally when registry changes, with an inert app and no UI attempts',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-owner-'));
    const registry = path.join(root, 'plugins.json'), payload = path.join(root, 'payload.js'), manifest = path.join(root, 'bundle.json');
    const stop = path.join(root, 'stop');
    fs.writeFileSync(registry, '{"plugins":[]}');
    fs.utimesSync(registry, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    fs.writeFileSync(payload, 'inert fixture; never sent to any application');
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, locale: 'zh-Hans', payload,
      sourceExecutable: path.join(root, 'nonexistent-app', 'Claude.exe'), payloadSha256: sha256(fs.readFileSync(payload)),
      successMarker: 'CLAUDE_ZH_APPLIED_' + 'c'.repeat(32) }));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/test-runtime-autoload.ps1'),
      '-Manifest', manifest, '-BuildDirectory', path.join(root, 'build'), '-Watch', '-WatchSeconds', '10',
      '-ParentProcessId', String(process.pid), '-ParentExecutable', process.execPath, '-ParentStartedBefore', new Date().toISOString(),
      '-RegistryFile', registry, '-RegistrySha256', sha256(fs.readFileSync(registry)), '-StopFile', stop],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    t.after(() => { if (child.exitCode === null) fs.writeFileSync(stop, 'Test cleanup: normal stop.'); });
    let announce;
    const watching = new Promise(resolve => { announce = resolve; });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('Watching original Claude')) announce(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    const start = await Promise.race([watching.then(() => true), closed.then(() => false)]);
    assert.equal(start, true, stderr || stdout);
    const otherBuild = path.join(root, 'contender-build');
    const contender = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.resolve('scripts/test-runtime-autoload.ps1'), '-Manifest', manifest, '-BuildDirectory', otherBuild, '-Watch'],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.match(contender.stderr, /already owns this application/);
    assert.notEqual(contender.status, 0);
    assert.equal(fs.existsSync(otherBuild), false);
    fs.writeFileSync(registry, '{"plugins":[],"changed":true}');
    assert.equal(await closed, 0, stderr || stdout);
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    const report = JSON.parse(fs.readFileSync(result.report, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(report.parentBound, true);
    assert.deepEqual(report.events, []); // No executable at the fixture path can match a running app.
    assert.equal(report.selfTest.uiActions, 0);
    assert.ok(report.finishedAt);
    fs.rmSync(root, { recursive: true, force: true });
  });

test('replacement watcher skips processes present at a preference save, even with a reused PID',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-preference-watcher-'));
    const registry = path.join(root, 'plugins.json'), payload = path.join(root, 'payload.js');
    const manifest = path.join(root, 'bundle.json'), stop = path.join(root, 'stop');
    const wrapper = path.join(root, 'mock-processes.ps1');
    const newLaunch = path.join(root, 'new-launch');
    const cutoff = '639305767399865988';
    fs.writeFileSync(registry, '{"plugins":[]}');
    fs.utimesSync(registry, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    fs.writeFileSync(payload, 'inert fixture');
    // Record when the real watcher reaches window discovery for the fake PID.
    const executable = path.join(root, 'nonexistent-app', 'Claude.exe');
    fs.writeFileSync(manifest, JSON.stringify({version: 1, locale: 'zh-Hans', payload, sourceExecutable: executable,
      payloadSha256: sha256(fs.readFileSync(payload)), successMarker: 'CLAUDE_ZH_APPLIED_' + 'd'.repeat(32)}));
    fs.writeFileSync(wrapper, `
function Get-Process {
  param([string]$Name,[int]$Id,[string]$ErrorAction)
  if ($Name -ne 'Claude') { return Microsoft.PowerShell.Management\\Get-Process -Id $Id -ErrorAction $ErrorAction }
  $ticks=[long]$env:ZH_TEST_CUTOFF
  if (Test-Path -LiteralPath $env:ZH_TEST_NEW_LAUNCH) { $ticks++ }
  $item=[pscustomobject]@{ Id=42; Path=$env:ZH_TEST_EXE; StartTime=[datetime]::new($ticks,[DateTimeKind]::Utc) }
  $item | Add-Member -MemberType ScriptProperty -Name MainWindowHandle -Value {
    [IO.File]::WriteAllText(($env:ZH_TEST_NEW_LAUNCH+'.observed'),$this.StartTime.Ticks.ToString())
    return [IntPtr]::Zero
  }
  $item
}
& $env:ZH_TEST_SCRIPT @args
`);
    const build = path.join(root, 'build');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', wrapper,
      '-Manifest', manifest, '-BuildDirectory', build, '-Watch',
      '-ParentProcessId', String(process.pid), '-ParentExecutable', process.execPath, '-ParentStartedBefore', new Date().toISOString(),
      '-RegistryFile', registry, '-RegistrySha256', sha256(fs.readFileSync(registry)), '-StopFile', stop, '-SkipClaudeStartedThrough', cutoff],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        ZH_TEST_SCRIPT: path.resolve('scripts/test-runtime-autoload.ps1'), ZH_TEST_CUTOFF: cutoff,
        ZH_TEST_EXE: executable, ZH_TEST_NEW_LAUNCH: newLaunch } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    async function waitFor(check) {
      for (let i = 0; i < 200; i++) {
        if (check()) return;
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(stderr || stdout || 'Watcher did not reach expected state');
    }
    try {
      await waitFor(() => stdout.includes('Watching original Claude'));
      const file = path.join(build, fs.readdirSync(build)[0], 'result.json');
      const readReport = () => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      await new Promise(resolve => setTimeout(resolve, 2500));
      const before = readReport();
      assert.equal(before.skipClaudeStartedThrough, cutoff);
      assert.deepEqual(before.events, []);
      assert.equal(fs.readFileSync(newLaunch + '.observed','utf8'), cutoff);
      fs.writeFileSync(newLaunch, '');
      await waitFor(() => fs.readFileSync(newLaunch + '.observed','utf8') === String(BigInt(cutoff) + 1n));
      assert.equal(fs.readFileSync(newLaunch + '.observed','utf8'), String(BigInt(cutoff) + 1n));
      assert.deepEqual(readReport().events, []);
    } finally {
      fs.writeFileSync(stop, 'Normal test cleanup.');
      await closed;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
