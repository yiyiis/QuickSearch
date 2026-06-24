/* src/history/history.js
 * 剪贴板历史记录页：列表 / 搜索 / 单条复制 / 删除 / 清空。
 */
(async function initHistory() {
  await AISA.i18n.init();
  AISA.i18n.applyToDOM();

  const storage = window.AISA.storage;
  const clipboard = window.AISA.clipboard;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const searchEl = document.getElementById('search');
  const toastEl = document.getElementById('toast');

  let allItems = [];

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), 1500);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      const pad = (n) => (n < 10 ? '0' + n : n);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  function render(filter) {
    const f = (filter || '').trim().toLowerCase();
    const items = f
      ? allItems.filter((i) => (i.text || '').toLowerCase().indexOf(f) !== -1)
      : allItems;

    listEl.innerHTML = '';
    if (!items.length) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    items.forEach((it) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML =
        '<div class="item-head">' +
          '<span class="item-meta">' + escapeHtml(fmtTime(it.time)) +
            (it.source ? ' · ' + escapeHtml(it.source) : '') +
            (it.url ? ' · ' + escapeHtml(it.url) : '') +
          '</span>' +
          '<span class="item-actions">' +
            AISA.i18n.t('<button class="small" data-act="copy">复制</button>') +
            AISA.i18n.t('<button class="small danger" data-act="del">删除</button>') +
          '</span>' +
        '</div>' +
        '<div class="item-text">' + escapeHtml(it.text) + '</div>';

      div.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const ok = await clipboard.copyText(it.text);
        toast(ok ? AISA.i18n.t('已复制') : AISA.i18n.t('复制失败'));
      });
      div.querySelector('[data-act="del"]').addEventListener('click', async () => {
        await storage.removeHistoryItem(it.id);
        await refresh();
      });
      listEl.appendChild(div);
    });
  }

  async function refresh() {
    allItems = await storage.getHistory();
    render(searchEl.value);
  }

  searchEl.addEventListener('input', () => render(searchEl.value));

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm(AISA.i18n.t('确定要清空全部历史记录吗？此操作不可恢复。'))) return;
    await storage.clearHistory();
    await refresh();
    toast(AISA.i18n.t('已清空'));
  });

  // 监听存储变化，实时刷新（在别的页面复制时）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.aisa_history) {
      refresh();
    }
  });

  refresh();
})();
