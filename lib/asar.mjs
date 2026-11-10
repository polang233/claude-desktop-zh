import fs from 'node:fs';
import path from 'node:path';

export function isAsarFile(file) {
  try {
    return fs.statSync(file).isFile() && path.extname(file).toLowerCase() === '.asar';
  } catch {
    return false;
  }
}

export function readAsarPrefix(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) throw new Error('ASAR header is truncated.');
    const values = [0, 4, 8, 12].map(offset => prefix.readUInt32LE(offset));
    const jsonSize = values[3];
    if (jsonSize < 2 || jsonSize > 64 * 1024 * 1024) throw new Error('ASAR header size is invalid.');
    const json = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, json, 0, json.length, 16) !== json.length) throw new Error('ASAR header is truncated.');
    let header;
    try { header = JSON.parse(json.toString('utf8')); }
    catch { throw new Error('ASAR header is not valid JSON.'); }
    if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') throw new Error('ASAR header has no file table.');
    const dataOffset = 8 + values[1];
    if (dataOffset < 16 + jsonSize || dataOffset > fs.statSync(file).size) throw new Error('ASAR data offset is invalid.');
    return { header, dataOffset };
  } finally {
    fs.closeSync(fd);
  }
}

export function readAsar(file) {
  const { header, dataOffset } = readAsarPrefix(file);
  const fd = fs.openSync(file, 'r');
  const entries = new Map();
  function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const relative = prefix ? prefix + '/' + name : name;
      if (entry && typeof entry === 'object' && entry.files) walk(entry, relative);
      else if (entry && typeof entry === 'object') {
        const size = Number(entry.size ?? 0), offset = Number(entry.offset ?? 0);
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('ASAR entry has an invalid size or offset: ' + relative);
        entries.set(relative, { path: relative, size, offset, unpacked: entry.unpacked === true });
      }
    }
  }
  walk(header, '');
  function read(relative) {
    const normalized = relative.replaceAll('\\', '/').replace(/^\/+/, '');
    const entry = entries.get(normalized);
    if (!entry) throw new Error('ASAR entry not found: ' + normalized);
    if (entry.unpacked) return fs.readFileSync(path.join(file + '.unpacked', ...normalized.split('/')));
    const bytes = Buffer.alloc(entry.size);
    const read = fs.readSync(fd, bytes, 0, entry.size, dataOffset + entry.offset);
    if (read !== entry.size) throw new Error('ASAR entry is truncated: ' + normalized);
    return bytes;
  }
  function list(prefix = '') {
    const normalized = prefix.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return [...entries.values()].filter(entry => !normalized || entry.path === normalized || entry.path.startsWith(normalized + '/'));
  }
  function close() {
    try { fs.closeSync(fd); } catch {}
  }
  return { file, entries, dataOffset, read, list, close };
}
