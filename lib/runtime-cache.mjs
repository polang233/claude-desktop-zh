import fs from 'node:fs';
import path from 'node:path';
import { withRuntimeLock } from './runtime-lock.mjs';
import { filesBelow, inside, localeValue, readJSON, sha256, assertPlainDirectory } from './common.mjs';
import { runtimeSourceBinding } from './discover.mjs';
import { frontendLayout, resourcesAt } from './patch.mjs';
import { pickerManifest, runtimeSpec } from '../scripts/build-runtime-localization.mjs';

const version = readJSON(new URL('../package.json', import.meta.url)).version;

function inputIdentity(source, catalogs, locale) {
  const files = [];
  const layout = frontendLayout(resourcesAt(source));
  if (layout.kind === 'directory') {
    files.push(...filesBelow(path.join(layout.path, 'assets')).filter(file => file.endsWith('.js')),
      path.join(layout.path, 'i18n/en-US.json'), path.join(layout.path, 'i18n/dynamic/en-US.json'));
  }
  for (const kind of ['base', 'dynamic']) {
    const dir = path.join(catalogs, locale, kind);
    if (fs.existsSync(dir)) files.push(...fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => path.join(dir, name)));
  }
  const stamps = files.sort().map(file => {
    const stat = fs.statSync(file, { bigint: true });
    return [file, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  });
  return sha256(JSON.stringify([1, version, locale, runtimeSourceBinding(source).revision, path.resolve(catalogs), stamps]));
}

// A fixed staging name is safe under the per-locale lock and survives interrupted replacement.
// Rename replaces only the cache link. Running watchers keep the old file through their own link.
function replaceFile(file, bytes) {
  const next = inside(path.dirname(file), path.basename(file) + '.next');
  fs.rmSync(next, { force: true });
  fs.writeFileSync(next, bytes, { flag: 'wx', mode: 0o600 });
  fs.renameSync(next, file);
}

export async function buildHostedRuntime(source, catalogs, locale, output, cache) {
  const folder = path.resolve(cache, localeValue(locale));
  assertPlainDirectory(folder);
  fs.mkdirSync(folder, { recursive: true });
  return withRuntimeLock(folder, () => {
    const data = inside(folder, 'catalog.json'), index = inside(folder, 'index.json');
    const key = inputIdentity(source, catalogs, locale);
    let previous;
    try { previous = readJSON(index); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const reused = previous?.key === key && fs.existsSync(data) && sha256(fs.readFileSync(data)) === previous.sha256;
    let digest;
    if (reused) digest = previous.sha256;
    else {
      const bytes = Buffer.from(JSON.stringify(runtimeSpec(source, catalogs, locale)));
      if (inputIdentity(source, catalogs, locale) !== key) throw new Error('Runtime inputs changed during export.');
      digest = sha256(bytes);
      replaceFile(data, bytes);
      replaceFile(index, JSON.stringify({ key, sha256: digest }));
    }
    const { automation, manifest } = pickerManifest(source, locale, output, digest);
    const automationManifest = path.resolve(output + '.automation.json');
    const created = [];
    try {
      try { fs.linkSync(data, manifest.catalogFile); }
      catch (error) {
        if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EMLINK'].includes(error.code)) throw error;
        fs.copyFileSync(data, manifest.catalogFile, fs.constants.COPYFILE_EXCL);
      }
      created.push(manifest.catalogFile);
      for (const [file, content] of [[manifest.payload, automation], [automationManifest, JSON.stringify(manifest)]]) {
        fs.writeFileSync(file, content, { flag: 'wx' });
        created.push(file);
      }
    } catch (error) {
      for (const file of created) fs.unlinkSync(file);
      throw error;
    }
    return { automationManifest, reused };
  });
}
