/* src/options/options.js
 * 高级设置页：保存所有设置 + 站点管理（增删/排序）+ 站点级 overrides。
 */
(function () {
  const storage = window.AISA.storage;

  const DEFAULT_SITES = [
    { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', icon: '../../assets/site-icons/chatgpt.png' },
    { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', icon: '../../assets/site-icons/claude.png' },
    { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', icon: '../../assets/site-icons/gemini.png' },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', icon: '../../assets/site-icons/deepseek.png' },
    { id: 'tongyi', name: AISA.i18n.t('通义千问'), url: 'https://tongyi.aliyun.com/qianwen/', icon: '../../assets/site-icons/tongyi.png' },
    { id: 'kimi', name: 'Kimi', url: 'https://kimi.moonshot.cn/', icon: '../../assets/site-icons/kimi.png' },
    { id: 'glm', name: AISA.i18n.t('智谱清言'), url: 'https://chatglm.cn/main/alltoolsdetail', icon: '../../assets/site-icons/glm.png' },
    { id: 'yiyan', name: AISA.i18n.t('文心一言'), url: 'https://yiyan.baidu.com/', icon: '../../assets/site-icons/yiyan.png' }
  ];

  let settings = null;
  let sites = null;
  let prompts = [];

  // 编辑站点时暂存置顶态（edit 是「删后重加」模式，需手动带回 pinned）
  let editingPinned = null;   // { pinned }

  // 纵向拖拽状态
  let dragSrcId = null;
  let suppressClick = false;

  const $ = (id) => document.getElementById(id);

  let saveTimeout = null;
  function scheduleSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const overrides = {};
        const lines = $('opt-overrides').value.split(/\r?\n/);
        lines.forEach((line) => {
          line = line.trim();
          if (!line) return;
          const m = line.match(/^([+-])\s*(.+)$/);
          if (m) {
            overrides[m[2].trim()] = { superCopy: m[1] === '+' };
          } else {
            overrides[line] = { superCopy: true };
          }
        });

        const patch = {
          locale: $('opt-locale').value,
          copyFormat: $('opt-copyFormat').value,
          autoCopyFormat: $('opt-autoCopyFormat').value,
          minChars: Math.max(1, parseInt($('opt-minChars').value, 10) || 1),
          historyLimit: Math.max(10, parseInt($('opt-historyLimit').value, 10) || 100),
          superCopy: $('opt-superCopy').checked,
          autoCopy: $('opt-autoCopy').checked,
          showFloatBtn: $('opt-showFloatBtn').checked,
          showLauncher: $('opt-showLauncher').checked,
          siteOverrides: overrides
        };

        await storage.saveSettings(patch);
        await storage.saveSites(sites);
        await storage.savePrompts(prompts);
        chrome.runtime.sendMessage({ type: 'AISA_SETTINGS_CHANGED' }).catch(() => {});
        status(AISA.i18n.t('自动保存成功'), false, 2000);
      } catch (e) {
        status(AISA.i18n.t('自动保存失败: ') + e.message, true);
      }
    }, 500);
  }

  function status(msg, isErr, duration = 3000) {
    const el = $('status');
    el.textContent = msg || '';
    el.style.color = isErr ? '#dc2626' : '#059669';
    if (msg) {
      setTimeout(() => { 
        if (el.textContent === msg) el.textContent = AISA.i18n.t('已开启自动保存'); 
      }, duration);
    }
  }

  // ---------- 加载 ----------
  async function load() {
    await AISA.i18n.init();
    AISA.i18n.applyToDOM();
    settings = await storage.getSettings();
    sites = (await storage.getSites()) || DEFAULT_SITES.map((s) => Object.assign({}, s));

    $('opt-locale').value = settings.locale || 'zh';
    $('opt-copyFormat').value = settings.copyFormat || '';
    $('opt-autoCopyFormat').value = settings.autoCopyFormat || '';
    $('opt-minChars').value = settings.minChars || 1;
    $('opt-historyLimit').value = settings.historyLimit || 100;
    $('opt-superCopy').checked = !!settings.superCopy;
    $('opt-autoCopy').checked = !!settings.autoCopy;
    $('opt-showFloatBtn').checked = !!settings.showFloatBtn;
    $('opt-showLauncher').checked = settings.showLauncher !== false;

    prompts = (await storage.getPrompts()) || [];

    renderSites();
    renderPrompts();
    renderOverrides();
    
    ['opt-copyFormat', 'opt-autoCopyFormat', 'opt-minChars', 'opt-historyLimit'].forEach(id => $(id).addEventListener('input', scheduleSave));
    $('opt-locale').addEventListener('change', async () => {
      try {
        const patch = { locale: $('opt-locale').value };
        await storage.saveSettings(patch);
        location.reload();
      } catch (e) {}
    });
    ['opt-superCopy', 'opt-autoCopy', 'opt-showFloatBtn', 'opt-showLauncher'].forEach(id => $(id).addEventListener('change', scheduleSave));
    $('opt-overrides').addEventListener('input', scheduleSave);

    // 检查是否有侧边栏传来的“快捷存为模板”文本
    chrome.storage.local.get(['aisa_temp_prompt'], (data) => {
      if (data.aisa_temp_prompt) {
        $('prompt-content').value = data.aisa_temp_prompt;
        $('prompt-trigger').focus();
        chrome.storage.local.remove('aisa_temp_prompt');
      }
    });

    // 跨页同步：站点列表被其他页面（侧边栏/悬浮窗）改动时，重新加载并刷新列表。
    // 自身的 scheduleSave 也会触发本回调，但内容一致，rerender 幂等无副作用。
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.aisa_sites) return;
      const next = changes.aisa_sites.newValue;
      if (Array.isArray(next)) {
        sites = next;
        renderSites();
      }
    });
  }

  function renderSites() {
    const list = $('sites-list');
    list.innerHTML = '';
    // 渲染前统一排序：仅按区域分组（置顶区在前、非置顶区在后），组内保留拖拽顺序
    sites = storage.sortSites(sites);
    // 找到各区域的边界索引，用于禁用跨区的 ▲▼
    const firstOther = sites.findIndex((s) => !s.pinned); // 第一个非置顶

    sites.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'site-row' + (s.pinned ? ' is-pinned' : '');
      row.dataset.id = s.id;
      row.draggable = true; // 纵向拖拽（置顶区/非置顶区各自内部可拖，跨区被拒绝）
      let iconHtml = '';
      // 图标路径归一化：兼容 'assets/..'（background 默认值，无 ../）与 '../../assets/..'（本页默认值）。
      // 统一用 getURL 转绝对路径，避免 storage 里混存格式时相对路径解析失败导致裂图。
      const iconSrc = s.icon && /^https?:\/\//.test(s.icon) ? s.icon
        : (s.icon && /(?:^|\/)assets\//.test(s.icon) ? chrome.runtime.getURL(s.icon.replace(/^(\.\.\/)+/, '')) : '');
      if (iconSrc) {
        iconHtml = `<img src="${iconSrc}" class="site-icon-img" alt="${escapeHtml(s.name)}" style="width:16px;height:16px;vertical-align:middle;border-radius:2px;object-fit:contain;" onerror="this.src='${chrome.runtime.getURL('assets/icons/icon-16.png')}'">`;
      } else {
        iconHtml = escapeHtml(s.icon || '•');
      }

      const pinBtn = s.pinned
        ? '<button data-act="pin" class="active" title="' + AISA.i18n.t('取消置顶') + '">📌</button>'
        : '<button data-act="pin" title="' + AISA.i18n.t('置顶') + '">📍</button>';

      row.innerHTML =
        '<span class="drag-handle" title="' + AISA.i18n.t('拖拽排序') + '">⠿</span>' +
        '<span class="ico">' + iconHtml + '</span>' +
        '<span class="name">' + escapeHtml(s.name || '') + '</span>' +
        '<span class="url">' + escapeHtml(s.url || '') + '</span>' +
        pinBtn +
        '<button data-act="up" title="' + AISA.i18n.t('上移') + '">▲</button>' +
        '<button data-act="down" title="' + AISA.i18n.t('下移') + '">▼</button>' +
        '<button data-act="edit" title="' + AISA.i18n.t('编辑') + '">✎</button>' +
        '<button data-act="del" title="' + AISA.i18n.t('删除') + '">✕</button>';

      // ▲▼ 边界禁用：区域内首个不可上移，区域内末个不可下移
      const isPinned = !!s.pinned;
      const atZoneTop = isPinned ? idx === 0 : idx === firstOther;
      const atZoneBottom = isPinned ? idx === firstOther - 1 : idx === sites.length - 1;
      if (atZoneTop) row.querySelector('[data-act="up"]').disabled = true;
      if (atZoneBottom) row.querySelector('[data-act="down"]').disabled = true;

      row.querySelector('[data-act="pin"]').addEventListener('click', () => {
        sites = storage.togglePin(sites, s.id);
        renderSites();
        scheduleSave();
      });
      row.querySelector('[data-act="up"]').addEventListener('click', () => {
        if (atZoneTop) return;
        // 上移 = 放到前一项之前（after=false）
        sites = storage.reorderSite(sites, s.id, sites[idx - 1].id, false);
        renderSites();
        scheduleSave();
      });
      row.querySelector('[data-act="down"]').addEventListener('click', () => {
        if (atZoneBottom) return;
        // 下移 = 放到后一项之后（after=true）
        sites = storage.reorderSite(sites, s.id, sites[idx + 1].id, true);
        renderSites();
        scheduleSave();
      });
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        $('site-name').value = s.name || '';
        $('site-url').value = s.url || '';
        $('site-icon').value = s.icon || '';
        // 暂存置顶态 + 优先级，re-add 时带回（edit 是「删后重加」，否则会丢这些字段）
        editingPinned = { pinned: !!s.pinned, order: s.order, pinnedOrder: s.pinnedOrder };
        sites.splice(idx, 1);
        renderSites();
        scheduleSave();
        $('site-name').focus();
      });
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        sites.splice(idx, 1);
        renderSites();
        scheduleSave();
      });

      bindRowDragHandlers(row, list);
      list.appendChild(row);
    });
  }

  // ---------- 纵向拖拽（置顶区/非置顶区各自内部可拖，跨区被拒绝） ----------
  function bindRowDragHandlers(row, list) {
    row.addEventListener('dragstart', (e) => {
      dragSrcId = row.dataset.id;
      row.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.id); } catch (_) {}
    });
    row.addEventListener('dragover', (e) => {
      if (!dragSrcId || row.dataset.id === dragSrcId) return;
      // 区域隔离校验
      const src = sites.find((s) => s.id === dragSrcId);
      const dst = sites.find((s) => s.id === row.dataset.id);
      if (!src || !dst || !!src.pinned !== !!dst.pinned) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      row.classList.toggle('drag-over-top', !after);
      row.classList.toggle('drag-over-bottom', after);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!dragSrcId || row.dataset.id === dragSrcId) { dragSrcId = null; return; }
      const src = sites.find((s) => s.id === dragSrcId);
      const dst = sites.find((s) => s.id === row.dataset.id);
      if (!src || !dst || !!src.pinned !== !!dst.pinned) { dragSrcId = null; return; }
      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      reorderOptionsSites(dragSrcId, row.dataset.id, after);
      dragSrcId = null;
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      Array.from(list.querySelectorAll('.drag-over-top,.drag-over-bottom')).forEach((el) =>
        el.classList.remove('drag-over-top', 'drag-over-bottom')
      );
      suppressClick = true;
      dragSrcId = null;
    });
  }

  // 纵向重排：fromId 移到 toId 上/下方。区域隔离由 storage.reorderSite 校验。
  function reorderOptionsSites(fromId, toId, after) {
    sites = storage.reorderSite(sites, fromId, toId, after);
    renderSites();
    scheduleSave();
  }

  function renderOverrides() {
    const ov = settings.siteOverrides || {};
    const lines = Object.keys(ov)
      .map((k) => (ov[k].superCopy !== false ? '+' : '-') + k);
    $('opt-overrides').value = lines.join('\n');
  }

  $('btn-site-add').addEventListener('click', () => {
    const name = $('site-name').value.trim();
    const url = $('site-url').value.trim();
    const icon = $('site-icon').value.trim();
    if (!name || !url) {
      status(AISA.i18n.t('请填写名称和 URL'), true);
      return;
    }
    // 编辑模式：保留原 order/pinnedOrder（仅改名/网址/图标）；新增模式：用 addSite 分配 order。
    const pin = editingPinned || { pinned: false };
    if (editingPinned && typeof editingPinned.order === 'number') {
      // 编辑重加：保留原优先级
      sites.push({
        id: 'custom_' + Date.now(),
        name,
        url,
        icon: icon || '🔗',
        pinned: !!pin.pinned,
        order: pin.order,
        pinnedOrder: pin.pinnedOrder
      });
    } else {
      sites = storage.addSite(sites, {
        id: 'custom_' + Date.now(),
        name,
        url,
        icon: icon || '🔗'
      });
      // 新增项若要求置顶，用 togglePin 放置顶区末尾
      if (pin.pinned && sites.length) {
        sites = storage.togglePin(sites, sites[sites.length - 1].id);
      }
    }
    editingPinned = null;
    $('site-name').value = '';
    $('site-url').value = '';
    $('site-icon').value = '';
    renderSites();
    scheduleSave();
  });

  $('btn-site-reset').addEventListener('click', () => {
    if (!confirm(AISA.i18n.t('恢复为默认站点列表？当前自定义将丢失。'))) return;
    sites = DEFAULT_SITES.map((s) => Object.assign({}, s));
    renderSites();
    scheduleSave();
  });

  // ---------- 数据备份：导出 / 导入 ----------
  $('btn-export').addEventListener('click', async () => {
    try {
      const payload = await storage.exportAll();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `aisa-backup-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      status(AISA.i18n.t('已导出备份文件'), false, 2500);
    } catch (e) {
      status(AISA.i18n.t('导出失败: ') + e.message, true);
    }
  });

  $('btn-import').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ''; // 允许重复选同一文件
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!confirm(AISA.i18n.t('导入将覆盖当前所有设置、提示词与历史，确定继续？'))) return;
      await storage.importAll(payload);
      status(AISA.i18n.t('导入成功，正在刷新…'), false, 1500);
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      status(AISA.i18n.t('导入失败: ') + e.message, true);
    }
  });

  // ---------- 提示词模板 ----------
  function renderPrompts() {
    const list = $('prompts-list');
    list.innerHTML = '';
    prompts.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'site-row';
      row.innerHTML =
        '<span class="name" style="width: 80px; color: #4338ca; font-family: monospace;">/' + escapeHtml(p.trigger || '') + '</span>' +
        '<span class="url" style="flex: 1; color: #475569;">' + escapeHtml((p.content || '').substring(0, 30)) + '...</span>' +
        '<button data-act="up" title="' + AISA.i18n.t('上移') + '">▲</button>' +
        '<button data-act="down" title="' + AISA.i18n.t('下移') + '">▼</button>' +
        '<button data-act="edit" title="' + AISA.i18n.t('编辑') + '">✎</button>' +
        '<button data-act="del" title="' + AISA.i18n.t('删除') + '">✕</button>';
      
      if (idx === 0) row.querySelector('[data-act="up"]').disabled = true;
      if (idx === prompts.length - 1) row.querySelector('[data-act="down"]').disabled = true;

      row.querySelector('[data-act="up"]').addEventListener('click', () => {
        if (idx === 0) return;
        [prompts[idx - 1], prompts[idx]] = [prompts[idx], prompts[idx - 1]];
        renderPrompts();
        scheduleSave();
      });
      row.querySelector('[data-act="down"]').addEventListener('click', () => {
        if (idx === prompts.length - 1) return;
        [prompts[idx + 1], prompts[idx]] = [prompts[idx], prompts[idx + 1]];
        renderPrompts();
        scheduleSave();
      });
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        $('prompt-trigger').value = p.trigger || '';
        $('prompt-content').value = p.content || '';
        prompts.splice(idx, 1);
        renderPrompts();
        scheduleSave();
        $('prompt-trigger').focus();
      });
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        prompts.splice(idx, 1);
        renderPrompts();
        scheduleSave();
      });
      list.appendChild(row);
    });
  }

  $('btn-prompt-add').addEventListener('click', () => {
    const trigger = $('prompt-trigger').value.trim();
    const content = $('prompt-content').value.trim();
    if (!trigger || !content) {
      status(AISA.i18n.t('标志和内容不能为空'), true);
      return;
    }
    if (prompts.find((p) => p.trigger === trigger)) {
      status(AISA.i18n.t('标志已存在'), true);
      return;
    }
    prompts.push({ trigger, content });
    $('prompt-trigger').value = '';
    $('prompt-content').value = '';
    renderPrompts();
    scheduleSave();
  });

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  load();
})();
