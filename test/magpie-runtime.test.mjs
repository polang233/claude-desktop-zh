import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRuntimeHost, registrySnapshot } from '../integrations/magpie/runtime-host.mjs';
import { createController } from '../integrations/magpie/controller.mjs';
import { sha256 } from '../lib/common.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const plugin = fileURLToPath(new URL('../integrations/magpie', import.meta.url));
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = path.join(root, 'plugins.json');
  fs.writeFileSync(registry, JSON.stringify({ plugins: [{ spec: plugin, options }] }));
  return { root, registry, options };
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
  child.kill = () => { throw new Error('Must stop normally'); };
  return child;
}
function binding(root, name) {
  return { source: path.join(root, name), revision: sha256(Buffer.from(name)) };
}
function runtimeController(f, overrides = {}) {
  return {
    runtimeSource: async () => binding(f.root, 'Claude-old'),
    runtimeConfiguration: () => ({ cwd: project, executable: process.execPath, cli: path.join(project, 'bin/claude-3p-zh.mjs') }),
    prepareRuntime: async output => ({ automationManifest: output + '.automation.json', profileDirectory: path.join(f.root, 'profile') }),
    ...overrides
  };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Runtime did not reach the expected state');
}

test('registry binds the actual plugin, saved options and enabled state', t => {
  const f = fixture(t, { locale: 'zh-Hant', runtimeAutoLoad: true });
  assert.equal(registrySnapshot(f.root, { runtimeAutoLoad: true, locale: 'zh-Hant' }).hash, sha256(fs.readFileSync(f.registry)));
  assert.throws(() => registrySnapshot(f.root, { locale: 'zh-Hans' }), /changed/);
  const data = JSON.parse(fs.readFileSync(f.registry)); data.plugins[0].off = true;
  fs.writeFileSync(f.registry, JSON.stringify(data));
  assert.throws(() => registrySnapshot(f.root, f.options), /changed/);
});

test('registry accepts root, npm and GitHub installs and rejects ambiguous or unrelated owners', t => {
  const f = fixture(t);
  const write = entries => fs.writeFileSync(f.registry, JSON.stringify({ plugins: entries }));
  for (const spec of [project, plugin, path.join(plugin, 'server.mjs'), 'magpie-claude-zh',
    'magpie-claude-zh@0.1.0', 'magpie-claude-zh@latest', 'github:polang233/claude-desktop-zh',
    'github:polang233/claude-desktop-zh#v0.1.0', 'https://github.com/polang233/claude-desktop-zh.git',
    'github:polang233/claude-desktop-3p-zh']) {
    write([{ spec }]);
    assert.equal(registrySnapshot(f.root, {}).hash, sha256(fs.readFileSync(f.registry)), spec);
  }
  for (const spec of ['magpie-claude-zh-other', 'github:someone/claude-desktop-zh',
    'github:polang233/claude-desktop-zh-other', 'https://example.com/polang233/claude-desktop-zh',
    'https://github.com/polang233/claude-desktop-zh/tree/main', path.dirname(project)]) {
    write([{ spec }]);
    assert.throws(() => registrySnapshot(f.root, {}), /changed/, spec);
  }
  write([{ spec: project }, { spec: 'magpie-claude-zh' }]);
  assert.throws(() => registrySnapshot(f.root, {}), /changed/);
});

test('default locale starts one hidden owner-bound watcher and stop uses a file', async t => {
  const f = fixture(t), calls = [], child = fakeChild(), toasts = [];
  const controller = runtimeController(f, {
    prepareRuntime: async (output, source, cache) => {
      assert.equal(cache, path.join(f.root, 'runtime', 'catalog-cache'));
      assert.equal(source, binding(f.root, 'Claude-old').source);
      return { automationManifest: output + '.automation.json', profileDirectory: path.join(f.root, 'profile') };
    }
  });
  const runtime = createRuntimeHost({ directory: f.root, client: { tui: { showToast: async value => toasts.push(value.body.message) } } }, f.options, controller, {
    platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'),
    spawn: (...args) => { calls.push(args); return child; }
  });
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(calls.length, 1);
  const [exe, args, settings] = calls[0];
  assert.equal(exe, 'powershell.exe');
  const policyIndex = args.indexOf('-ExecutionPolicy');
  assert(policyIndex > 0);
  assert.equal(args[policyIndex + 1], 'Bypass');
  assert(policyIndex < args.indexOf('-File'));
  assert(args.includes('-ParentProcessId')); assert(args.includes(String(process.pid)));
  assert(args.includes('-RegistrySha256')); assert(args.includes(sha256(fs.readFileSync(f.registry))));
  assert(args.includes('-SetupProfileDirectory')); assert(args.includes(path.join(f.root, 'profile')));
  child.stdout.write('{"state":"WaitingForNormalExit","changed":false}\n');
  assert.equal(runtime.state().state, 'waiting-for-normal-exit');
  assert.equal(runtime.state().automaticNextLaunch, false);
  child.stdout.write('{"state":"RuntimeSetupReady","changed":true,"journal":"private-journal"}\n');
  assert.equal(runtime.state().setupChanged, true);
  assert.equal(settings.windowsHide, true); assert.equal(settings.shell, false);
  assert.deepEqual(settings.stdio, ['ignore', 'pipe', 'pipe']);
  child.stdout.write('Watching original Claude while plugin host and options are current.\n');
  assert.equal(runtime.state().locale, 'zh-Hans'); assert.equal(runtime.state().automaticNextLaunch, true);
  child.stdout.write('{"state":"LoadingLanguage","applicationPid":42}\n');
  assert.equal(runtime.state().progress, 'loading');
  child.stdout.write('{"state":"WaitingForClaude","applicationPid":42}\n');
  assert.equal(runtime.state().progress, undefined);
  child.stdout.write('{"state":"LoadingLanguage","applicationPid":42}\n{"state":"Applied","applicationPid":42}\n');
  assert.equal(runtime.state().progress, undefined);
  assert.equal(runtime.state().lastResult, 'Applied');
  assert.equal(toasts.length, 2); assert.match(toasts[0], /退出/); assert.match(toasts[1], /已准备好/);
  runtime.stop();
  assert.equal(fs.existsSync(args[args.indexOf('-StopFile') + 1]), true);
  assert.equal(runtime.state().automaticNextLaunch, false);
  child.emit('exit', 0);
  assert.equal(runtime.state().state, 'stopped');
});

test('an options change during catalog preparation prevents an obsolete watcher', async t => {
  const f = fixture(t); let release, spawned = false;
  const runtime = createRuntimeHost({ directory: f.root }, {}, runtimeController(f, {
    prepareRuntime: () => new Promise(resolve => { release = resolve; })
  }), { platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'), spawn: () => { spawned = true; } });
  const ready = runtime.start();
  await until(() => release);
  fs.writeFileSync(f.registry, '{"plugins":[]}');
  release({ automationManifest: 'not-run', profileDirectory: path.join(f.root, 'profile') });
  await ready;
  assert.equal(spawned, false); assert.equal(runtime.state().state, 'owner-changed');
});

test('a preference saved by another host revokes the old watcher even with the same registry', async t => {
  const f = fixture(t), child = fakeChild(), preferenceFile = path.join(f.root, 'language-preferences.json');
  let args;
  const runtime = createRuntimeHost({ directory: f.root }, {}, runtimeController(f), {
    platform: 'win32', preferenceFile, runtimeDirectory: path.join(f.root, 'runtime'), pollIntervalMs: 5,
    spawn: (_, values) => { args = values; return child; }
  });
  try {
    await runtime.start();
    assert.equal(args[args.indexOf('-PreferenceHash') + 1], 'missing');
    assert.equal(args[args.indexOf('-PreferenceFile') + 1], preferenceFile);
    fs.writeFileSync(preferenceFile, '{"method":"in-place"}');
    await until(() => fs.existsSync(args[args.indexOf('-StopFile') + 1]));
    assert.equal(runtime.state().state, 'owner-changed');
  } finally { child.emit('exit', 0); await runtime.stopped(); }
});

test('settings restart waits for the old watcher to exit through its stop file', async t => {
  const f = fixture(t), child = fakeChild();
  const runtime = createRuntimeHost({ directory: f.root }, {}, runtimeController(f), {
    platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'), spawn: () => child
  });
  await runtime.start();
  const waiting = runtime.stopped();
  await new Promise(resolve => setImmediate(resolve));
  const run = fs.readdirSync(path.join(f.root, 'runtime'))[0];
  assert(fs.existsSync(path.join(f.root, 'runtime', run, 'stop')));
  child.emit('exit', 0);
  await waiting;
  assert.equal(runtime.state().state, 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'runtime', run, 'status.json'))).released, true);

  const replacementChild = fakeChild();
  const skipClaudeStartedThrough = '639305767399865988';
  let replacementArgs;
  const replacement = createRuntimeHost({ directory: f.root }, {}, runtimeController(f), {
    platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'), skipClaudeStartedThrough,
    spawn: (_, args) => { replacementArgs = args; return replacementChild; }
  });
  await replacement.start();
  try {
    const index = replacementArgs.indexOf('-SkipClaudeStartedThrough');
    assert.ok(index > 0);
    assert.equal(replacementArgs[index + 1], skipClaudeStartedThrough);
  } finally {
    replacement.stop();
    replacementChild.emit('exit', 0);
  }
});

test('a new installation revision stops the old watcher before building and watching the new source', async t => {
  const f = fixture(t), builds = [], children = [];
  let source = binding(f.root, 'Claude-4');
  const controller = runtimeController(f, {
    runtimeSource: async () => source,
    prepareRuntime: async (output, selected) => {
      builds.push(selected);
      return { automationManifest: output + '.json', profileDirectory: path.join(f.root, 'profile') };
    }
  });
  const runtime = createRuntimeHost({ directory: f.root }, {}, controller, {
    platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'), pollIntervalMs: 5,
    spawn: (_, args) => {
      const child = fakeChild();
      children.push({ child, stop: args[args.indexOf('-StopFile') + 1] });
      return child;
    }
  });
  try {
    await runtime.start();
    children[0].child.stdout.write('Watching original Claude\n{"state":"Applied","applicationPid":2}\n');
    assert.equal(runtime.state().lastResult, 'Applied');
    source = binding(f.root, 'Claude-5');
    await until(() => fs.existsSync(children[0].stop));
    children[0].child.stdout.write('Watching original Claude\n');
    assert.equal(runtime.state().state, 'rebuilding');
    assert.equal(runtime.state().automaticNextLaunch, false);
    assert.deepEqual(builds, [binding(f.root, 'Claude-4').source]);
    children[0].child.emit('exit', 0);
    await until(() => children.length === 2);
    assert.deepEqual(builds, [binding(f.root, 'Claude-4').source, source.source]);
    assert.notEqual(children[1].stop, children[0].stop);
    assert.equal(runtime.state().lastResult, undefined);
    children[1].child.stdout.write('Watching original Claude\n');
    assert.equal(runtime.state().automaticNextLaunch, true);
  } finally {
    runtime.stop();
    children.forEach(({ child }) => child.emit('exit', 0));
  }
});

test('an installation that changes during export never starts a watcher with the stale bundle', async t => {
  const f = fixture(t), builds = [], children = [];
  const old = binding(f.root, 'Claude-4'), updated = binding(f.root, 'Claude-5');
  let source = old;
  const controller = runtimeController(f, {
    runtimeSource: async () => source,
    prepareRuntime: async (output, selected) => {
      builds.push(selected); source = updated;
      return { automationManifest: output + '.json', profileDirectory: path.join(f.root, 'profile') };
    }
  });
  const runtime = createRuntimeHost({ directory: f.root }, {}, controller, {
    platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'), pollIntervalMs: 5,
    spawn: () => { const child = fakeChild(); children.push(child); return child; }
  });
  try {
    assert.equal((await runtime.start()).state, 'rebuilding');
    assert.equal(children.length, 0);
    await until(() => children.length > 0);
    assert.deepEqual(builds, [old.source, updated.source]);
  } finally {
    runtime.stop();
    children.forEach(child => child.emit('exit', 0));
  }
});

test('disabled or unsupported modes never prepare catalogs or start a process', async () => {
  for (const options of [{ mode: 'copy' }, { runtimeAutoLoad: false }, { allowWrites: false }]) {
    const runtime = createRuntimeHost({}, options, { runtimeConfiguration() { throw new Error('Unexpected preparation'); } }, { platform: 'win32' });
    assert.equal((await runtime.start()).state, 'disabled');
  }
});

test('preparation failures publish actionable explanations without private CLI diagnostics', async t => {
  for (const [error, code, message] of [
    ['Error: Official catalog returned HTTP 403. private-token', 'catalog-download-denied', /下载被拒绝/],
    ['Missing compatible zh-Hans base/dynamic catalogs. private-path', 'catalog-coverage-low', /90%/],
    ['No 3p Gateway profile found. private-path', 'gateway-not-configured', /Gateway/],
    ['Unsupported language-store export. private-path', 'frontend-changed', /尚未适配/],
    ['Unknown failure private-token', 'preparation-failed', /准备失败/]
  ]) {
    const f = fixture(t), toasts = [];
    const runtime = createRuntimeHost({ directory: f.root, client: { tui: { showToast: async ({ body }) => toasts.push(body.message) } } }, {}, runtimeController(f, {
      prepareRuntime: async () => { throw new Error(error); }
    }), { platform: 'win32', runtimeDirectory: path.join(f.root, 'runtime'), spawn: () => assert.fail('Failed preparation must not launch UI') });
    t.after(() => runtime.stop());
    const state = await runtime.start();
    assert.equal(state.state, 'preparation-failed');
    assert.equal(state.failureCode, code);
    assert.equal(state.automaticNextLaunch, false);
    assert.match(state.message, message);
    assert.deepEqual(toasts, [state.message]);
    assert.doesNotMatch(JSON.stringify(state), /private-token|private-path/);
    const saved = JSON.parse(fs.readFileSync(path.join(state.reportDirectory, 'status.json')));
    assert.equal(saved.failureCode, code);
  }
});

test('runtime controller uses the CLI and only imports after a missing-catalog refusal', async () => {
  const calls = []; let exports = 0;
  const controller = createController({ projectDirectory: project, sourceDirectory: 'original', catalogDirectory: 'catalogs' }, async (_config, args) => {
    calls.push(args);
    if (args[0] === 'detect-3p') return { configured3p: true, provider: 'gateway' };
    if (args[0] === 'runtime-export' && exports++ === 0) throw new Error('Missing compatible zh-Hans base/dynamic catalogs.');
    return { automationManifest: 'manifest' };
  });
  await controller.prepareRuntime('new.js', 'original', 'catalog-cache');
  assert.deepEqual(calls.map(x => x[0]), ['detect-3p', 'runtime-export', 'catalog', 'runtime-export']);
  assert(calls[1].includes('zh-Hans')); assert(calls[1].includes('original')); assert(calls[1].includes('new.js'));
  assert.deepEqual(calls[1].slice(-2), ['--runtime-cache', 'catalog-cache']);
  const refused = [];
  const drift = createController({ projectDirectory: project }, async (_config, args) => {
    refused.push(args[0]);
    if (args[0] === 'detect-3p') return { configured3p: true, provider: 'gateway' };
    throw new Error('Language runtime changed.');
  });
  await assert.rejects(drift.prepareRuntime('unused.js'), /changed/);
  assert.deepEqual(refused, ['detect-3p', 'runtime-export']);
});

test('fresh install fetches official catalogs only after local and cache misses', async () => {
  const calls = []; let attempts = 0;
  const c = createController({ projectDirectory: project }, async (_config, args) => {
    calls.push(args);
    if (args[0] === 'detect-3p') return { configured3p: true, provider: 'gateway', directory: 'bound-profile' };
    if (args[0] === 'runtime-export' && attempts++ < 2) throw Error('Missing compatible zh-Hans base/dynamic catalogs.');
    if (args[0] === 'catalog' && args[1] === 'cache') throw Error('No language cache found.');
    return { automationManifest: 'manifest' };
  });
  const result = await c.prepareRuntime('new.js');
  assert.equal(result.profileDirectory, 'bound-profile');
  assert.deepEqual(calls.filter(x => x[1] === 'fetch').map(x => x[x.indexOf('--kind') + 1]), ['base', 'dynamic']);
  assert.equal(calls.filter(x => x[0] === 'runtime-export').length, 3);
  assert.equal(calls.some(x => x.includes('--url')), false);
});
