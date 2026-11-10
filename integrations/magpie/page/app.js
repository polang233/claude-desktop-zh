(async () => {
  await magpie.ready;
  const options = await magpie.options.get();
  const valid = value => ['zh-Hans', 'zh-Hant'].includes(value);
  const current = valid(options.locale) ? options.locale : 'zh-Hans';
  const select = document.getElementById('locale');
  const automatic = document.getElementById('runtime-auto');
  automatic.checked = options.runtimeAutoLoad !== false;
  select.value = current;
  document.getElementById('save').addEventListener('click', async () => {
    const locale = select.value;
    if (!valid(locale)) return;
    const save = document.getElementById('save'), status = document.getElementById('status');
    const enabled = automatic.checked;
    save.disabled = true;
    status.textContent = '正在保存…';
    try {
      await magpie.options.set({ ...options, locale, runtimeAutoLoad: enabled });
      options.locale = locale;
      options.runtimeAutoLoad = enabled;
      status.textContent = enabled ? '已保存，下次打开 Claude 时生效。' : '已保存，自动加载已关闭。';
    } catch {
      status.textContent = '保存失败，请稍后重试。';
    } finally { save.disabled = false; }
  });
})();
