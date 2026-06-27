/* src/content/content.js
 * content script 主入口：
 *  - 根据站点设置启用/关闭超级复制
 *  - 监听选区 → 自动复制 + 浮动按钮
 *  - 响应设置变更消息
 */
(function () {
  // 避免重复注入（同页多次注入，例如 SPA 路由切换）
  if (window.__AISA_CONTENT_INIT__) return;
  window.__AISA_CONTENT_INIT__ = true;

  const AISA = window.AISA;
  const api = AISA.content;
  const storage = AISA.storage;

  let currentSettings = null;

  // 取生效设置：全局 + 站点覆盖
  function hostname() {
    try { return location.hostname; } catch (e) { return ''; }
  }

  async function refreshSettings() {
    // 扩展被重新加载后，旧 content script 的 chrome.runtime 失效，storage 调用会抛错
    if (!api.runtimeAlive()) return;
    try {
      const s = await storage.getEffectiveSettings(hostname());
      currentSettings = s;
      if (s && s.locale && window.AISA && window.AISA.i18n) {
        window.AISA.i18n.locale = s.locale;
      }
      applySuperCopy();
      applyLauncher();
    } catch (e) {
      // context invalidated 等异常，静默放弃
    }
  }

  function applySuperCopy() {
    if (!currentSettings) return;
    if (currentSettings.superCopy) api.enableSuperCopy();
    else api.disableSuperCopy();
  }

  function applyLauncher() {
    if (!currentSettings) return;
    // showLauncher 默认 true（未定义时也显示）
    const show = currentSettings.showLauncher !== false;
    if (show) api.showLauncher();
    else api.hideLauncher();
  }

  // ---------- 选区监听 ----------
  let selTimer = null;
  function onSelectionChange() {
    clearTimeout(selTimer);
    selTimer = setTimeout(handleSelection, 200);
  }

  function handleSelection() {
    if (!currentSettings) return;
    // 扩展重载后旧页面 context 失效：选区仍可复制到剪贴板（本地能力），但不触发消息/历史
    const alive = api.runtimeAlive();
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    const target = sel && sel.anchorNode ? sel.anchorNode.parentElement : null;

    // 在输入框内选择不触发自动复制/浮动按钮
    if (api.isEditableTarget(target) || api.isEditableTarget(document.activeElement)) {
      api.hideFloatBtn();
      return;
    }

    if (!text || text.length < (currentSettings.minChars || 1)) {
      api.hideFloatBtn();
      return;
    }

    // 自动复制
    if (currentSettings.autoCopy) {
      // alive 为 false 时仍尝试复制（剪贴板是页面本地能力），但跳过历史写入
      if (alive) {
        api.autoCopySelection(currentSettings);
      }
    }

    // 浮动按钮
    if (currentSettings.showFloatBtn) {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        api.showFloatBtnAt(rect);
      }
    } else {
      api.hideFloatBtn();
    }
  }

  document.addEventListener('selectionchange', onSelectionChange, false);
  document.addEventListener('mouseup', () => setTimeout(handleSelection, 10), false);
  document.addEventListener('keyup', (e) => {
    // Shift+方向键选择后也响应
    if (e.shiftKey) setTimeout(handleSelection, 10);
  }, false);

  // 滚动/点击其他地方时隐藏浮动按钮
  window.addEventListener('scroll', () => api.hideFloatBtn(), true);
  document.addEventListener('mousedown', (e) => {
    if (e.target && e.target.id !== 'aisa-float-btn') {
      // 不立即隐藏，留给 mouseup 重新评估
    }
  }, false);

  // ---------- 接收设置变更 / 数据请求 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'AISA_SETTINGS_CHANGED') {
      currentSettings = Object.assign({}, currentSettings || {}, msg.settings || {});
      if (msg.settings && msg.settings.locale && window.AISA && window.AISA.i18n) {
        window.AISA.i18n.locale = msg.settings.locale;
      }
      refreshSettings();
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'AISA_GET_SETTINGS_FROM_CONTENT') {
      sendResponse({ settings: currentSettings });
    } else if (msg && msg.type === 'AISA_GET_SELECTION') {
      // 当前选中文本
      const extract = window.AISA && window.AISA.extract;
      const text = extract ? extract.extractSelection() : (window.getSelection() ? window.getSelection().toString() : '');
      sendResponse({ text: text || '' });
    } else if (msg && msg.type === 'AISA_GET_PAGE_DATA') {
      // 当前页面正文 + 元信息
      const extract = window.AISA && window.AISA.extract;
      if (extract) {
        try {
          const data = extract.extractPage(msg.maxLength || 12000);
          sendResponse({ ok: true, data: data });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
      } else {
        sendResponse({ ok: false, error: 'extractor not ready' });
      }
    } else if (msg && msg.type === 'AISA_GET_TAB_TEXT') {
      // 本标签页的标题 + URL + 正文摘要（供"其他标签页"引用）
      const extract = window.AISA && window.AISA.extract;
      let summary = '';
      try {
        const d = extract ? extract.extractPage(1500) : null;
        summary = d ? d.content : '';
      } catch (e) {}
      sendResponse({
        ok: true,
        title: document.title || '',
        url: location.href,
        summary: summary
      });
    }
    return true;
  });

  // ---------- 启动 ----------
  // 暴露当前 settings 给 content 库（悬浮球面板需读取 superCopy 等状态）
  api.getSettings = () => currentSettings;
  // 乐观更新本地 settings 缓存：面板里点开关后立即写入，避免异步广播回来前 renderTab 重渲读到旧值
  // 导致「点了没反应、下次才变」的延迟感。
  api.updateSettingsCache = (patch) => {
    currentSettings = Object.assign({}, currentSettings || {}, patch || {});
  };
  refreshSettings();
})();
