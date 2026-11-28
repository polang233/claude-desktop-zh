(async () => {
  // Keep magpie's page handshake alive after navigating to the local service.
  const embedded = globalThis.parent && globalThis.parent !== globalThis;
  if (embedded) {
    const parent = globalThis.parent;
    const paint = theme => {
      if (!theme || typeof theme.dark !== 'boolean') return;
      document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
      for (const [key, value] of Object.entries(theme.tokens ?? {})) document.documentElement.style.setProperty('--magpie-' + key, value);
    };
    globalThis.addEventListener('message', event => {
      if (event.source !== parent || event.data?.magpie !== 1) return;
      if (event.data.event === 'theme') paint(event.data.data);
      else if (event.data.id === 96001) paint(event.data.result);
    });
    parent.postMessage({ magpie: 1, id: 96001, method: 'hello' }, '*');
  }
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  const nativeFocus = Object.hasOwn(HTMLElement.prototype, 'focusGroup');
  let refreshMaintenance;
  if (nativeFocus) document.querySelector('[role="tablist"]').setAttribute('focusgroup', 'tablist nomemory');
  function selectTab(tab) {
    tabs.forEach((item, index) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = nativeFocus ? 0 : selected ? 0 : -1;
      item.toggleAttribute('focusgroupstart', selected);
      if (selected) panels[index].removeAttribute('hidden'); else panels[index].setAttribute('hidden', 'until-found');
    });
    if (tab === tabs[1]) return refreshMaintenance?.();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('focus', () => selectTab(tab));
    panels[index].addEventListener('beforematch', () => selectTab(tab));
    if (!nativeFocus) tab.addEventListener('keydown', event => {
      const keys = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (Object.hasOwn(keys, event.key)) { event.preventDefault(); tabs[keys[event.key]].focus(); }
    });
  });
  selectTab(tabs[0]);
  const status = document.getElementById('status'), log = document.getElementById('log');
  const retry = document.getElementById('retry-connection');
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('token');
  const reconnectMessage = '插件宿主已断开，正在重新连接…';
  const validToken = value => /^[a-f0-9]{64}$/.test(value || '');
  function parseURL(address) {
    try { return new URL(address); } catch {}
  }
  function magpiePage(address) {
    const url = parseURL(address);
    if (!url) return;
    const desktop = ['localhost', 'wails.localhost'].includes(url.hostname);
    const local = url.protocol === 'http:' && (desktop || url.hostname === '127.0.0.1');
    if (!local && !(url.protocol === 'wails:' && desktop && !url.port)) return;
    if (url.username || url.password || !/^\/_magpie\/plugin\/[a-f0-9]{32}\/index\.html$/.test(url.pathname)) return;
    url.search = '';
    url.hash = '';
    return url;
  }
  const sessionFile = '.runtime-session/current.js';
  async function connect(entry, readSession, previousToken) {
    retry.hidden = true;
    status.textContent = previousToken ? reconnectMessage : '正在连接插件…';
    for (let attempt = 0; attempt < 12; attempt++) {
      const url = parseURL(await readSession());
      if (url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/' &&
          !url.username && !url.password && !url.search) {
        const nextToken = new URLSearchParams(url.hash.slice(1)).get('token');
        if (validToken(nextToken) && nextToken !== previousToken) {
          const next = new URLSearchParams({ token: nextToken, frame: '1' });
          if (embedded) next.set('page', entry.href);
          if (previousToken) {
            // A replacement can reuse the port. Force a document navigation.
            url.search = '?reconnected=1';
            next.set('reconnected', '1');
          }
          url.hash = next;
          location.replace(url.href);
          return;
        }
      }
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    status.textContent = '暂时无法连接插件宿主。';
    retry.hidden = false;
  }
  if (!validToken(token)) {
    const entry = magpiePage(location.href);
    if (!entry) {
      status.textContent = '请从喜鹊打开插件页或工作台。';
      return;
    }
    function readSession() {
      return new Promise(resolve => {
        const script = document.createElement('script');
        delete globalThis.claudeChineseSession;
        script.src = sessionFile + '?t=' + Date.now();
        const timer = setTimeout(() => finish(), 2000);
        function finish(address) {
          clearTimeout(timer);
          script.remove();
          resolve(address);
        }
        script.onload = () => finish(globalThis.claudeChineseSession);
        script.onerror = () => finish();
        document.head.append(script);
      });
    }
    const start = () => connect(entry, readSession);
    retry.addEventListener('click', start);
    await start();
    return;
  }
  const entry = embedded && hash.get('frame') === '1' && magpiePage(hash.get('page'));
  let reconnecting = false, requestNumber = 0;
  function readSessionFromMagpie() {
    const url = new URL(sessionFile, entry);
    url.searchParams.set('t', Date.now());
    const id = 'claude-zh-session-' + ++requestNumber;
    return new Promise(resolve => {
      const timer = setTimeout(finish, 2000);
      function finish(address) {
        clearTimeout(timer);
        globalThis.removeEventListener('message', receive);
        resolve(address);
      }
      function receive(event) {
        if (event.source !== globalThis.parent || event.data?.magpie !== 1 || event.data.id !== id) return;
        const bytes = event.data.result?.data;
        const published = bytes instanceof ArrayBuffer && bytes.byteLength <= 1024
          ? /^globalThis\.claudeChineseSession="([^"\r\n]+)";\s*$/.exec(new TextDecoder().decode(bytes))?.[1] : undefined;
        finish(published);
      }
      globalThis.addEventListener('message', receive);
      globalThis.parent.postMessage({ magpie: 1, id, method: 'asset', params: { url: url.href } }, '*');
    });
  }
  // WebView2 cannot navigate back to the Wails asset host from this frame.
  const reconnect = () => connect(entry, readSessionFromMagpie, token);
  if (entry) retry.addEventListener('click', reconnect);
  function connectionLost() {
    if (!entry) return new Error('与插件的连接已中断，请重新打开工作台。');
    if (!reconnecting) {
      reconnecting = true;
      void reconnect();
    }
    return new Error(reconnectMessage);
  }
  history.replaceState(null, '', location.pathname);
  const labels = { source: '应用位置', root: '独立副本', profile: '3p 数据', catalog: '语言资源', caches: '可用缓存' };
  const names = { install: '写入语言资源', detect: '检查网关', status: '查看资源写入记录', plan: '查看计划', 'import-cache': '导入语言缓存', prepare: '创建测试副本', switch: '切换资源语言', launch: '启动测试副本', restore: '恢复原始资源',
    'third-party-apply': '应用中文补丁', 'third-party-restore': '恢复 Claude 原样' };
  const localeNames = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' };
  const select = document.getElementById('locale'), automatic = document.getElementById('runtime-auto');
  const autoState = document.getElementById('auto-state');
  const renderState = pending => { autoState.textContent = pending ? '正在保存…' : automatic.checked ? '已启用' : '已停用'; };
  const buttons = [...document.querySelectorAll('button[data-action]')];
  let busy = false, revision, stale = false;
  async function api(url, init) {
    if (reconnecting) throw new Error(reconnectMessage);
    let response, body;
    try {
      const signal = url === '/api/runtime' ? globalThis.AbortSignal?.timeout?.(5000) : undefined;
      response = await fetch(url, { ...init, signal, credentials: 'omit', cache: 'no-store', redirect: 'error', headers: {
        authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(revision && init?.method === 'POST' ? { 'if-match': revision } : {})
      } });
      body = await response.json();
    } catch { throw connectionLost(); }
    if (response.status === 401 || (response.status === 503 && url === '/api/runtime')) throw connectionLost();
    if (!response.ok) {
      if (entry && body.code === 'session-retired') throw connectionLost();
      if (response.status === 409 && /重新打开/.test(body.error)) stale = true;
      throw new Error(body.error || '操作失败，请稍后重试。');
    }
    return body;
  }
  function show(value) { log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  if (embedded) {
    const linkStatus = document.getElementById('project-link-status');
    let opening = false;
    for (const destination of ['repository', 'author']) {
      const link = document.getElementById(destination + '-link');
      link.addEventListener('click', async event => {
        event.preventDefault();
        if (opening) return;
        opening = true;
        linkStatus.textContent = '';
        try { await api('/api/open-link/' + destination, { method: 'POST' }); }
        catch { linkStatus.textContent = '无法打开浏览器，可复制此地址：' + link.href; }
        finally { opening = false; }
      });
    }
  }
  try {
    const state = await api('/api/state');
    const version = document.getElementById('plugin-version');
    version.textContent = '版本 ' + state.version;
    version.hidden = false;
    const copyMode = state.paths.mode === 'copy';
    revision = state.revision;
    const el = id => document.getElementById(id);
    const method = el('method');
    const methodNames = { runtime: '启动时加载', 'in-place': '写入安装资源', 'third-party': '内置补丁' };
    const refresh = el('refresh-maintenance'), runtimeStatus = el('runtime-status'), resourceStatus = el('resource-status'), patchStatus = el('patch-status');
    const stage = el('live-stage'), dialog = el('confirm-action');
    let preferences = { method: 'runtime', ...state.preferences };
    let resources = 'unknown', transaction = {}, thirdParty = {}, source = state.paths.source, runtime, phase;
    let checking, polling = false, operation = '';
    const runtimeLabels = {
      'not-started': '等待准备', preparing: '正在准备语言包', rebuilding: '正在重建语言包',
      starting: '正在启动监听', watching: '已就绪，等待启动 Claude', disabled: '已停用启动时加载',
      'waiting-for-normal-exit': '等待 Claude 正常退出',
      'source-unverified': '暂时无法确认 Claude 的安装版本，将自动重试',
      'preparation-failed': '语言包准备失败', 'watcher-start-failed': '监听启动失败',
      'unsupported-host': '当前环境不支持自动加载', 'owner-changed': '插件配置已更改，请重新打开页面',
      stopping: '正在停止监听', stopped: '监听已停止'
    };
    const resourceLabels = {
      protected: 'MSIX 安装受系统保护，不可改写。请使用启动时加载。',
      unsupported: '当前安装不支持写入安装资源。此方式需要兼容且可写的 Windows 解包版。',
      eligible: '当前安装支持写入资源。写入前请通过「文件 → 退出」关闭 Claude。',
      disabled: '喜鹊配置已禁用资源写入。', copy: '独立测试副本可在资源维护中管理。',
      busy: '其他操作进行中，稍后会重新检查。', unknown: '暂时无法确认安装资源。可在资源维护中刷新状态。'
    };
    const phases = { check: '正在检查应用', detect: '正在检查网关', plan: '正在检查语言资源',
      'import-cache': '正在导入语言缓存', install: '正在备份并应用语言资源', restore: '正在恢复原始资源',
      'third-party-apply': '正在应用内置中文补丁', 'third-party-restore': '正在恢复 Claude 原样' };
    const clean = () => ['restored', 'not-installed'].includes(transaction.status);
    const recoverable = () => ['installed', 'preparing', 'applying'].includes(transaction.status);
    function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
    function runtimeLabel() {
      if (runtime?.progress === 'loading') return '正在加载中文，请保持 Claude 在前台。';
      if (runtime?.state === 'watching' && runtime.lastResult) return runtime.lastResult === 'Applied'
        ? '上次启动已加载中文' : '上次加载未成功（' + runtime.lastResult + '），请正常退出后重试。';
      return runtime?.message || runtimeLabels[runtime?.state] || '等待获取运行时状态';
    }
    function transactionLabel() {
      if (transaction.status === 'installed' && transaction.intact) return '已写入' + (localeNames[transaction.locale] || '中文') + '。';
      if (transaction.status === 'restored') return '已恢复原始资源。';
      if (recoverable()) return '资源写入记录需要恢复。请先恢复原始资源，再检查结果。';
      if (resources !== 'eligible') return '未写入语言资源。';
      if (transaction.status === 'not-installed') return '尚未应用。请手动点击「写入所选语言」。';
      return '等待确认资源写入记录。';
    }
    function patchLabel() {
      if (thirdParty.status === 'installed') {
        const language = localeNames[thirdParty.locale] || '中文';
        return '已应用' + language + '补丁。' + (thirdParty.backupDirectory ? '可使用下方的恢复按钮还原。' : '未找到恢复备份，不能自动还原。');
      }
      if (thirdParty.status === 'incomplete') return '补丁状态不完整。请尝试恢复原样，或重新应用补丁并检查日志。';
      if (thirdParty.status === 'restored') return '已恢复 Claude 原样。';
      if (thirdParty.status === 'unsupported') return thirdParty.reason || '当前平台不支持内置补丁。';
      if (thirdParty.status === 'unavailable') return thirdParty.reason || '未找到可用的 Claude 安装。';
      if (thirdParty.bundle?.verified === false) return thirdParty.bundle.reason || '内置补丁文件不可用。';
      return '尚未应用内置补丁。应用时需要管理员授权，完成后 Claude 会自动打开。';
    }
    function render() {
      const runtimeMethod = preferences.method === 'runtime';
      const inplace = preferences.method === 'in-place';
      const builtIn = preferences.method === 'third-party';
      const locked = busy || stale || reconnecting;
      method.value = preferences.method;
      el('method-row').hidden = copyMode;
      el('auto-row').hidden = !runtimeMethod;
      el('resource-actions').hidden = copyMode || (!inplace && !recoverable());
      el('third-party-actions').hidden = copyMode || !builtIn;
      method.disabled = select.disabled = locked || !state.canSave;
      automatic.disabled = method.disabled || !runtimeMethod || (recoverable() && !preferences.runtimeAutoLoad);
      const info = resourceLabels[resources] || resourceLabels.unknown;
      const runtimeNote = recoverable() ? '请先恢复已写入的资源，再启用启动时加载。' :
        '启用后保持喜鹊运行，从原入口启动 Claude 时加载所选语言。';
      setText(el('method-note'), builtIn ? patchLabel() : inplace || copyMode ? info : runtimeNote);
      setText(resourceStatus, info);
      setText(patchStatus, patchLabel());
      setText(runtimeStatus, runtimeLabel());
      setText(stage, reconnecting ? '插件宿主已断开' : stale ? '页面设置已过期，请重新打开插件页。' :
        operation ? (phases[phase] || operation) : builtIn ? patchLabel() : inplace ? transactionLabel() : runtimeLabel());
      refresh.disabled = locked || !!checking;
      for (const button of buttons) {
        const action = button.dataset.action;
        button.hidden = !!button.dataset.mode && button.dataset.mode !== (copyMode ? 'copy' : 'original');
        let disabled = locked || (button.dataset.write === 'true' && state.paths.allowWrites === false);
        if (!copyMode && ['install','restore','switch'].includes(action)) {
          if (action === 'restore') disabled ||= !state.canSave || !recoverable();
          else {
            button.hidden ||= !inplace;
            disabled ||= !state.canSave || !inplace || resources !== 'eligible' ||
              !(clean() || (transaction.status === 'installed' && transaction.intact));
          }
        }
        if (!copyMode && ['third-party-apply','third-party-restore'].includes(action)) {
          button.hidden ||= !builtIn;
          disabled ||= !state.canSave || !thirdParty.supported;
          if (action === 'third-party-apply') disabled ||= !thirdParty.canApply || thirdParty.status === 'applying';
          else disabled ||= !thirdParty.canRestore || thirdParty.status === 'restoring';
        }
        button.disabled = disabled;
      }
    }
    function reflectPreferences() {
      select.value = preferences.locale;
      automatic.checked = preferences.runtimeAutoLoad;
      renderState(false);
      render();
    }
    refreshMaintenance = () => {
      if (checking || stale || reconnecting) return checking;
      refresh.disabled = true;
      checking = api('/api/maintenance').then(result => {
        resources = result.resources; transaction = result.transaction || {};
        thirdParty = result.thirdParty || {};
        source = result.source || state.paths.source;
        runtime = result.runtime;
      }).catch(error => { resources = 'unknown'; transaction = {}; if (!reconnecting) status.textContent = error.message; })
        .finally(() => { checking = undefined; render(); });
      return checking;
    };
    async function poll() {
      if (document.hidden || polling || checking || reconnecting) return;
      polling = true;
      const requested = revision;
      try {
        const next = await api('/api/runtime');
        if (requested !== revision) return;
        if (!busy && next.revision && next.revision !== revision) stale = true;
        runtime = next.runtime; phase = next.phase; render();
        if (resources === 'busy' && !busy && !phase) await refreshMaintenance();
      } catch (error) { runtime = undefined; render(); if (!reconnecting) status.textContent = error.message; }
      finally { polling = false; }
    }
    refresh.addEventListener('click', refreshMaintenance);
    const list = document.createElement('dl');
    for (const [key, label] of Object.entries(labels)) {
      if (!copyMode && key === 'root') continue;
      const term = document.createElement('dt'), value = document.createElement('dd');
      term.textContent = label;
      const raw = state.paths[key];
      value.textContent = Array.isArray(raw) ? (raw.join('\n') || '未找到') : (raw || '未找到');
      list.append(term, value);
    }
    document.getElementById('paths').append(list);
    reflectPreferences();
    status.textContent = !state.canSave ? '请从喜鹊插件入口打开页面后更改设置。' :
      hash.get('reconnected') === '1' ? '已重新连接。请核对当前设置后再操作。' : '';
    const canChange = () => !busy && !stale && !reconnecting && state.canSave && !dialog.open;
    const savePreferences = async (next, confirmMethod) => {
      if (!canChange()) return;
      busy = true; operation = '正在保存汉化设置…'; status.textContent = ''; renderState(true); render();
      try {
        const { revision: savedRevision, ...saved } = await api('/api/preferences', {
          method: 'POST', body: JSON.stringify({ ...next, confirmMethod })
        });
        preferences = saved; revision = savedRevision;
        await refreshMaintenance();
      } catch (error) { if (!reconnecting) status.textContent = '保存失败。' + error.message; }
      finally { busy = false; operation = ''; phase = undefined; reflectPreferences(); }
    };
    select.addEventListener('change', () => savePreferences({ ...preferences, locale: select.value }));
    automatic.addEventListener('change', () => savePreferences({ ...preferences, runtimeAutoLoad: automatic.checked }));
    method.addEventListener('change', async () => {
      const selected = method.value;
      method.value = preferences.method;
      if (!canChange() || selected === preferences.method || !Object.hasOwn(methodNames, selected)) return;
      const nextStep = selected === 'runtime' ? '切换后需手动开启「启动时自动中文」。' :
        selected === 'in-place' ? '切换后可检查安装是否兼容。兼容时，点击「写入所选语言」并确认才会应用。' :
          '切换后可点击「应用中文补丁」。应用会修改 Claude 程序文件、请求管理员授权，并可能使程序签名失效。';
      if (await confirmAction('切换到「' + methodNames[selected] + '」？', '本次只保存方式，自动加载将停用。' + nextStep)) {
        await savePreferences({ ...preferences, method: selected, runtimeAutoLoad: false }, selected);
      }
    });
    el('preferences-form').addEventListener('submit', event => event.preventDefault());
    let confirmChoice;
    function confirmAction(title, details) {
      el('confirm-title').textContent = title;
      el('confirm-details').textContent = details;
      dialog.showModal();
      return new Promise(resolve => {
        confirmChoice = resolve;
      });
    }
    function resolveConfirmation(confirmed) {
      const resolve = confirmChoice;
      confirmChoice = undefined;
      resolve?.(confirmed);
    }
    dialog.addEventListener('cancel', () => resolveConfirmation(false));
    dialog.addEventListener('close', () => {
      // A queued close from the last prompt can arrive after the next one opens.
      if (!dialog.open) resolveConfirmation(false);
    });
    el('confirm-cancel').addEventListener('click', () => { resolveConfirmation(false); dialog.close(); });
    el('confirm-accept').addEventListener('click', () => { resolveConfirmation(true); dialog.close(); });
    async function follow(job) {
      operation = (names[job.action] || '操作') + '进行中…'; render(); show(operation);
      while (job.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 500));
        job = await api('/api/jobs/' + job.id);
      }
      const result = job.state === 'done' ? job.result : job.error;
      show(result);
      if (!copyMode && ['install','restore','switch'].includes(job.action)) {
        status.textContent = job.state === 'failed' ? '操作失败。' + job.error :
          job.action === 'restore' && job.result?.status === 'installed' ? '已取消上次准备。请再次恢复原始资源。' : '';
      }
      if (job.action?.startsWith('third-party-')) {
        status.textContent = job.state === 'failed' ? '补丁操作失败。' + job.error :
          job.action === 'third-party-apply' ? '补丁已应用。请检查 Claude 是否已自动打开。' : 'Claude 已恢复原样。';
      }
    }
    for (const button of buttons) {
      button.addEventListener('click', async () => {
        if (busy || stale || reconnecting || button.disabled || dialog.open) return;
        const action = button.dataset.action, locale = select.value;
        const confirmed = button.dataset.write === 'true' || action === 'launch';
        const target = copyMode ? state.paths.root : action === 'restore' ? transaction.source :
          action.startsWith('third-party-') ? thirdParty.source || source : source;
        const thirdPartyDetail = action === 'third-party-apply'
          ? '\n将修改 Claude 程序文件并请求管理员授权；应用前必须完全退出 Claude。\n如安装目录受系统保护，插件会请求接管写入权限；恢复时不会自动还原目录权限。'
          : action === 'third-party-restore'
            ? '\n将从内置补丁的备份恢复 Claude 程序文件，并请求管理员授权；恢复前必须完全退出 Claude。' : '';
        const languageDetail = ['restore', 'third-party-restore'].includes(action) ? '' : '\n所选语言：' + localeNames[locale];
        if (confirmed && !await confirmAction('确认' + names[action], '目标：' + (target || '自动检测') +
          (action === 'restore' ? '\n将从原位备份恢复资源。' : '') + languageDetail +
          (!copyMode && action === 'install' ? '\n将备份原始文件并写入安装目录。' : '') + thirdPartyDetail)) return;
        busy = true; operation = names[action] + '进行中…'; status.textContent = ''; render(); show(operation);
        try {
          const started = await api('/api/run', { method: 'POST', body: JSON.stringify({ action, confirm: confirmed ? action : '', locale,
            ...(!copyMode && action === 'install' && source ? { expectedSource: source } : {}) }) });
          await follow({ ...started, action });
        } catch (error) { if (!reconnecting) status.textContent = error.message; show(error.message); }
        finally {
          if (!copyMode) await refreshMaintenance();
          busy = false; phase = undefined; operation = ''; render();
        }
      });
    }
    if (!copyMode) await refreshMaintenance();
    const timer = globalThis.setInterval?.(poll, 1200);
    globalThis.addEventListener?.('pagehide', () => globalThis.clearInterval?.(timer), { once: true });
    const pending = state.jobs?.find(job => job.state === 'running');
    if (pending) {
      busy = true;
      try { await follow(pending); }
      finally { busy = false; operation = ''; await refreshMaintenance(); }
    }
  } catch (error) {
    if (!reconnecting) {
      status.textContent = '无法连接插件：' + error.message;
      show('请从喜鹊重新打开插件页。');
    }
  }
})();
