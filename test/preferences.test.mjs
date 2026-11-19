import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createController, createLocalizationSession } from '../integrations/magpie/controller.mjs';
import { preferenceStore } from '../integrations/magpie/preferences.mjs';

test('language preferences persist outside application data and still honor changed magpie options', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-preferences-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const saved = { locale: 'zh-Hant', runtimeAutoLoad: false };
  const store = preferenceStore({}, folder);
  assert.deepEqual(store.read(), { locale: 'zh-Hans', runtimeAutoLoad: true, method: 'runtime' });
  store.write(saved);
  assert.deepEqual(preferenceStore({}, folder).read(), { ...saved, method: 'runtime' });
  assert.deepEqual(preferenceStore({ locale: 'zh-Hans', runtimeAutoLoad: false }, folder).read(), { locale: 'zh-Hans', runtimeAutoLoad: false, method: 'runtime' });
  const before = fs.readFileSync(path.join(folder, 'language-preferences.json'));
  for (const value of [{ locale: 'en-US', runtimeAutoLoad: true }, { ...saved, command: 'arbitrary' }, { locale: 'zh-Hans' }]) assert.throws(() => store.write(value), /Invalid/);
  assert(before.equals(fs.readFileSync(path.join(folder, 'language-preferences.json'))));
});

test('shared preferences serialize method changes, reject stale hosts and keep incomplete transactions recoverable', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-method-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = preferenceStore({}, directory);
  assert.equal(path.isAbsolute(store.file), true);
  const old = { locale: 'zh-Hant', runtimeAutoLoad: true };
  fs.writeFileSync(store.file, JSON.stringify({ version: 1, source: { locale: 'zh-Hans', runtimeAutoLoad: true }, value: old }));
  const starts = [], calls = [];
  let record = 'not-installed', protectedInstall = true, release, stopping;
  const make = () => createLocalizationSession({ stateDirectory: directory }, store, effective => ({
    start: () => starts.push(effective.runtimeAutoLoad), state: () => ({}),
    stopped: () => stopping
  }), () => {}, options => createController(options, async (_, args) => {
    calls.push(args[0]);
    if (args[0] === 'original-check') return { eligible: !protectedInstall, protectedInstall };
    if (args[0] === 'original-status') return { status: record };
    if (args[0] === 'original-restore') { record = 'restored'; return { status: record }; }
    throw Error('Unexpected command ' + args[0]);
  }));
  const first = await make(), other = await make();
  assert.deepEqual(first.get(), { ...old, method: 'runtime' });
  const manual = { ...old, method: 'in-place' };
  await assert.rejects(first.save(manual), /MSIX/);
  assert.deepEqual(starts, [true, true]);
  protectedInstall = false;
  stopping = new Promise(resolve => { release = resolve; });
  const switchMode = first.save(manual);
  await assert.rejects(first.execute('install', 'install'), /正在切换/);
  assert.deepEqual(store.read(), { ...old, method: 'runtime' });
  release(); await switchMode;
  assert.deepEqual(starts, [true, true, false]);
  assert.deepEqual(await store.read(), manual);
  await assert.rejects(other.save({ ...old, method: 'runtime' }), /另一个页面或宿主/);
  await assert.rejects(other.execute('restore', 'restore'), /另一个页面或宿主/);
  assert(!calls.includes('original-restore'));
  const reopened = await make();
  assert.equal(starts.at(-1), false);
  record = 'applying';
  await assert.rejects(reopened.save({ ...old, method: 'runtime' }), /先确认恢复/);
  await reopened.execute('restore', 'restore');
  const previousRevision = reopened.revision();
  await reopened.save({ ...old, method: 'runtime' }, previousRevision);
  assert.equal(starts.at(-1), true);
  await assert.rejects(reopened.save(manual, previousRevision), /另一个页面或宿主/);
  await assert.rejects(reopened.execute('install', 'install'), /先在插件页选择/);
});

test('old transaction blocks startup loading even with runtime defaults; plugin backup folder stays separate', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-old-method-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = preferenceStore({}, directory), calls = [];
  store.write(store.read());
  const factory = options => createController(options, async (_, args) => {
    calls.push(args); return { status: 'installed' };
  });
  await factory({ stateDirectory: directory }).execute('status');
  assert.equal(calls.at(-1).at(-1), path.join(directory, 'resource-backup'));
  fs.writeFileSync(path.join(directory, 'original-state.json'), '{}');
  let automatic;
  const session = await createLocalizationSession({ stateDirectory: directory }, store, options => ({
    start() { automatic = options.runtimeAutoLoad; }, state: () => ({})
  }), () => {}, factory);
  assert.equal(calls.at(-1).at(-1), directory);
  assert.equal(session.get().method, 'in-place'); assert.equal(automatic, false);
});
