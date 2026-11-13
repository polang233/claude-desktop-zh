import fs from 'node:fs';
import path from 'node:path';
import { defaultLayout } from '../../lib/discover.mjs';
import { assertPlainDirectory, readJSON, writeJSON } from '../../lib/common.mjs';

export function validatePreferences(value) {
  if (!value || !['zh-Hans', 'zh-Hant'].includes(value.locale) || typeof value.runtimeAutoLoad !== 'boolean'
      || Object.keys(value).some(key => !['locale', 'runtimeAutoLoad'].includes(key))) throw new Error('Invalid language preferences.');
  return { locale: value.locale, runtimeAutoLoad: value.runtimeAutoLoad };
}
export function preferenceStore(options, directory = defaultLayout().originalStateDirectory) {
  const file = path.join(directory, 'language-preferences.json');
  const defaults = () => ({ locale: options.locale ?? 'zh-Hans', runtimeAutoLoad: options.runtimeAutoLoad !== false });
  function read() {
    assertPlainDirectory(directory);
    if (!fs.existsSync(file)) return defaults();
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Preferences cannot be a symbolic link.');
    const saved = readJSON(file);
    // A preference changed through magpie's existing options still takes effect.
    return JSON.stringify(saved.source) === JSON.stringify(defaults()) ? validatePreferences(saved.value) : defaults();
  }
  return { read, write(value) {
    value = validatePreferences(value); read();
    writeJSON(file, { version: 1, source: defaults(), value });
    return value;
  } };
}
