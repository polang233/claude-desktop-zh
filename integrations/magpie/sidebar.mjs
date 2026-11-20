import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { assertPlainDirectory, atomicWrite } from '../../lib/common.mjs';
import { withRuntimeLock } from '../../lib/runtime-lock.mjs';

// Magpie watches path-installed plugin files, but skips hidden directories.
const sessionDirectory = '.runtime-session';
const prefix = 'globalThis.claudeChineseSession=';

// Prove the peer still owns this particular session without sending its bearer
// token to a loopback port that may have been reassigned.
export function sessionProof(token, nonce) {
  return createHmac('sha256', token).update('sidebar:' + nonce).digest('hex');
}

function readPublication(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024) throw new Error('Unexpected sidebar session file.');
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function publicationHealth(bytes) {
  const match = /^globalThis\.claudeChineseSession="http:\/\/127\.0\.0\.1:(\d{1,5})\/#token=([a-f0-9]{64})";\s*$/.exec(bytes || '');
  if (!match || Number(match[1]) > 65535) return 'invalid';
  const nonce = randomBytes(24).toString('hex');
  try {
    const reply = await fetch('http://127.0.0.1:' + match[1] + '/sidebar-session/' + nonce,
      { redirect: 'error', signal: AbortSignal.timeout(2000) });
    await reply.body?.cancel();
    if (reply.status >= 500) return 'unknown';
    return reply.status === 204 && reply.headers.get('x-claude-zh-proof') === sessionProof(match[2], nonce)
      ? 'live' : 'invalid';
  } catch (error) {
    const code = error.cause?.code ?? error.code;
    return code === 'ECONNREFUSED' || code === 'ConnectionRefused' ? 'invalid' : 'unknown';
  }
}

export function publishSidebar(folder, workbench, current) {
  const directory = path.join(folder, sessionDirectory);
  const file = path.join(directory, 'current.js');
  const publication = prefix + JSON.stringify(workbench.url()) + ';\n';
  let timer, stopped = false, status = 'pending';
  async function reconcile() {
    if (stopped || !workbench.address()) return;
    if (!current()) { status = 'retired'; return; }
    try {
      assertPlainDirectory(directory);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const before = readPublication(file);
      if (before === publication) status = 'published';
      else {
        // Timeouts and temporary server errors do not establish that a live
        // owner has exited. Keep its entry and probe again on the next tick.
        const health = await publicationHealth(before);
        if (health === 'live') { status = 'standby'; return; }
        if (health === 'unknown') { status = 'checking'; return; }
        await withRuntimeLock(folder, () => {
          // Another host can win while we probe. Never replace its fresh URL.
          if (stopped || !workbench.address() || !current() || readPublication(file) !== before) return;
          atomicWrite(file, publication);
          status = 'published';
        });
      }
    } catch { status = 'publication-failed'; }
    finally {
      if (!stopped) {
        timer = setTimeout(reconcile, 2000);
        timer.unref();
      }
    }
  }
  return {
    ready: reconcile(),
    state: () => status,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await withRuntimeLock(folder, () => {
        assertPlainDirectory(directory);
        if (readPublication(file) === publication) fs.unlinkSync(file);
      }).catch(() => {});
    }
  };
}
