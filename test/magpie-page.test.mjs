import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pageFixture } from './page-fixture.mjs';

test('unified page saves preferences, handles failures, and switches panels without writes', async () => {
  const ui = pageFixture(), calls = [];
  const messages = [];
  let fail = false;
  await vm.runInNewContext(fs.readFileSync(new URL('../integrations/magpie/page/app.js', import.meta.url), 'utf8'), {
    ...ui, URLSearchParams, location: { hash: '#token=' + 'a'.repeat(64), pathname: '/' }, history: { replaceState() {} },
    parent: { postMessage: value => messages.push(value) }, addEventListener() {},
    fetch: async (url, init) => { calls.push({url,init}); return { ok: !fail, json: async () => url === '/api/state' ? { version: '1.1.1-local.3', paths: { mode: 'original', allowWrites: true }, preferences: { locale: 'zh-Hans', runtimeAutoLoad: true }, canSave: true } :
      url === '/api/maintenance' ? { resources: 'protected', runtime: { state: 'watching', lastResult: 'Applied' } } : {error:'Unavailable'} }; }
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
  e('locale').value = 'zh-Hant'; e('runtime-auto').checked = false;
  await e('runtime-auto').events.change();
  assert.deepEqual(JSON.parse(calls.find(call => call.url === '/api/preferences').init.body), {locale:'zh-Hant',runtimeAutoLoad:false,method:'runtime'});
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
  await vm.runInNewContext(fs.readFileSync(new URL('../integrations/magpie/page/app.js', import.meta.url), 'utf8'), {
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
  assert.equal(ui.elements.get('in-place-option').disabled, true);
  assert.match(stage.textContent, /已就绪/);
  runtime = { state: 'watching', progress: 'loading', lastResult: 'Applied' };
  await poll(); assert.match(stage.textContent, /正在加载/);
  runtime = { state: 'watching', lastResult: 'FocusChanged' };
  await poll(); assert.match(stage.textContent, /FocusChanged/);
  runtime = { state: 'watching', lastResult: 'Applied' };
  await poll(); assert.match(stage.textContent, /已加载中文/);
  assert.equal(calls.filter(url => url === '/api/maintenance').length, 1);
});
