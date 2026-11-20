(async () => {
  // Keep magpie's page handshake alive after navigating to the local service.
  if (globalThis.parent && globalThis.parent !== globalThis) {
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
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('token');
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    function connect() {
      try {
        const url = new URL(globalThis.claudeChineseSession);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(new URLSearchParams(url.hash.slice(1)).get('token') || '')) throw Error();
        url.hash += '&frame=1'; location.replace(url.href);
      } catch { status.textContent = '连接已失效，请关闭再启用插件。'; }
    }
    if (globalThis.claudeChineseSession) { connect(); return; }
    if (location.hostname === 'wails.localhost' || location.hostname === 'localhost' || location.protocol === 'wails:') {
      const script = document.createElement('script');
      script.src = '.runtime-session/current.js';
      script.onload = connect;
      script.onerror = () => { status.textContent = '请关闭再启用插件，重新准备页面。'; };
      document.head.append(script);
    } else status.textContent = '请通过插件的工作台入口打开此页面，会话地址已失效。';
    return;
  }
  history.replaceState(null, '', location.pathname);
  const labels = { source: '应用位置', root: '独立副本', profile: '3p 数据', catalog: '语言资源', caches: '可用缓存' };
  const names = { install: '写入语言资源', detect: '检查网关', status: '查看资源写入记录', plan: '查看计划', 'import-cache': '导入语言缓存', prepare: '创建测试副本', switch: '切换资源语言', launch: '启动测试副本', restore: '恢复原始资源' };
  const localeNames = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' };
  const select = document.getElementById('locale'), automatic = document.getElementById('runtime-auto');
  const autoState = document.getElementById('auto-state');
  const renderState = pending => { autoState.textContent = pending ? '正在保存…' : automatic.checked ? '已启用' : '已停用'; };
  const buttons = [...document.querySelectorAll('button[data-action]')];
  let busy = false, revision, stale = false;
  async function api(url, init) {
    const response = await fetch(url, { ...init, credentials: 'omit', cache: 'no-store', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(revision && init?.method === 'POST' ? { 'if-match': revision } : {}) } });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409 && /重新打开/.test(body.error)) stale = true;
      throw new Error(body.error || '操作失败，请稍后重试。');
    }
    return body;
  }
  function show(value) { log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  if (globalThis.parent && globalThis.parent !== globalThis) {
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
    const method = el('method'), inPlaceOption = el('in-place-option');
    const refresh = el('refresh-maintenance'), runtimeStatus = el('runtime-status'), resourceStatus = el('resource-status');
    const stage = el('live-stage'), dialog = el('confirm-action');
    let preferences = { method: 'runtime', ...state.preferences };
    let resources = 'unknown', transaction = {}, source = state.paths.source, runtime, phase;
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
      unsupported: '当前安装不支持原位应用。此方式需要可写的 Windows 解包版。',
      eligible: '当前安装支持原位应用，写入前请通过「文件 → 退出」关闭 Claude。',
      disabled: '喜鹊配置已禁用资源写入。', copy: '独立测试副本可在资源维护中管理。',
      busy: '其他操作进行中，稍后会重新检查。', unknown: '暂时无法确认安装资源。可在资源维护中刷新状态。'
    };
    const phases = { check: '正在检查应用', detect: '正在检查网关', plan: '正在检查语言资源',
      'import-cache': '正在导入语言缓存', install: '正在备份并应用语言资源', restore: '正在恢复原始资源' };
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
      if (transaction.status === 'installed' && transaction.intact) return '已原位应用' + (localeNames[transaction.locale] || '中文') + '。';
      if (transaction.status === 'restored') return '已恢复原始资源。可切回启动时加载。';
      if (transaction.status === 'not-installed') return '尚未应用。确认后将备份并写入所选语言。';
      if (recoverable()) return '资源写入记录需要恢复。请先恢复原始资源，再检查结果。';
      return '等待确认资源写入记录。';
    }
    function render() {
      const inplace = preferences.method === 'in-place';
      const locked = busy || stale;
      method.value = preferences.method;
      el('method-row').hidden = copyMode;
      el('auto-row').hidden = inplace;
      el('resource-actions').hidden = !inplace || copyMode;
      method.disabled = select.disabled = automatic.disabled = locked || !state.canSave;
      inPlaceOption.disabled = resources !== 'eligible' || state.paths.allowWrites === false;
      const info = resourceLabels[resources] || resourceLabels.unknown;
      setText(el('method-note'), inplace ? '原位应用会保留到恢复或应用更新。更改语言后需再次确认应用。' + (resources === 'eligible' ? '' : info) :
        (copyMode ? info : '保持喜鹊运行，从原入口启动 Claude 时加载所选语言。' + (resources === 'eligible' ? '' : info)));
      setText(resourceStatus, info);
      setText(runtimeStatus, runtimeLabel());
      setText(stage, stale ? '页面设置已过期，请重新打开插件页。' : operation ? (phases[phase] || operation) : inplace ? transactionLabel() : runtimeLabel());
      refresh.disabled = locked || !!checking;
      for (const button of buttons) {
        const action = button.dataset.action;
        button.hidden = !!button.dataset.mode && button.dataset.mode !== (copyMode ? 'copy' : 'original');
        let disabled = locked || (button.dataset.write === 'true' && state.paths.allowWrites === false);
        if (!copyMode && ['install','restore','switch'].includes(action)) {
          disabled ||= !state.canSave || !inplace || (action === 'restore' ? !recoverable() :
            resources !== 'eligible' || !(clean() || (transaction.status === 'installed' && transaction.intact)));
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
      if (checking || stale) return checking;
      refresh.disabled = true;
      checking = api('/api/maintenance').then(result => {
        resources = result.resources; transaction = result.transaction || {};
        source = result.source || state.paths.source;
        runtime = result.runtime;
      }).catch(error => { resources = 'unknown'; transaction = {}; status.textContent = error.message; })
        .finally(() => { checking = undefined; render(); });
      return checking;
    };
    async function poll() {
      if (document.hidden || polling || checking || stale) return;
      polling = true;
      const requested = revision;
      try {
        const next = await api('/api/runtime');
        if (requested !== revision) return;
        if (!busy && next.revision && next.revision !== revision) stale = true;
        runtime = next.runtime; phase = next.phase; render();
        if (resources === 'busy' && !busy && !phase) await refreshMaintenance();
      } catch (error) { runtime = undefined; render(); status.textContent = error.message; }
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
    status.textContent = state.canSave ? '' : '请从喜鹊插件入口打开页面后更改设置。';
    const savePreferences = async () => {
      if (busy || stale || !state.canSave) return;
      const next = { locale: select.value, runtimeAutoLoad: automatic.checked, method: method.value };
      busy = true; operation = '正在保存汉化设置…'; status.textContent = ''; renderState(true); render();
      try {
        const saved = await api('/api/preferences', { method: 'POST', body: JSON.stringify(next) });
        preferences = next; revision = saved.revision;
        await refreshMaintenance();
      } catch (error) { status.textContent = '保存失败。' + error.message; }
      finally { busy = false; operation = ''; phase = undefined; reflectPreferences(); }
    };
    select.addEventListener('change', savePreferences);
    automatic.addEventListener('change', savePreferences);
    method.addEventListener('change', savePreferences);
    el('preferences-form').addEventListener('submit', event => event.preventDefault());
    function confirmAction(title, details) {
      el('confirm-title').textContent = title;
      el('confirm-details').textContent = details;
      dialog.returnValue = '';
      return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
      });
    }
    el('confirm-cancel').addEventListener('click', () => dialog.close('cancel'));
    el('confirm-accept').addEventListener('click', () => dialog.close('confirm'));
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
    }
    for (const button of buttons) {
      button.addEventListener('click', async () => {
        if (busy || stale || button.disabled || dialog.open) return;
        const action = button.dataset.action, locale = select.value;
        const confirmed = button.dataset.write === 'true' || action === 'launch';
        const target = copyMode ? state.paths.root : action === 'restore' ? transaction.source : source;
        if (confirmed && !await confirmAction('确认' + names[action], '目标：' + (target || '自动检测') +
          (action === 'restore' ? '\n将从原位备份恢复资源。' : '\n所选语言：' + localeNames[locale]) +
          (!copyMode && action === 'install' ? '\n将备份原始文件并写入安装目录。' : ''))) return;
        busy = true; operation = names[action] + '进行中…'; status.textContent = ''; render(); show(operation);
        try {
          const started = await api('/api/run', { method: 'POST', body: JSON.stringify({ action, confirm: confirmed ? action : '', locale,
            ...(!copyMode && action === 'install' && source ? { expectedSource: source } : {}) }) });
          await follow({ ...started, action });
        } catch (error) { status.textContent = error.message; show(error.message); }
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
  } catch (error) { status.textContent = '无法连接插件：' + error.message; show('请关闭再启用插件，然后重新打开页面。'); }
})();
