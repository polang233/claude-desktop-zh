import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pageFixture } from './page-fixture.mjs';

const app = fs.readFileSync(new URL('../integrations/magpie/page/app.js', import.meta.url), 'utf8');

test('unified page saves preferences, handles failures, and switches panels without writes', async () => {
  const ui = pageFixture(), calls = [];
  const messages = [];
  let fail = false;
  await vm.runInNewContext(app, {
    ...ui, URLSearchParams, location: { hash: '#token=' + 'a'.repeat(64), pathname: '/' }, history: { replaceState() {} },
    parent: { postMessage: value => messages.push(value) }, addEventListener() {},
    fetch: async (url, init) => { calls.push({url,init}); return { ok: !fail, json: async () => url === '/api/state' ? { version: '1.1.1-local.3', paths: { mode: 'original', allowWrites: true }, preferences: { locale: 'zh-Hans', runtimeAutoLoad: true }, canSave: true } :
      url === '/api/maintenance' ? { resources: 'protected', runtime: { state: 'watching', lastResult: 'Applied' } } :
        url === '/api/preferences' && !fail ? JSON.parse(init.body) : {error:'Unavailable'} }; }
  });
  const e = id => ui.elements.get(id);
  assert.equal(messages[0].method, 'hello', 'The magpie host must receive its page handshake');
  assert.equal(e('plugin-version').textContent, '版本 1.1.1-local.3');
  assert.equal(e('locale').value, 'zh-Hans'); assert.equal(e('runtime-auto').checked, true);
  ui.tabs[0].events.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(ui.tabs[1].attributes['aria-selected'], 'true');
  assert.equal(ui.panels[0].attributes.hidden, 'until-found');
  await e('refresh-maintenance').click();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, undefined);
  assert.match(e('runtime-status').textContent, /已加载中文/);
  assert.match(e('resource-status').textContent, /不可改写/);
  ui.panels[0].events.beforematch();
  assert.equal(ui.tabs[0].attributes['aria-selected'], 'true');
  e('locale').value = 'zh-Hant';
  await e('locale').events.change();
  e('runtime-auto').checked = false;
  await e('runtime-auto').events.change();
  assert.deepEqual(JSON.parse(calls.filter(call => call.url === '/api/preferences').at(-1).init.body), {locale:'zh-Hant',runtimeAutoLoad:false,method:'runtime'});
  assert.equal(e('auto-state').textContent, '已停用');
  assert.equal(e('status').textContent, '');
  fail = true;
  e('runtime-auto').checked = true;
  await e('runtime-auto').events.change();
  assert.match(e('status').textContent, /保存失败/);
  assert.equal(e('runtime-auto').disabled, false);
  assert.equal(e('runtime-auto').checked, false);
  assert.equal(e('auto-state').textContent, '已停用');
  let intercepted = false;
  for (const destination of ['repository', 'author']) {
    intercepted = false;
    await e(destination + '-link').click({ preventDefault() { intercepted = true; } });
    assert.equal(intercepted, true);
    assert.equal(calls.at(-1).url, '/api/open-link/' + destination);
    assert.equal(calls.at(-1).init.method, 'POST');
    assert.equal(calls.at(-1).init.body, undefined);
    assert.match(e('project-link-status').textContent, /可复制此地址/);
  }
});

test('visible stage prioritizes loading and follows the final result without rechecking application files', async () => {
  const ui = pageFixture(), calls = [];
  let poll, runtime = { state: 'watching' };
  await vm.runInNewContext(app, {
    ...ui, URLSearchParams, location: { hash: '#token=' + 'a'.repeat(64), pathname: '/' }, history: { replaceState() {} },
    setInterval(callback) { poll = callback; },
    fetch: async url => {
      calls.push(url);
      const result = url === '/api/state' ? { paths: { mode: 'original' }, preferences: { locale: 'zh-Hans', runtimeAutoLoad: true }, canSave: true } :
        url === '/api/maintenance' ? { resources: 'protected', runtime } : { runtime };
      return { ok: true, json: async () => result };
    }
  });
  const stage = ui.elements.get('live-stage');
  assert.equal(ui.elements.get('method').disabled, false);
  assert.match(stage.textContent, /已就绪/);
  runtime = { state: 'watching', progress: 'loading', lastResult: 'Applied' };
  await poll(); assert.match(stage.textContent, /正在加载/);
  runtime = { state: 'watching', lastResult: 'FocusChanged' };
  await poll(); assert.match(stage.textContent, /FocusChanged/);
  runtime = { state: 'watching', lastResult: 'Applied' };
  await poll(); assert.match(stage.textContent, /已加载中文/);
  assert.equal(calls.filter(url => url === '/api/maintenance').length, 1);
});

test('method selection waits for confirmation and saves without starting or writing to the application', async () => {
  const install = { dataset: { action: 'install', mode: 'original', write: 'true' }, addEventListener() {} };
  const ui = pageFixture([install]), requests = [];
  let preferences = { locale: 'zh-Hans', runtimeAutoLoad: true, method: 'runtime' };
  await vm.runInNewContext(app, {
    ...ui, URLSearchParams, location: { hash: '#token=' + 'a'.repeat(64), pathname: '/' }, history: { replaceState() {} },
    fetch: async (url, init) => {
      const body = init.body && JSON.parse(init.body);
      requests.push({ url, body });
      if (url === '/api/preferences') {
        const { confirmMethod, ...saved } = body;
        if (saved.method !== preferences.method) assert.equal(confirmMethod, saved.method);
        preferences = saved;
      }
      const result = url === '/api/state' ? { paths: { mode: 'original', allowWrites: true }, preferences, canSave: true } :
        url === '/api/maintenance' ? { resources: 'protected', transaction: { status: 'not-installed' } } : preferences;
      return { ok: true, json: async () => result };
    }
  });
  const get = id => ui.elements.get(id);
  const method = get('method'), dialog = get('confirm-action'), automatic = get('runtime-auto');
  const pick = selected => { method.value = selected; return method.events.change(); };
  const pending = pick('in-place');
  assert.equal(dialog.open, true);
  assert.equal(method.value, 'runtime');
  assert(!requests.some(request => request.body));
  await get('confirm-cancel').click();
  await pending;
  assert.equal(automatic.checked, true);
  const confirmation = pick('in-place');
  dialog.events.close();
  assert.equal(dialog.open, true);
  await get('confirm-accept').click();
  await confirmation;
  assert.equal(method.value, 'in-place');
  assert.equal(automatic.checked, false);
  assert.equal(install.disabled, true);
  assert.match(get('method-note').textContent, /MSIX/);
  const back = pick('runtime');
  await get('confirm-accept').click();
  await back;
  assert.equal(method.value, 'runtime');
  assert.equal(automatic.checked, false);
  assert.equal(get('auto-state').textContent, '已停用');
  assert.equal(automatic.disabled, false);
  automatic.checked = true;
  await automatic.events.change();
  assert.deepEqual(requests.filter(request => request.body).map(request => [request.url, request.body.runtimeAutoLoad]),
    [['/api/preferences', false], ['/api/preferences', false], ['/api/preferences', true]]);
});

test('built-in patch mode offers apply and restore only after exact confirmation', async () => {
  const buttons = [
    { dataset: { action: 'third-party-apply', write: 'true' }, addEventListener(_event, callback) { this.click = callback; } },
    { dataset: { action: 'third-party-restore', write: 'true' }, addEventListener(_event, callback) { this.click = callback; } }
  ];
  const ui = pageFixture(buttons), calls = [];
  const preferences = { locale: 'zh-Hans', runtimeAutoLoad: false, method: 'third-party' };
  await vm.runInNewContext(app, {
    ...ui, URLSearchParams, location: { hash: '#token=' + 'a'.repeat(64), pathname: '/' }, history: { replaceState() {} },
    setTimeout: callback => { callback(); },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const body = url === '/api/state' ? { paths: { mode: 'original', allowWrites: true, source: 'C:\\Claude\\app' }, preferences, canSave: true } :
        url === '/api/maintenance' ? { resources: 'protected', thirdParty: {
          mode: 'third-party', supported: true, status: 'installed', locale: 'zh-Hans',
          source: 'C:\\Claude\\app', backupDirectory: 'C:\\Claude\\app\\resources\\.zh-cn-backups\\20261126',
          canApply: true, canRestore: true, bundle: { verified: true }
        } } :
          url === '/api/run' ? { id: 'third-party-job', state: 'running' } :
            url === '/api/jobs/third-party-job' ? { action: 'third-party-restore', state: 'done', result: { status: 'restored' } } : preferences;
      return { ok: true, json: async () => body };
    }
  });
  const get = id => ui.elements.get(id);
  assert.equal(get('method').value, 'third-party');
  assert.equal(get('auto-row').hidden, true);
  assert.equal(get('third-party-actions').hidden, false);
  assert.match(get('patch-status').textContent, /已应用简体中文/);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, false);
  const pending = buttons[1].click();
  assert.equal(get('confirm-action').open, true);
  assert.match(get('confirm-details').textContent, /备份恢复/);
  assert.match(get('confirm-details').textContent, /完全退出 Claude/);
  await get('confirm-accept').click();
  await pending;
  const run = calls.find(call => call.url === '/api/run');
  assert.deepEqual(JSON.parse(run.init.body), { action: 'third-party-restore', confirm: 'third-party-restore', locale: 'zh-Hans' });
  assert.match(get('status').textContent, /已恢复原样/);
});

const entryURL = 'http://wails.localhost/_magpie/plugin/' + 'a'.repeat(32) + '/index.html';
const publishedURL = value => 'http://127.0.0.1:46123/#token=' + value.repeat(64);

async function renderEmbedded(address, { fetch, publication, buttons } = {}) {
  const ui = pageFixture(buttons);
  const location = new URL(address);
  const navigations = [], assetRequests = [], listeners = new Set();
  location.replace = target => navigations.push(new URL(target));
  let poll;
  const parent = { postMessage(message) {
    if (message.method !== 'asset') return;
    assetRequests.push(new URL(message.params.url));
    const published = publication();
    const reply = { magpie: 1, id: message.id };
    // An unrelated frame cannot answer a request for the session file.
    for (const listener of listeners) listener({ source: {}, data: reply });
    if (published) reply.result = {
      data: new TextEncoder().encode('globalThis.claudeChineseSession=' + JSON.stringify(published) + ';').buffer
    };
    for (const listener of listeners) listener({ source: parent, data: reply });
  } };
  const context = vm.createContext({ ...ui, URL, URLSearchParams, ArrayBuffer, TextDecoder, fetch, location, parent,
    history: { replaceState() { location.hash = ''; } },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    setInterval(callback) { poll = callback; },
    setTimeout(callback, timeout) {
      if (timeout === 1000) { queueMicrotask(callback); return; }
      return setTimeout(callback, timeout);
    }, clearTimeout
  });
  ui.document.head = { append(script) {
    assert.match(script.src, /^\.runtime-session\/current\.js\?t=\d+$/);
    const address = publication();
    if (!address) script.onerror();
    else { context.claudeChineseSession = address; script.onload(); }
  } };
  await vm.runInContext(app, context);
  return { get: id => ui.elements.get(id), navigations, poll, assetRequests };
}

test('a lost save response reconnects to fresh state without replaying the write', async () => {
  let preferences = { locale: 'zh-Hans', runtimeAutoLoad: true, method: 'runtime' };
  const writes = [], calls = [];
  const a = await renderEmbedded(entryURL, { publication: () => publishedURL('a') });
  const first = a.navigations[0];
  const fetch = async (url, init) => {
    calls.push(url);
    if (init.method === 'POST') {
      assert.equal(url, '/api/preferences');
      const { confirmMethod, ...saved } = JSON.parse(init.body);
      writes.push({ ...saved, confirmMethod });
      preferences = saved;
      if (writes.length === 1) return { ok: true, json: async () => { throw new TypeError('Connection closed'); } };
    }
    const body = url === '/api/state' ? { paths: { mode: 'original', allowWrites: true }, preferences, canSave: true } :
      url === '/api/maintenance' ? { resources: 'protected', transaction: { status: 'not-installed' } } : preferences;
    return { ok: true, json: async () => body };
  };
  const publications = [publishedURL('a'), null, publishedURL('b')];
  const old = await renderEmbedded(first, { fetch, publication: () => publications.shift() });
  old.get('runtime-auto').checked = false;
  await old.get('runtime-auto').events.change();
  assert.equal(old.get('runtime-auto').disabled, true);
  await old.poll();
  await new Promise(setImmediate);
  assert.equal(old.navigations.length, 1);
  assert.equal(publications.length, 0);
  assert.equal(old.assetRequests.length, 3);
  for (const request of old.assetRequests) {
    assert.equal(request.origin, new URL(entryURL).origin);
    assert.equal(request.pathname, new URL('.runtime-session/current.js', entryURL).pathname);
    assert(!request.href.includes('a'.repeat(64)));
  }
  const [next] = old.navigations;
  assert.equal(next.port, first.port);
  assert.equal(next.search, '?reconnected=1');
  assert.equal(new URLSearchParams(next.hash.slice(1)).get('token'), 'b'.repeat(64));
  const install = { dataset: { action: 'install', mode: 'original', write: 'true' }, addEventListener() {} };
  const reconnected = await renderEmbedded(next, { fetch, buttons: [install] });
  assert.equal(writes.length, 1);
  assert.equal(reconnected.get('runtime-auto').checked, false);
  assert.equal(reconnected.get('runtime-auto').disabled, false);
  assert.match(reconnected.get('status').textContent, /已重新连接/);
  const method = reconnected.get('method');
  method.value = 'in-place';
  const pending = method.events.change();
  assert.equal(writes.length, 1);
  assert.equal(reconnected.get('confirm-action').open, true);
  await reconnected.get('confirm-accept').click();
  await pending;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].confirmMethod, 'in-place');
  assert.equal(writes[1].runtimeAutoLoad, false);
  assert.equal(method.value, 'in-place');
  assert.equal(install.disabled, true);
  assert(!calls.includes('/api/run'));
});

test('the sidebar waits for a replacement and bounds retries when the old publication remains', async () => {
  let reads = 0, available = publishedURL('a');
  const first = (await renderEmbedded(entryURL, { publication: () => available })).navigations[0];
  const disconnected = await renderEmbedded(first, {
    fetch: async () => ({ status: 409, ok: false, json: async () => ({ code: 'session-retired' }) }),
    publication: () => { reads++; return available; }
  });
  await new Promise(setImmediate);
  assert.equal(reads, 12);
  assert.equal(disconnected.navigations.length, 0);
  assert.equal(disconnected.get('retry-connection').hidden, false);
  available = publishedURL('b');
  await disconnected.get('retry-connection').click();
  assert.equal(disconnected.navigations.length, 1);
});

test('a rejected session cannot redirect the frame to an untrusted return page', async () => {
  const address = new URL(publishedURL('a'));
  address.hash += '&frame=1&page=' + encodeURIComponent(entryURL.replace('wails.localhost', 'wails.localhost.example'));
  const page = await renderEmbedded(address, { fetch: async () => ({ status: 401, ok: false, json: async () => ({}) }) });
  assert.equal(page.navigations.length, 0);
  assert.match(page.get('status').textContent, /连接已中断/);
});
