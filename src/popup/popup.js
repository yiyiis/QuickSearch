/* src/popup/popup.js
 * 工具栏弹窗：开关设置 + 站点独立设置 + 快捷操作。
 * 通过 chrome.runtime.sendMessage 与 background 通信。
 */

const SETTINGS_KEY = 'aisa_settings';

function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'AISA_GET_SETTINGS' }, (resp) => {
      resolve(resp && resp.settings ? resp.settings : null);
    });
  });
}
function saveSettings(patch) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'AISA_SAVE_SETTINGS', patch: patch }, (resp) => {
      resolve(resp && resp.settings ? resp.settings : null);
    });
  });
}

function notify(title, message) {
  chrome.runtime.sendMessage({ type: 'AISA_NOTIFY', title: title, message: message });
}

// 获取当前 tab 的 host
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

let currentSettings = null;
let currentHost = '';

async function init() {
  await AISA.i18n.init();
  AISA.i18n.applyToDOM();

  const langSelect = document.getElementById('popup-locale');
  if (langSelect) {
    langSelect.value = AISA.i18n.locale;
    langSelect.addEventListener('change', async () => {
      await saveSettings({ locale: langSelect.value });
      location.reload();
    });
  }

  currentSettings = await getSettings();
  if (!currentSettings) return;

  // 开关回显
  document.getElementById('set-supercopy').checked = !!currentSettings.superCopy;
  document.getElementById('set-autocopy').checked = !!currentSettings.autoCopy;
  document.getElementById('set-floatbtn').checked = !!currentSettings.showFloatBtn;
  document.getElementById('set-launcher').checked = currentSettings.showLauncher !== false;

  // 当前站点
  const tab = await getCurrentTab();
  currentHost = hostOf(tab && tab.url);
  document.getElementById('cur-host').textContent = currentHost || AISA.i18n.t('（非网页）');
  updateSiteStatus();
}

function updateSiteStatus() {
  const el = document.getElementById('site-status');
  if (!currentHost) {
    el.textContent = '';
    document.getElementById('btn-toggle-site').style.display = 'none';
    return;
  }
  const overrides = (currentSettings && currentSettings.siteOverrides) || {};
  const ov = overrides[currentHost];
  if (ov && typeof ov.superCopy === 'boolean') {
    el.textContent = ov.superCopy ? AISA.i18n.t('已强制本站开启') : AISA.i18n.t('已强制本站关闭');
  } else {
    el.textContent = AISA.i18n.t('本站跟随全局设置');
  }
}

// ---------- 开关事件 ----------
document.getElementById('set-supercopy').addEventListener('change', async (e) => {
  currentSettings = await saveSettings({ superCopy: e.target.checked });
  notify(AISA.i18n.t('AI 侧边栏助手'), e.target.checked ? AISA.i18n.t('已开启超级复制') : AISA.i18n.t('超级复制已关闭'));
});
document.getElementById('set-autocopy').addEventListener('change', async (e) => {
  currentSettings = await saveSettings({ autoCopy: e.target.checked });
});
document.getElementById('set-floatbtn').addEventListener('change', async (e) => {
  currentSettings = await saveSettings({ showFloatBtn: e.target.checked });
});
document.getElementById('set-launcher').addEventListener('change', async (e) => {
  currentSettings = await saveSettings({ showLauncher: e.target.checked });
});

// ---------- 站点独立设置（循环：跟随全局 → 强制开 → 强制关 → 跟随全局）----------
document.getElementById('btn-toggle-site').addEventListener('click', async () => {
  if (!currentHost) return;
  const overrides = Object.assign({}, (currentSettings && currentSettings.siteOverrides) || {});
  const cur = overrides[currentHost];
  const curState = cur && typeof cur.superCopy === 'boolean' ? cur.superCopy : null;

  let nextLabel;
  if (curState === null) {
    // 跟随全局 → 强制开
    overrides[currentHost] = Object.assign({}, cur || {}, { superCopy: true });
    nextLabel = AISA.i18n.t('本站已强制开启超级复制');
  } else if (curState === true) {
    // 强制开 → 强制关
    overrides[currentHost] = Object.assign({}, cur || {}, { superCopy: false });
    nextLabel = AISA.i18n.t('本站已强制关闭超级复制');
  } else {
    // 强制关 → 跟随全局（删除该键）
    delete overrides[currentHost];
    nextLabel = AISA.i18n.t('本站已恢复跟随全局');
  }
  currentSettings = await saveSettings({ siteOverrides: overrides });
  updateSiteStatus();
  notify(AISA.i18n.t('AI 侧边栏助手'), nextLabel);
});

// ---------- 快捷操作 ----------
document.getElementById('btn-open-panel').addEventListener('click', async () => {
  const tab = await getCurrentTab();
  try {
    await chrome.runtime.sendMessage({ type: 'AISA_OPEN_PANEL', windowId: tab && tab.windowId });
  } catch (e) {}
  // 直接调用 sidePanel.open（popup 上下文可用）
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {}
  window.close();
});

document.getElementById('btn-copy-tab').addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (tab) {
    chrome.runtime.sendMessage({ type: 'AISA_COPY_TAB' });
    window.close();
  }
});

document.getElementById('btn-copy-all').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  // 复用 background 的 copyAllTabs：通过命令触发不便，直接发消息
  // background 暂未暴露 copyAllTabs 消息，这里发送命令名
  chrome.runtime.sendMessage({ type: 'AISA_COPY_ALL_TABS', tabs: tabs });
  window.close();
});

document.getElementById('btn-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') });
  window.close();
});

document.getElementById('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

init();
