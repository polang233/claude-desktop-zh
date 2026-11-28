import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyThirdParty, restoreThirdParty, thirdPartyStatus } from '../lib/third-party.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t, base = os.tmpdir()) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'claude-zh-third-party-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'Claude', 'app');
  const resources = path.join(source, 'resources');
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(source, 'claude.exe'), 'fixture');
  fs.writeFileSync(path.join(resources, 'ion-dist.asar'), 'fixture');
  return { root, source, resources, stateDirectory };
}

function markInstalled(resources) {
  fs.writeFileSync(path.join(resources, 'zh-CN.json'), '{}');
  const backup = path.join(resources, '.zh-cn-backups', '20261126-120000');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'ion-dist.asar'), 'original');
}

test('third-party status is read-only and discovers the packaged patch bundle', t => {
  const f = fixture(t);
  const initial = thirdPartyStatus({ source: f.source, stateDirectory: f.stateDirectory });
  assert.equal(initial.status, 'not-installed');
  assert.equal(initial.bundle.verified, true);
  assert.equal(initial.bundle.commit, 'f23b0292646bdd912f759cec1096d9814ebb01ef');
  assert.equal(initial.canApply, true);
  assert.equal(initial.canRestore, false);
  assert.equal(fs.existsSync(f.stateDirectory), false);
  markInstalled(f.resources);
  const installed = thirdPartyStatus({ source: f.source, stateDirectory: f.stateDirectory });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.canRestore, true);
  assert.equal(installed.backupDirectory, path.join(f.resources, '.zh-cn-backups', '20261126-120000'));
});

test('third-party apply and restore use the pinned launcher and record recoverable state', async t => {
  const f = fixture(t);
  const calls = [];
  const apply = await applyThirdParty({ source: f.source, stateDirectory: f.stateDirectory, locale: 'zh-Hans' }, {
    platform: 'win32',
    assertStopped: async () => { calls.push('stopped-before-apply'); },
    runLauncher: async (...args) => {
      calls.push(args);
      markInstalled(f.resources);
      return { exitCode: 0, log: 'apply.log' };
    }
  });
  assert.equal(apply.status, 'installed');
  assert.equal(apply.locale, 'zh-Hans');
  assert.deepEqual(calls[0], 'stopped-before-apply');
  assert.deepEqual(calls[1].slice(0, 2), ['install', 'zh-CN']);
  assert.equal(calls[1][2], f.source);
  const state = JSON.parse(fs.readFileSync(path.join(f.stateDirectory, 'third-party-state.json'), 'utf8'));
  assert.equal(state.status, 'installed');
  assert.equal(state.backupDirectory, path.join(f.resources, '.zh-cn-backups', '20261126-120000'));

  fs.writeFileSync(path.join(f.stateDirectory, 'third-party-state.json'), JSON.stringify({
    ...state, status: 'failed', failedAt: '2026-11-26T00:00:00.000Z', error: 'restore-failed'
  }));
  const restored = await restoreThirdParty({ source: f.source, stateDirectory: f.stateDirectory }, {
    platform: 'win32',
    assertStopped: async () => { calls.push('stopped-before-restore'); },
    runLauncher: async (...args) => {
      calls.push(args);
      fs.rmSync(path.join(f.resources, 'zh-CN.json'));
      return { exitCode: 0, log: 'restore.log' };
    }
  });
  assert.equal(restored.status, 'restored');
  assert.match(restored.retained, /语言配置已恢复为英文/);
  assert.equal(calls.at(-2), 'stopped-before-restore');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['recover', 'zh-CN']);
  assert.equal(calls.at(-1)[4], path.join(f.resources, '.zh-cn-backups', '20261126-120000'));
  const restoredState = JSON.parse(fs.readFileSync(path.join(f.stateDirectory, 'third-party-state.json'), 'utf8'));
  assert.equal(restoredState.status, 'restored');
  assert.equal('failedAt' in restoredState, false);
  assert.equal('error' in restoredState, false);
  const after = thirdPartyStatus({ source: f.source, stateDirectory: f.stateDirectory });
  assert.equal(after.status, 'restored');
  assert.equal(after.canRestore, false);
});

test('third-party refuses an unauthorised elevation and reports a failed transaction', async t => {
  const f = fixture(t);
  await assert.rejects(applyThirdParty({ source: f.source, stateDirectory: f.stateDirectory, locale: 'zh-Hant' }, {
    platform: 'win32',
    assertStopped: async () => {},
    runLauncher: async () => ({ exitCode: 1223, cancelled: true })
  }), /管理员授权/);
  const state = JSON.parse(fs.readFileSync(path.join(f.stateDirectory, 'third-party-state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'elevation-cancelled');
  assert.equal(state.language, 'zh-TW');
});

test('third-party status is unavailable outside Windows and does not touch the application', t => {
  const f = fixture(t);
  const status = thirdPartyStatus({ source: f.source, stateDirectory: f.stateDirectory }, { platform: 'darwin' });
  assert.equal(status.status, 'unsupported');
  assert.equal(status.canApply, false);
  assert.equal(fs.readFileSync(path.join(f.resources, 'ion-dist.asar'), 'utf8'), 'fixture');
});

test('fixture recovery restores app, frontend, executable and cowork from verified backups', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, fileURLToPath(new URL('../.local/', import.meta.url)));
  const app = path.dirname(f.resources);
  const backup = path.join(f.resources, '.zh-cn-backups', '20260101-000000');
  const cowork = path.join(f.resources, '.zh-cn-backups', 'init-backup');
  fs.mkdirSync(path.join(backup, '_app'), { recursive: true });
  fs.mkdirSync(cowork, { recursive: true });
  fs.writeFileSync(path.join(app, 'claude.exe'), 'patched-exe');
  fs.writeFileSync(path.join(f.resources, 'app.asar'), 'patched-app');
  fs.writeFileSync(path.join(f.resources, 'ion-dist.asar'), 'patched-ion');
  fs.writeFileSync(path.join(f.resources, 'cowork-svc.exe'), 'patched-cowork');
  fs.writeFileSync(path.join(f.resources, 'zh-CN.json'), '{}');
  fs.writeFileSync(path.join(backup, '_app', 'Claude.exe'), 'original-exe');
  fs.writeFileSync(path.join(backup, 'app.asar'), 'original-app');
  fs.writeFileSync(path.join(backup, 'ion-dist.asar'), 'original-ion');
  fs.writeFileSync(path.join(cowork, 'cowork-svc.exe'), 'original-cowork');
  const reportFile = path.join(f.root, 'report.json');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../vendor/javaht/scripts/recover_third_party.ps1', import.meta.url)),
      '-Fixture', '-ClaudePath', app, '-BackupDirectory', backup, '-ReportFile', reportFile], { windowsHide: true });
  } catch (error) {
    const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : 'no report';
    throw new Error(error.message + '\n' + report);
  }
  assert.equal(fs.readFileSync(path.join(app, 'claude.exe'), 'utf8'), 'original-exe');
  assert.equal(fs.readFileSync(path.join(f.resources, 'app.asar'), 'utf8'), 'original-app');
  assert.equal(fs.readFileSync(path.join(f.resources, 'ion-dist.asar'), 'utf8'), 'original-ion');
  assert.equal(fs.readFileSync(path.join(f.resources, 'cowork-svc.exe'), 'utf8'), 'original-cowork');
  assert.equal(fs.existsSync(path.join(f.resources, 'zh-CN.json')), false);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.exitCode, 0);
  assert.equal(report.restored.length, 4);
  assert.deepEqual(report.warnings, []);
});
