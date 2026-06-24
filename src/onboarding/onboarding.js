/* src/onboarding/onboarding.js
 * 首次安装/更新后的使用指引页。
 */
(async function () {
  await AISA.i18n.init();
  AISA.i18n.applyToDOM();

  const langSelect = document.getElementById('onboarding-locale');
  if (langSelect) {
    langSelect.value = AISA.i18n.locale;
    langSelect.addEventListener('change', async () => {
      if (typeof AISA.storage !== 'undefined' && AISA.storage.saveSettings) {
        await AISA.storage.saveSettings({ locale: langSelect.value });
      }
      location.reload();
    });
  }

  const btn = document.getElementById('btn-open');

  // 页面初始化时【提前】拿到自身 tab/window id，缓存起来。
  // 点击按钮时绝不能再 await 任何东西——chrome.sidePanel.open() 必须在
  // 点击的同步调用栈里调用，否则用户手势上下文丢失 → open 失败。
  let myTabId = null;
  let myWindowId = null;
  (async function preload() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab) {
        myTabId = tab.id;
        myWindowId = tab.windowId;
        // 预先给 onboarding 这个 tab enable，使稍后 open 能生效（全局默认 disabled）。
        // 也配置好 side panel 行为：点工具栏图标即可开。
        if (chrome.sidePanel && chrome.sidePanel.setOptions) {
          try {
            chrome.sidePanel.setOptions({ tabId: myTabId, path: 'src/sidepanel/sidepanel.html', enabled: true });
          } catch (e) {}
        }
        if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
          try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
        }
      }
    } catch (e) {}
  })();

  btn.addEventListener('click', () => {
    // 关键：open() 必须同步调用，不能有前置 await。
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        // 优先用 tabId（per-tab 打开，与主路径一致）；无 tabId 则用 windowId。
        const opt = myTabId != null ? { tabId: myTabId } : (myWindowId != null ? { windowId: myWindowId } : {});
        chrome.sidePanel.open(opt).then(() => {
          btn.textContent = AISA.i18n.t('✓ 已打开，请看右侧');
        }).catch(() => {
          btn.textContent = AISA.i18n.t('自动打开失败，请点工具栏扩展图标或按 Alt+Q');
          btn.style.color = '#dc2626';
        });
      } else {
        btn.textContent = AISA.i18n.t('当前浏览器不支持，请用 Chrome 114+');
        btn.style.color = '#dc2626';
      }
    } catch (e) {
      btn.textContent = AISA.i18n.t('打开失败，请点工具栏扩展图标或按 Alt+Q');
      btn.style.color = '#dc2626';
    }
  });

  document.getElementById('btn-done').addEventListener('click', () => {
    // 关闭 onboarding 标签页
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id) chrome.tabs.remove(tab.id);
    });
  });
})();
