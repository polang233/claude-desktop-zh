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
  if (nativeFocus) document.querySelector('[role="tablist"]').setAttribute('focusgroup', 'tablist nomemory');
  function selectTab(tab) {
    tabs.forEach((item, index) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = nativeFocus ? 0 : selected ? 0 : -1;
      item.toggleAttribute('focusgroupstart', selected);
      if (selected) panels[index].removeAttribute('hidden'); else panels[index].setAttribute('hidden', 'until-found');
    });
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
      script.src = '.runtime-session.js';
      script.onload = connect;
      script.onerror = () => { status.textContent = '请关闭再启用插件，重新准备页面。'; };
      document.head.append(script);
    } else status.textContent = '请通过插件的工作台入口打开此页面，会话地址已失效。';
    return;
  }
  history.replaceState(null, '', location.pathname);
  const labels = { source: '应用位置', root: '独立副本', profile: '3p 数据', catalog: '语言资源', caches: '可用缓存' };
  const names = { check: '检查兼容性', install: '写入语言资源', detect: '检查网关', status: '刷新状态', plan: '查看计划', 'import-cache': '导入语言缓存', prepare: '创建测试副本', switch: '切换资源语言', launch: '启动测试副本', restore: '恢复原始资源' };
  const localeNames = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' };
  const select = document.getElementById('locale'), automatic = document.getElementById('runtime-auto');
  const autoState = document.getElementById('auto-state');
  const renderState = pending => { autoState.textContent = pending ? '正在保存…' : automatic.checked ? '已启用' : '已停用'; };
  const buttons = [...document.querySelectorAll('button[data-action]')];
  let busy = false;
  async function api(url, init) {
    const response = await fetch(url, { ...init, credentials: 'omit', cache: 'no-store', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '操作失败，请稍后重试。');
    return body;
  }
  function show(value) { log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  try {
    const state = await api('/api/state');
    const copyMode = state.paths.mode === 'copy';
    select.value = state.preferences.locale;
    automatic.checked = state.preferences.runtimeAutoLoad;
    let preferences = { ...state.preferences };
    renderState(false);
    document.getElementById('mode').textContent = copyMode ? '当前目标：独立测试副本。' : '检查现有 Claude 的资源和兼容性。';
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
    function enabled(value) {
      select.disabled = automatic.disabled = !value || !state.canSave;
      buttons.forEach(button => { button.disabled = !value || (button.dataset.write === 'true' && state.paths.allowWrites === false); });
    }
    enabled(true);
    status.textContent = state.canSave ? '' : '请从喜鹊插件入口打开页面后更改设置。';
    const savePreferences = async () => {
      if (busy || !state.canSave) return;
      busy = true; enabled(false); status.textContent = ''; renderState(true);
      const next = { locale: select.value, runtimeAutoLoad: automatic.checked };
      try {
        await api('/api/preferences', { method: 'POST', body: JSON.stringify(next) });
        preferences = next;
          } catch {
        select.value = preferences.locale; automatic.checked = preferences.runtimeAutoLoad;
        status.textContent = '保存失败，设置未更改。请重试。';
      } finally { busy = false; enabled(true); renderState(false); }
    };
    select.addEventListener('change', savePreferences);
    automatic.addEventListener('change', savePreferences);
    document.getElementById('preferences-form').addEventListener('submit', event => event.preventDefault());
    for (const button of buttons) {
      button.hidden = !!button.dataset.mode && button.dataset.mode !== (copyMode ? 'copy' : 'original');
      button.addEventListener('click', async () => {
        if (busy) return;
        const action = button.dataset.action, locale = select.value;
        const confirmed = button.dataset.write === 'true' || action === 'launch';
        const target = copyMode ? '独立测试副本' : '现有应用';
        if (confirmed && !window.confirm(`确认对${target}执行「${names[action]}」？\n所选语言：${localeNames[locale]}\n目标：${(copyMode ? state.paths.root : state.paths.source) || '自动检测（不明确时会停止）'}`)) return;
        busy = true; enabled(false); show(names[action] + '进行中…');
        try {
          const started = await api('/api/run', { method: 'POST', body: JSON.stringify({ action, confirm: confirmed ? action : '', locale }) });
          let job;
          do { await new Promise(resolve => setTimeout(resolve, 700)); job = await api('/api/jobs/' + started.id); } while (job.state === 'running');
          show(job.state === 'done' ? job.result : job.error);
        } catch (error) { show(error.message); }
        finally { busy = false; enabled(true); }
      });
    }
  } catch (error) { status.textContent = '无法连接插件：' + error.message; show('请关闭再启用插件，然后重新打开页面。'); }
})();
