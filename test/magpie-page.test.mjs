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
    fetch: async (url, init) => { calls.push({url,init}); return { ok: !fail, json: async () => url === '/api/state' ? { paths: { mode: 'original', allowWrites: true }, preferences: { locale: 'zh-Hans', runtimeAutoLoad: true }, canSave: true } : {error:'Unavailable'} }; }
  });
  const e = id => ui.elements.get(id);
  assert.equal(messages[0].method, 'hello', 'The magpie host must receive its page handshake');
  assert.equal(e('locale').value, 'zh-Hans'); assert.equal(e('runtime-auto').checked, true);
  ui.tabs[0].events.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(ui.tabs[1].attributes['aria-selected'], 'true');
  assert.equal(ui.panels[0].attributes.hidden, 'until-found');
  assert.equal(calls.length, 1);
  ui.panels[0].events.beforematch();
  assert.equal(ui.tabs[0].attributes['aria-selected'], 'true');
  e('locale').value = 'zh-Hant'; e('runtime-auto').checked = false;
  await e('runtime-auto').events.change();
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), {locale:'zh-Hant',runtimeAutoLoad:false});
  assert.equal(e('auto-state').textContent, '已停用');
  assert.equal(e('status').textContent, '');
  fail = true;
  e('runtime-auto').checked = true;
  await e('runtime-auto').events.change();
  assert.match(e('status').textContent, /保存失败/);
  assert.equal(e('runtime-auto').disabled, false);
  assert.equal(e('runtime-auto').checked, false);
  assert.equal(e('auto-state').textContent, '已停用');
});
