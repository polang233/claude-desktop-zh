import { createController } from './controller.mjs';
import { createWorkbench } from './workbench.mjs';
import { createRuntimeHost } from './runtime-host.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, assertPlainDirectory, sha256 } from '../../lib/common.mjs';
import { registrySnapshot } from './runtime-host.mjs';
import { preferenceStore } from './preferences.mjs';

// Only plugin factories may be exported here: the host invokes every export.
export const ClaudeChinesePlugin = async (_input, options = {}) => {
  const store = preferenceStore(options, options.stateDirectory);
  const hosted = typeof _input?.directory === 'string' && path.isAbsolute(_input.directory);
  let preferences = hosted ? store.read() : { locale: options.locale ?? 'zh-Hans', runtimeAutoLoad: options.runtimeAutoLoad !== false };
  let currentController = createController({ ...options, ...preferences });
  const controller = new Proxy({}, { get: (_target, key) => {
    const value = currentController[key]; return typeof value === 'function' ? value.bind(currentController) : value;
  } });
  const owner = () => registrySnapshot(_input.directory, options);
  const makeRuntime = () => createRuntimeHost(_input, { ...options, ...preferences }, controller, { registrySnapshot: owner });
  let runtime = makeRuntime();
  void runtime.start();
  let workbench, opening;
  async function opened() {
    if (!opening) {
      opening = (async () => {
        if (!workbench?.address()) {
          const binding = hosted ? owner() : null;
          workbench = createWorkbench(options, undefined, controller, {
            allowSandboxFrames: hosted,
            keepAlive: hosted,
            current: hosted ? () => {
              try { return sha256(fs.readFileSync(binding.file)) === binding.hash && owner().hash === binding.hash; }
              catch { return false; }
            } : undefined,
            get: () => ({ ...preferences }),
            save: hosted ? async value => {
              const snapshot = owner();
              await runtime.stopped();
              if (sha256(fs.readFileSync(snapshot.file)) !== snapshot.hash) throw new Error('Plugin options changed. Reopen the page.');
              try { preferences = store.write(value); }
              catch (error) { runtime = makeRuntime(); void runtime.start(); throw error; }
              currentController = createController({ ...options, ...preferences });
              runtime = makeRuntime();
              void runtime.start();
              return { ...preferences };
            } : undefined
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
        execute: async ({ action, confirm, locale }) => JSON.stringify(await controller.execute(action, confirm, { locale }), null, 2)
      },
      claude_zh_sync_status: {
        description: '查看 Claude 中文准备和加载状态。',
        args: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => JSON.stringify({ ...controller.state(), automaticPolling: runtime.state().automaticNextLaunch, runtime: runtime.state() })
      },
      claude_zh_workbench: {
        description: '打开本机语言资源维护页面，返回本次会话地址。',
        args: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => JSON.stringify(await opened())
      }
    }
  };
};
