import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from './common.mjs';

// The OS releases a Windows named pipe when the exporting CLI exits, even on a crash.
export async function withRuntimeLock(folder, action, waitMs = 30_000) {
  const absolute = fs.realpathSync(folder);
  const id = sha256(process.platform === 'win32' ? absolute.toLowerCase() : absolute).slice(0, 32);
  const name = 'claude-zh-runtime-' + id;
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name
    : process.platform === 'linux' ? '\0' + name : path.join('/tmp', name + '.sock');
  const server = net.createServer(socket => socket.destroy());
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const ready = once(server, 'listening');
      server.listen(endpoint);
      await ready;
      break;
    } catch (error) {
      if (error.code === 'EADDRINUSE' && waitMs === 0) return;
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
      await delay(50);
    }
  }
  try { return await action(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
