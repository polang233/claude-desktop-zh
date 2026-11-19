import { createLocalizationSession } from './controller.mjs';
import { createWorkbench } from './workbench.mjs';
import { createRuntimeHost } from './runtime-host.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, assertPlainDirectory, sha256 } from '../../lib/common.mjs';
import { registrySnapshot } from './runtime-host.mjs';
import { preferenceStore, validatePreferences } from './preferences.mjs';

const UNIX_EPOCH_TICKS = 621355968000000000n;
const PROJECT_LINKS = {
  repository: 'https://github.com/polang233/claude-desktop-zh',
  author: 'https://github.com/polang233'
};

function openLink(destination) {
  const opener = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), 'url.dll,FileProtocolHandler']
    : process.platform === 'darwin' ? ['/usr/bin/open'] : ['xdg-open'];
  const [program, ...args] = opener;
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args, PROJECT_LINKS[destination]], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// Only plugin factories may be exported here: the host invokes every export.
export const ClaudeChinesePlugin = async (_input, options = {}) => {
  const store = preferenceStore(options, options.stateDirectory);
  const hosted = typeof _input?.directory === 'string' && path.isAbsolute(_input.directory);
  const owner = () => registrySnapshot(_input.directory, options);
  const binding = hosted ? owner() : null;
  const current = () => !hosted || (sha256(fs.readFileSync(binding.file)) === binding.hash && owner().hash === binding.hash);
  const session = await createLocalizationSession(options, hosted ? store : {
    snapshot: () => ({ value: validatePreferences({ locale: options.locale ?? 'zh-Hans', runtimeAutoLoad: options.runtimeAutoLoad !== false }) })
  }, (effective, controller, skipExisting) => createRuntimeHost(_input, { ...options, ...effective }, controller, {
    registrySnapshot: owner, ...(hosted ? { preferenceFile: store.file } : {}),
    skipClaudeStartedThrough: skipExisting ? (UNIX_EPOCH_TICKS + BigInt(Date.now()) * 10000n + 9999n).toString() : undefined
  }), () => { if (!current()) throw new Error('插件配置已更改，请重新打开页面。'); });
  let workbench, opening;
  async function opened() {
    if (!opening) {
      opening = (async () => {
        if (!workbench?.address()) {
          workbench = createWorkbench(options, undefined, session, {
            allowSandboxFrames: hosted,
            keepAlive: hosted,
            openLink: hosted ? openLink : undefined,
            current: hosted ? () => { try { session.checkCurrent(); return true; } catch { return false; } } : undefined,
            revision: session.revision, get: session.get, runtime: session.runtime, save: hosted ? session.save : undefined
          });
          await workbench.listen();
        }
        return { url: workbench.url(), note: 'Local buttons call the same CLI. Keep this session address private; it expires after 15 minutes without authenticated activity.' };
      })().finally(() => { opening = undefined; });
    }
    return opening;
  }
  if (hosted) {
    // This local capability file is excluded from both Git and npm artifacts.
    void opened().then(page => {
      owner();
      const folder = fileURLToPath(new URL('./page/', import.meta.url));
      assertPlainDirectory(folder);
      const file = path.join(folder, '.runtime-session.js');
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Unexpected UI session link.');
      atomicWrite(file, 'globalThis.claudeChineseSession=' + JSON.stringify(page.url) + ';\n');
    }).catch(() => { /* The status/maintenance tool can still open a fresh session. */ });
  }
  return {
    tool: {
      claude_zh_manage: {
        description: 'Inspect or manage Chinese language resources in the selected Claude installation. Ask the human before install/prepare/switch/restore/import-cache/launch, then pass the exact action as confirm. Optional locale selects Simplified or Traditional Chinese for this action. prepare explicitly creates an isolated copy. No shell commands accepted.',
        args: { type: 'object', properties: { action: { type: 'string', enum: ['check', 'install', 'discover', 'detect', 'status', 'plan', 'import-cache', 'prepare', 'switch', 'restore', 'launch'] }, confirm: { type: 'string' }, locale: { type: 'string', enum: ['zh-Hans', 'zh-Hant'] } }, required: ['action'], additionalProperties: false },
        execute: async ({ action, confirm, locale }) => JSON.stringify(await session.execute(action, confirm, { locale }), null, 2)
      },
      claude_zh_sync_status: {
        description: '查看 Claude 中文准备和加载状态。',
        args: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => JSON.stringify({ ...session.state(), automaticPolling: session.runtime().automaticNextLaunch, runtime: session.runtime() })
      },
      claude_zh_workbench: {
        description: '打开本机语言资源维护页面，返回本次会话地址。',
        args: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => JSON.stringify(await opened())
      }
    }
  };
};
