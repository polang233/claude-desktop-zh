import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { pageFixture } from './page-fixture.mjs';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sidebar-')));
  const spec = path.join(dir, 'package');
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['integrations', 'lib', 'package.json']) {
    fs.cpSync(path.join(source, name), path.join(spec, name), { recursive: true });
  }
  const options = { allowWrites: false, runtimeAutoLoad: false, stateDirectory: path.join(dir, 'state') };
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ spec, options }] }));
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(stop));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function start() {
    const child = fork(new URL('./fixtures/sidebar-host.mjs', import.meta.url), [], { cwd: dir, execArgv: [], windowsHide: true });
    children.add(child);
    const [page] = await once(child, 'message', { signal: AbortSignal.timeout(15000) });
    return { child, url: new URL(page.url), note: page.note };
  }
  async function stop(child, mode = 'close') {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      if (child.connected) child.send(mode);
      await ended;
    }
    children.delete(child);
  }
  const folder = path.join(spec, 'integrations/magpie/page');
  const file = path.join(folder, '.runtime-session', 'current.js');
  const script = fs.readFileSync(path.join(folder, 'app.js'), 'utf8');
  async function sidebar() {
    const ui = pageFixture();
    let destination;
    const context = vm.createContext({ ...ui, URL, URLSearchParams,
      setTimeout, clearTimeout,
      location: { href: 'http://wails.localhost/_magpie/plugin/' + 'a'.repeat(32) + '/index.html',
        hash: '', replace: url => { destination = new URL(url); } } });
    ui.document.head = { append: loader => {
      assert.match(loader.src, /^\.runtime-session\/current\.js\?t=\d+$/);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context);
      loader.onload();
    } };
    await vm.runInContext(script, context);
    return destination;
  }
  return { start, stop, sidebar, file, dir };
}

function status(url, token = url.hash.slice(7).split('&')[0]) {
  return fetch(new URL('/api/runtime', url), { headers: { authorization: 'Bearer ' + token } }).then(r => r.status);
}

test('sidebar keeps its live host, fails over after exit, and rejects another host’s token', async t => {
  const f = fixture(t), a = await f.start(), b = await f.start();
  assert.notEqual(a.url.port, b.url.port);
  assert.equal((await f.sidebar()).port, a.url.port);
  await f.stop(b.child);
  const sidebar = await f.sidebar();
  assert.equal(sidebar.port, a.url.port);
  assert.equal(await status(sidebar), 200);
  assert.equal(await status(sidebar, b.url.hash.slice(7)), 401);
  const c = await f.start();
  await f.stop(a.child, 'crash');
  for (let i = 0; i < 100 && (await f.sidebar()).port !== c.url.port; ++i) await delay(100);
  const recovered = await f.sidebar();
  assert.equal(recovered.port, c.url.port);
  assert.equal(await status(recovered), 200);
  assert.equal(await status(recovered, a.url.hash.slice(7)), 401);
  await f.stop(c.child);
  assert.equal(fs.existsSync(f.file), false);
});

test('sidebar retires a live but revoked session and leaves the successor intact on close', async t => {
  const f = fixture(t), a = await f.start();
  fs.appendFileSync(path.join(f.dir, 'plugins.json'), '\n');
  assert.equal(await status(a.url), 409);
  const b = await f.start();
  assert.equal((await f.sidebar()).port, b.url.port);
  await f.stop(a.child);
  assert.equal(await status(await f.sidebar()), 200);
});

test('concurrent starts elect one publisher and the survivor takes over on graceful shutdown', async t => {
  const f = fixture(t);
  const hosts = await Promise.all([f.start(), f.start()]);
  const initial = await f.sidebar();
  const owner = hosts.find(host => host.url.port === initial.port);
  assert.ok(owner);
  const standby = hosts.find(host => host !== owner);
  await delay(2200);
  assert.equal((await f.sidebar()).port, owner.url.port);
  await f.stop(owner.child);
  for (let i = 0; i < 100 && !fs.existsSync(f.file); ++i) await delay(100);
  assert.equal((await f.sidebar()).port, standby.url.port);
  assert.equal(await status(await f.sidebar()), 200);
});

test('a reused port cannot receive the bearer or claim the sidebar with an unrelated response', async t => {
  const f = fixture(t), secret = randomBytes(32).toString('hex'), requests = [];
  const other = http.createServer((req, res) => {
    requests.push({path: req.url, headers: req.headers});
    res.writeHead(204); res.end();
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => other.close());
  fs.mkdirSync(path.dirname(f.file), {recursive:true});
  fs.writeFileSync(f.file, 'globalThis.claudeChineseSession="http://127.0.0.1:' +
    other.address().port + '/#token=' + secret + '";\n');
  const host = await f.start();
  assert.equal((await f.sidebar()).port, host.url.port);
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /^\/sidebar-session\/[a-f0-9]{48}$/);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(JSON.stringify(requests).includes(secret), false);
});

test('a publication error still allows a private workbench and recovers once writable', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.file, {recursive:true});
  const a = await f.start();
  assert.match(a.note, /写入失败/);
  assert.equal(await status(a.url), 200);
  fs.rmdirSync(f.file);
  for (let i = 0; i < 100 && !fs.existsSync(f.file); ++i) await delay(100);
  assert.equal((await f.sidebar()).port, a.url.port);
});
