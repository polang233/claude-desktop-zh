import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('magpie settings page saves language through its documented bridge without running commands', async () => {
  const source = fs.readFileSync(new URL('../integrations/magpie/page/app.js', import.meta.url), 'utf8');
  const elements = { locale: { value: '' }, save: { addEventListener(name, callback) { this.callback = callback; } }, status: {}, 'runtime-auto': { checked: false } };
  let saved, failSave = false;
  await vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] },
    magpie: { ready: Promise.resolve(), options: { get: async () => ({ nodeExecutable: 'saved-node' }), set: async value => { if (failSave) throw Error('Unavailable'); saved = value; return value; } } }
  });
  assert.equal(elements.locale.value, 'zh-Hans'); assert(elements['runtime-auto'].checked);
  elements.locale.value = 'zh-Hant';
  await elements.save.callback();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { nodeExecutable: 'saved-node', locale: 'zh-Hant', runtimeAutoLoad: true });
  assert.match(elements.status.textContent, /已保存.*下次/);
  assert(!source.includes('fetch(')); assert(!source.includes('child_process'));
  elements['runtime-auto'].checked = false;
  await elements.save.callback();
  assert.equal(saved.runtimeAutoLoad, false);
  assert.match(elements.status.textContent, /关闭/);
  failSave = true;
  await elements.save.callback();
  assert.match(elements.status.textContent, /保存失败/);
  assert.equal(elements.save.disabled, false);
});
