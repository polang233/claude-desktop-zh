import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAsar } from '../lib/asar.mjs';
import { inspect } from '../lib/install.mjs';
import { discoverInstall } from '../lib/discover.mjs';
import { saveCatalog } from '../lib/catalogs.mjs';
import { runtimeSpec } from '../scripts/build-runtime-localization.mjs';

function buildAsar(entries) {
  const tree = { files: {} };
  const data = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const parts = name.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node.files[part] ??= { files: {} };
    const bytes = Buffer.from(value);
    node.files[parts.at(-1)] = { size: String(bytes.length), offset: String(offset) };
    data.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padding = (4 - (json.length % 4)) % 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + json.length + padding, 4);
  prefix.writeUInt32LE(4 + json.length + padding, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padding), ...data]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zh-asar-'));
  const app = path.join(root, 'package', 'app');
  const resources = path.join(app, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(app, 'claude.exe'), '');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'app');
  const english = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key-${index}`, `English ${index}`]));
  const dynamicEnglish = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`dynamic-${index}`, `Dynamic ${index}`]));
  const chinese = Object.fromEntries(Object.keys(english).map((key, index) => [key, `中文 ${index}`]));
  const dynamicChinese = Object.fromEntries(Object.keys(dynamicEnglish).map((key, index) => [key, `动态 ${index}`]));
  const runtime = 'var ru=xi((e,t)=>({messages:{},messagesLocale:null,gates:[],localeOverride:null,setLocaleOverride:t=>e({localeOverride:t})}));function Xl(){return document.querySelector(\'meta[name="i18n-catalogs"]\')?.dataset.i18nCatalogs||""}const localeKey="spa:locale";export{ru as jw};';
  const selector = '{"en-US":{name:"English (United States)",localName:"English (United States)"},"pt-BR":{name:"Portuguese (Brazil)",localName:"Português (Brasil)"},"id-ID":{name:"Indonesian",localName:"Bahasa Indonesia"}}';
  fs.writeFileSync(path.join(resources, 'ion-dist.asar'), buildAsar([
    ['assets/v1/shared-99-test.js', runtime],
    ['assets/v1/selector-test.js', selector],
    ['i18n/en-US.json', JSON.stringify(english)],
    ['i18n/dynamic/en-US.json', JSON.stringify(dynamicEnglish)]
  ]));
  const catalogs = path.join(root, 'catalogs');
  saveCatalog(catalogs, 'zh-Hans', 'base', Buffer.from(JSON.stringify(chinese)));
  saveCatalog(catalogs, 'zh-Hans', 'dynamic', Buffer.from(JSON.stringify(dynamicChinese)));
  return { root, app, catalogs };
}

test('reads packed Claude frontend entries through the ASAR file table', () => {
  const { app } = fixture();
  const archive = readAsar(path.join(app, 'resources', 'ion-dist.asar'));
  try {
    assert.equal(archive.read('i18n/en-US.json').toString('utf8').startsWith('{"key-0"'), true);
    assert.equal(archive.read('assets/v1/shared-99-test.js').toString('utf8').includes('spa:locale'), true);
    assert(archive.list('assets').length >= 2);
    assert.throws(() => archive.read('missing.js'), /not found/);
  } finally { archive.close(); }
});

test('discovers and inspects a packed Windows installation without resource writes', () => {
  const { root, app } = fixture();
  const env = { LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), USERPROFILE: root };
  const found = discoverInstall(env, () => [path.join(root, 'package')], 'win32');
  assert.equal(found.source, app);
  const report = inspect(app);
  assert.equal(report.frontend, 'asar');
  assert.equal(report.runtimeOnly, true);
  assert.equal(report.patchable, false);
  assert.match(report.reason, /runtime localization only/);
  assert.equal(report.englishKeys, 1000);
});

test('exports a runtime spec from a packed frontend and current catalogs', () => {
  const { root, app, catalogs } = fixture();
  const spec = runtimeSpec(app, catalogs, 'zh-Hans');
  assert.equal(spec.runtimeUrl, '/assets/v1/shared-99-test.js');
  assert.equal(spec.storeExport, 'jw');
  assert.equal(Object.keys(spec.base).length, 1000);
  assert.equal(Object.keys(spec.dynamic).length, 12);
  assert.notEqual(root, '');
});
