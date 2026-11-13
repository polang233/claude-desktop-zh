import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { preferenceStore } from '../integrations/magpie/preferences.mjs';

test('language preferences persist outside application data and still honor changed magpie options', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-preferences-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const saved = { locale: 'zh-Hant', runtimeAutoLoad: false };
  const store = preferenceStore({}, folder);
  assert.deepEqual(store.read(), { locale: 'zh-Hans', runtimeAutoLoad: true });
  store.write(saved);
  assert.deepEqual(preferenceStore({}, folder).read(), saved);
  assert.deepEqual(preferenceStore({ locale: 'zh-Hans', runtimeAutoLoad: false }, folder).read(), { locale: 'zh-Hans', runtimeAutoLoad: false });
  const before = fs.readFileSync(path.join(folder, 'language-preferences.json'));
  for (const value of [{ locale: 'en-US', runtimeAutoLoad: true }, { ...saved, command: 'arbitrary' }, { locale: 'zh-Hans' }]) assert.throws(() => store.write(value), /Invalid/);
  assert(before.equals(fs.readFileSync(path.join(folder, 'language-preferences.json'))));
});
