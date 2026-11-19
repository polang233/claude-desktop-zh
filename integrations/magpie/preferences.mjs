import fs from 'node:fs';
import path from 'node:path';
import { defaultLayout } from '../../lib/discover.mjs';
import { withRuntimeLock } from '../../lib/runtime-lock.mjs';
import { randomUUID } from 'node:crypto';
import { assertPlainDirectory, sha256, writeJSON } from '../../lib/common.mjs';

export function validatePreferences(value, fallbackMethod = 'runtime') {
  const method = value?.method === undefined ? fallbackMethod : value.method;
  if (!value || !['zh-Hans', 'zh-Hant'].includes(value.locale) || typeof value.runtimeAutoLoad !== 'boolean'
      || !['runtime', 'in-place'].includes(method)
      || Object.keys(value).some(key => !['locale', 'runtimeAutoLoad', 'method'].includes(key))) throw new Error('Invalid language preferences.');
  return { locale: value.locale, runtimeAutoLoad: value.runtimeAutoLoad, method };
}
export function preferenceStore(options, directory = defaultLayout().originalStateDirectory) {
  const file = path.resolve(directory, 'language-preferences.json');
  const defaults = () => ({ locale: options.locale ?? 'zh-Hans', runtimeAutoLoad: options.runtimeAutoLoad !== false });
  function bytes() {
    assertPlainDirectory(directory);
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Preferences cannot be a symbolic link.');
      return fs.readFileSync(file);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function snapshot() {
    const raw = bytes();
    if (!raw) return { value: validatePreferences(defaults()), revision: 'missing' };
    const saved = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
    const preferences = validatePreferences(saved.value);
    const value = JSON.stringify(saved.source) === JSON.stringify(defaults()) ? preferences : { ...defaults(), method: preferences.method };
    return { value, revision: sha256(raw) };
  }
  return {
    file, snapshot, read: () => snapshot().value,
    revision() { const raw = bytes(); return raw ? sha256(raw) : 'missing'; },
    exclusive(action) {
      assertPlainDirectory(directory);
      fs.mkdirSync(directory, { recursive: true });
      return withRuntimeLock(directory, action);
    },
    write(value) {
      value = validatePreferences(value, snapshot().value.method);
      writeJSON(file, { version: 2, revision: randomUUID(), source: defaults(), value });
      return value;
    }
  };
}
