/* src/content/lib.js
 * 共享逻辑（content.js 调用）：
 *  - 超级复制破解（解除禁止复制/右键/选择/粘贴）
 *  - 选中文字自动复制
 *  - 浮动"发到侧边栏"按钮
 *  - 简易 toast
 *  - 把引用发给 sidepanel（经 background 转发）
 *
 * 依赖：lib-init.js（提供 window.AISA）、lib/clipboard.js（AISA.clipboard）、
 *       lib/storage.js（AISA.storage）
 */
(function () {
  const AISA = window.AISA = window.AISA || {};

  // ==================== toast ====================
  let toastEl = null;
  let toastTimer = null;
  function toast(msg, duration) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'aisa-toast';
      toastEl.className = 'hidden';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), duration || 2000);
  }

  // ==================== 浮动按钮（选中后出现）====================
  let floatBtn = null;
  function ensureFloatBtn() {
    if (floatBtn) return floatBtn;
    floatBtn = document.createElement('div');
    floatBtn.id = 'aisa-float-bar';
    floatBtn.className = 'hidden';
    floatBtn.innerHTML =
      '<button class="aisa-fb-btn" data-act="quote">📌 发到侧边栏</button>' +
      '<button class="aisa-fb-btn alt" data-act="compose">➕ 加到组装</button>';
    floatBtn.addEventListener('mousedown', (e) => {
      // 阻止按钮点击导致选区丢失
      e.preventDefault();
    });
    floatBtn.querySelectorAll('.aisa-fb-btn').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = currentSelectionText();
        if (!text) { hideFloatBtn(); return; }
        const act = b.getAttribute('data-act');
        if (act === 'quote') {
          sendQuote(text);
          toast('已发送到侧边栏（同时已复制，可按 Ctrl+V 粘贴）', 3000);
        } else if (act === 'compose') {
          safeSendMessage({ type: 'AISA_ADD_TO_COMPOSER', text: text, source: document.title || '' });
          toast('已加到提示词组装', 2000);
        }
        hideFloatBtn();
      });
    });
    document.documentElement.appendChild(floatBtn);
    return floatBtn;
  }

  function showFloatBtnAt(rect) {
    const btn = ensureFloatBtn();
    const top = window.scrollY + (rect.top != null ? rect.top : 0) - 36;
    const left = window.scrollX + (rect.left != null ? rect.left : 0) + (rect.width || 0) / 2 - 90;
    btn.style.top = Math.max(8, top) + 'px';
    btn.style.left = Math.max(8, left) + 'px';
    btn.classList.remove('hidden');
  }
  function hideFloatBtn() {
    if (floatBtn) floatBtn.classList.add('hidden');
  }

  // ==================== 选区 ====================
  function currentSelectionText(asFormat) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
    if (asFormat === 'markdown' && window.AISA.clipboard) {
      const range = sel.getRangeAt(0);
      const frag = range.cloneContents();
      const div = document.createElement('div');
      div.appendChild(frag);
      return window.AISA.clipboard.htmlToMarkdown(div.innerHTML);
    }
    return sel.toString();
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName && el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
  }

  // ==================== 安全消息发送 ====================
  // 扩展开发期重新加载扩展后，旧 content script 残留页面上的 chrome.runtime
  // 会失效，抛 "Extension context invalidated"。
  // 此处统一兜底：context 失效时静默返回，不向用户暴露错误。
  function runtimeAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function safeSendMessage(msg) {
    if (!runtimeAlive()) return Promise.resolve(undefined);
    try {
      const p = chrome.runtime.sendMessage(msg);
      // Promise 形式（MV3）；补充 catch 防止接收端关闭连接抛 reject
      if (p && typeof p.then === 'function') {
        return p.catch(() => undefined);
      }
      return Promise.resolve(p);
    } catch (e) {
      // 同步抛出（context invalidated 等）
      return Promise.resolve(undefined);
    }
  }

  // ==================== 发送引用给 sidepanel ====================
  function sendQuote(text, source) {
    const src = source || document.title || '';
    // 经 background 转发；同时 sidepanel 若已打开会通过 chrome.runtime.onMessage 收到
    safeSendMessage({
      type: 'AISA_QUOTE',
      text: text,
      source: src
    });
  }

  // ==================== 页面常驻悬浮启动器 ====================
  let launcher = null;
  let launcherTip = null;
  let launcherHidden = false; // 用户点了×临时隐藏当前页

  function ensureLauncher() {
    if (launcher) return launcher;
    launcher = document.createElement('div');
    launcher.id = 'aisa-launcher';
    launcher.title = 'AI 侧边栏助手（点击打开，可拖动）';
    launcher.innerHTML =
      '<span class="pulse"></span>' +
      '<img src="' + chrome.runtime.getURL('assets/icons/icon-32.png') + '" style="width:24px;height:24px;border-radius:6px;vertical-align:middle;box-shadow:0 2px 4px rgba(0,0,0,0.1);">' +
      '<span class="close-x" title="在本页隐藏">×</span>';
    document.documentElement.appendChild(launcher);

    // 提示气泡（首次出现时显示几秒）
    launcherTip = document.createElement('div');
    launcherTip.id = 'aisa-launcher-tip';
    launcherTip.textContent = '点我打开 AI 侧边栏 →';
    document.documentElement.appendChild(launcherTip);

    bindLauncherEvents(launcher);
    // 首次出现：3 秒后淡出脉冲提示
    setTimeout(() => {
      const pulse = launcher.querySelector('.pulse');
      if (pulse) pulse.style.display = 'none';
      showLauncherTip(true);
      setTimeout(() => showLauncherTip(false), 4000);
    }, 3000);
    return launcher;
  }

  function showLauncherTip(show) {
    if (!launcherTip) return;
    if (show && launcher && !launcher.classList.contains('hidden')) {
      // 与 launcher 同高对齐
      launcherTip.classList.remove('hidden');
      // 触发重排再加 show 以启用 transition
      void launcherTip.offsetWidth;
      launcherTip.classList.add('show');
    } else {
      launcherTip.classList.remove('show');
    }
  }

  function showLauncher() {
    if (launcherHidden) return; // 用户在本页隐藏了
    ensureLauncher();
    launcher.classList.remove('hidden');
  }
  function hideLauncher() {
    if (launcher) launcher.classList.add('hidden');
    if (launcherTip) launcherTip.classList.add('hidden');
    hideLauncherMenu();
  }

  function bindLauncherEvents(el) {
    let pressed = false;     // 鼠标按下中
    let dragMoved = false;   // 本次按下是否发生过拖动
    let downTargetIsClose = false;
    let startX = 0, startY = 0;
    let offsetX = 0, offsetY = 0;
    const size = 44;

    el.addEventListener('mousedown', (e) => {
      // 点的是关闭按钮，交给它自己处理
      downTargetIsClose = e.target.classList.contains('close-x');
      if (downTargetIsClose) return;
      // 彻底重置本次交互状态（避免上次残留导致点击失效）
      pressed = true;
      dragMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      // 注意：不调 e.preventDefault()——在 mousedown 上 preventDefault 会抑制该元素获焦，
      // 在某些情况下（尤其侧边栏打开后焦点不在网页）会导致首次 click 不派发，表现为"第一次点击失效"。
      // 文本选中改用 CSS user-select:none 阻止（已在 #aisa-launcher 样式里设置）。
    });

    document.addEventListener('mousemove', (e) => {
      if (!pressed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) {
        dragMoved = true;
        el.classList.add('dragging');
      }
      if (dragMoved) {
        // 改用 left/top 定位（脱离初始 right）
        let x = e.clientX - offsetX;
        let y = e.clientY - offsetY;
        // 限制在视口内
        x = Math.max(4, Math.min(window.innerWidth - size - 4, x));
        y = Math.max(4, Math.min(window.innerHeight - size - 4, y));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        // 提示气泡跟随
        if (launcherTip) {
          launcherTip.style.left = 'auto';
          launcherTip.style.right = 'auto';
          launcherTip.style.top = y + 'px';
          launcherTip.style.left = (x - 140) + 'px';
        }
      }
    });

    // 用 mouseup 判定点击（mousedown→mouseup 必然成对，比 click 更可靠；
    // click 在「侧边栏打开后首次点击夺回焦点」时可能被浏览器吞掉）。
    document.addEventListener('mouseup', (e) => {
      if (!pressed) return;
      pressed = false;
      el.classList.remove('dragging');
      if (dragMoved) { dragMoved = false; return; } // 拖动收尾，忽略
      if (downTargetIsClose) return;                // 点的关闭按钮，忽略
      toggleLauncherMenu();
    });

    // 关闭按钮：隐藏当前页启动器（仅本页）
    el.querySelector('.close-x').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      launcherHidden = true;
      hideLauncher();
      toast('已在本页隐藏，刷新页面恢复', 2000);
    });
  }

  function openSidePanelFromContent() {
    // content script 无法直接开侧边栏，通知 background 处理。
    // background 端用 sender.tab.id 走 open({tabId}) 路径打开（与“发到侧边栏”同一机制）。
    safeSendMessage({ type: 'AISA_OPEN_PANEL_FROM_FLOAT' });
    toast('正在打开 AI 侧边栏…', 1500);
  }

  // ==================== 悬浮球展开式面板（全功能控制台）====================
  let launcherMenu = null;
  let launcherMenuAwayHandler = null;
  let activeTab = 'actions'; // actions | settings | history | sites | prompts
  let storageChangeBound = false;
  // 历史/站点/提示词的本地编辑草稿状态（切 tab 时不丢）
  let historyFilter = '';
  let siteEditId = null;   // 正在编辑的站点 id（null=新增）
  let promptEditIdx = null; // 正在编辑的提示词索引（null=新增）
  let siteDragSrcId = null; // 站点列表纵向拖拽：被拖站点 id

  function ensureLauncherMenu() {
    if (launcherMenu) return launcherMenu;
    launcherMenu = document.createElement('div');
    launcherMenu.id = 'aisa-launcher-menu';
    launcherMenu.className = 'hidden';
    document.documentElement.appendChild(launcherMenu);
    return launcherMenu;
  }

  // 根据 launcher 当前位置，把面板定位到球左侧（垂直居中对齐球），空间不足回退右侧；
  // 并把 top 钳制在视口内，保证面板（最高 90vh）始终完整可见、不覆盖页面顶部/底部。
  function positionLauncherMenu() {
    if (!launcher || !launcherMenu) return;
    const rect = launcher.getBoundingClientRect();
    const menuW = 360;
    // 面板高度随视口自适应（与 CSS max-height:90vh 一致），定位时按实际可用高度钳制
    const menuH = Math.min(window.innerHeight * 0.9, 460);
    let top = rect.top + rect.height / 2 - menuH / 2;
    const maxTop = Math.max(8, window.innerHeight - menuH - 8);
    if (top < 8) top = 8;
    if (top > maxTop) top = maxTop;
    launcherMenu.style.top = top + 'px';
    // 水平：默认放左侧，空间不足回退右侧
    if (rect.left - menuW - 8 >= 4) {
      launcherMenu.style.left = (rect.left - menuW - 8) + 'px';
      launcherMenu.style.right = 'auto';
      launcherMenu.classList.remove('on-right');
    } else {
      launcherMenu.style.left = (rect.right + 8) + 'px';
      launcherMenu.style.right = 'auto';
      launcherMenu.classList.add('on-right');
    }
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function hostname() { try { return location.hostname; } catch (e) { return ''; } }
  // 站点图标统一渲染：兼容 http(s):// 绝对URL、assets/.. 或 ../../assets/.. 扩展相对路径、emoji。
  // content script 在第三方网页里，扩展相对路径必须用 getURL 转成 chrome-extension:// 绝对URL，
  // 且该资源需在 manifest 的 web_accessible_resources 声明，否则浏览器拒绝加载（裂图）。
  function siteIconHtml(icon, name) {
    const fallback = escapeHtml((name || '?').slice(0, 1));
    if (!icon) return '<span class="aisa-lm-cicon emoji">' + fallback + '</span>';
    if (/^https?:\/\//.test(icon)) {
      return '<img class="aisa-lm-cicon" src="' + escapeHtml(icon) + '" alt="" onerror="this.replaceWith(document.createTextNode(\'' + fallback + '\'))">';
    }
    if (/(?:^|\/)assets\//.test(icon)) {
      // 归一化：去掉前导 ../，得到相对扩展根的路径
      const rel = icon.replace(/^(\.\.\/)+/, '');
      return '<img class="aisa-lm-cicon" src="' + chrome.runtime.getURL(rel) + '" alt="" onerror="this.replaceWith(document.createTextNode(\'' + fallback + '\'))">';
    }
    // emoji 或其它短文本
    return '<span class="aisa-lm-cicon emoji">' + escapeHtml(icon) + '</span>';
  }

  // 5 个 tab 定义（顺序固定，用于高亮同步）
  const TAB_DEFS = [
    { key: 'actions', icon: '⚡', label: '操作' },
    { key: 'settings', icon: '⚙️', label: '设置' },
    { key: 'history', icon: '🗂️', label: '历史' },
    { key: 'sites', icon: '🌐', label: '站点' },
    { key: 'prompts', icon: '💬', label: '提示词' }
  ];

  // 渲染面板外壳（header + tab 栏 + 内容容器），内容由 renderTab 填充
  function renderLauncherMenu() {
    const menu = ensureLauncherMenu();
    menu.innerHTML = '';
    const head = el('div', 'aisa-lm-head',
      '<span class="aisa-lm-title">AI 侧边栏助手</span>' +
      '<span class="aisa-lm-close" title="收起">×</span>'
    );
    head.querySelector('.aisa-lm-close').addEventListener('click', (e) => { e.stopPropagation(); hideLauncherMenu(); });
    menu.appendChild(head);
    const tabs = el('div', 'aisa-lm-tabs');
    TAB_DEFS.forEach((td) => {
      const t = el('div', 'aisa-lm-tab' + (activeTab === td.key ? ' active' : ''),
        '<span class="aisa-lm-tabicon">' + td.icon + '</span><span class="aisa-lm-tablabel">' + td.label + '</span>');
      t.addEventListener('click', (e) => { e.stopPropagation(); activeTab = td.key; renderTab(); });
      tabs.appendChild(t);
    });
    menu.appendChild(tabs);
    const body = el('div', 'aisa-lm-body');
    body.id = 'aisa-lm-body';
    menu.appendChild(body);
    renderTab();
  }

  // 只重渲内容区（切 tab / 数据刷新时用），不动外壳
  function renderTab() {
    const menu = ensureLauncherMenu();
    const body = menu.querySelector('#aisa-lm-body');
    if (!body) return;
    menu.querySelectorAll('.aisa-lm-tab').forEach((t, i) => {
      t.classList.toggle('active', TAB_DEFS[i].key === activeTab);
    });
    body.innerHTML = '';
    if (activeTab === 'actions') renderActionsTab(body);
    else if (activeTab === 'settings') renderSettingsTab(body);
    else if (activeTab === 'history') renderHistoryTab(body);
    else if (activeTab === 'sites') renderSitesTab(body);
    else if (activeTab === 'prompts') renderPromptsTab(body);
  }

  // 把当前网页加入 AI 站点列表（用页面标题作为名称、location.href 作为 URL）
  async function addCurrentPageAsSite() {
    const storage = window.AISA && window.AISA.storage;
    if (!storage || !storage.getSites || !storage.saveSites) {
      toast('存储不可用，添加失败', 2000);
      return;
    }
    const href = location.href;
    if (!/^https?:/i.test(href)) {
      toast('当前页面不是网页，无法添加', 2000);
      return;
    }
    let sites = (await storage.getSites()) || [];
    if (!sites.length) {
      const r = await safeSendMessage({ type: 'AISA_GET_DEFAULT_SITES' });
      sites = (r && r.sites) || [];
    }
    // 去重：同 URL 已存在则提示
    if (sites.some((s) => s && s.url === href)) {
      toast('该页面已在站点列表中', 2000);
      return;
    }
    const name = (document.title || location.hostname || '新站点').slice(0, 20);
    sites = storage.addSite(sites, { id: 'custom_' + Date.now(), name: name, url: href, icon: '🔗' });
    await storage.saveSites(storage.sortSites(sites));
    toast('已添加站点：' + name, 2000);
  }

  // ---------------- 操作 tab ----------------
  function renderActionsTab(body) {
    const selText = currentSelectionText();
    const hasSel = !!selText;
    const actions = [
      { icon: '📋', label: '打开 AI 侧边栏', sub: '在侧边栏打开 AI 网页端', act: () => { openSidePanelFromContent(); hideLauncherMenu(); } },
      { icon: '💬', label: '引用选中文字', sub: hasSel ? '发到侧边栏' : '请先在页面选中文字', disabled: !hasSel, act: () => {
          sendQuote(selText);
          toast('已发送到侧边栏（同时已复制，可 Ctrl+V 粘贴）', 3000);
        } },
      { icon: '🔗', label: '复制本页', sub: '标题 + URL', act: () => { safeSendMessage({ type: 'AISA_COPY_TAB' }); toast('已复制当前标签页', 1500); } },
      { icon: '📑', label: '复制全部标签', sub: '当前窗口所有标签页', act: () => {
          // 复制全部需要 tab 列表，走 background 查询+复制
          safeSendMessage({ type: 'AISA_QUERY_TABS' }).then((resp) => {
            if (resp && resp.ok && resp.tabs) {
              safeSendMessage({ type: 'AISA_COPY_ALL_TABS', tabs: resp.tabs });
              toast('已复制全部标签页', 1500);
            } else {
              toast('查询标签页失败', 1500);
            }
          });
        } },
      { icon: '➕', label: '添加当前页为 AI 站点', sub: '把本页加入侧边栏站点列表', act: async () => {
          await addCurrentPageAsSite();
        } }
    ];
    actions.forEach((it) => body.appendChild(buildActionRow(it)));
    body.appendChild(el('div', 'aisa-lm-sep'));
    body.appendChild(buildActionRow({ icon: '🙈', label: '在本页隐藏悬浮图标', sub: '刷新页面恢复', muted: true, act: () => {
      launcherHidden = true; hideLauncher(); toast('已在本页隐藏，刷新页面恢复', 2000);
    }}));
  }

  function buildActionRow(it) {
    const row = el('div', 'aisa-lm-item' + (it.disabled ? ' disabled' : '') + (it.muted ? ' muted' : ''));
    row.innerHTML =
      '<span class="aisa-lm-icon">' + it.icon + '</span>' +
      '<span class="aisa-lm-text"><span class="aisa-lm-label">' + it.label + '</span>' +
      (it.sub ? '<span class="aisa-lm-sub">' + it.sub + '</span>' : '') + '</span>';
    if (!it.disabled) {
      row.addEventListener('click', (e) => { e.stopPropagation(); try { it.act(); } catch (err) {} });
    }
    return row;
  }

  // ---------------- 设置 tab ----------------
  function renderSettingsTab(body) {
    const settings = (typeof AISA.content.getSettings === 'function') ? (AISA.content.getSettings() || {}) : {};
    // 4 个开关
    const switches = [
      { key: 'superCopy', icon: '🔓', label: '超级复制', sub: '破解禁止复制/右键/选择' },
      { key: 'autoCopy', icon: '✂️', label: '自动复制', sub: '选中文字即复制' },
      { key: 'showFloatBtn', icon: '🔘', label: '选中浮动按钮', sub: '选中后显示"发到侧边栏"' },
      { key: 'showLauncher', icon: '🎈', label: '页面悬浮图标', sub: '每个网页显示悬浮球' }
    ];
    switches.forEach((s) => body.appendChild(buildSwitchRow(s, !!settings[s.key])));
    body.appendChild(el('div', 'aisa-lm-sep'));
    // 下拉/输入
    body.appendChild(buildSelectRow('📑', '标签页复制格式', 'copyFormat', settings.copyFormat || 'title-url', [
      ['title-url', '标题 - URL'], ['title', '仅标题'], ['url', '仅 URL'], ['markdown', 'Markdown'], ['bracket', '[标题] URL'], ['html', 'HTML'], ['csv', 'CSV'], ['json', 'JSON']
    ]));
    body.appendChild(buildSelectRow('📝', '自动复制格式', 'autoCopyFormat', settings.autoCopyFormat || 'plain', [
      ['plain', '纯文本'], ['markdown', 'Markdown']
    ]));
    body.appendChild(buildNumberRow('🔢', '自动复制最小字符数', 'minChars', settings.minChars != null ? settings.minChars : 1, 1, 999));
    body.appendChild(buildNumberRow('📚', '历史记录上限', 'historyLimit', settings.historyLimit != null ? settings.historyLimit : 100, 10, 5000, 10));
    body.appendChild(el('div', 'aisa-lm-sep'));
    // 当前站点超级复制三态
    body.appendChild(buildSiteOverrideRow(settings));
  }

  function buildSwitchRow(s, on) {
    const row = el('div', 'aisa-lm-item toggle');
    row.innerHTML =
      '<span class="aisa-lm-icon">' + s.icon + '</span>' +
      '<span class="aisa-lm-text"><span class="aisa-lm-label">' + s.label + '</span><span class="aisa-lm-sub">' + s.sub + '</span></span>' +
      '<span class="aisa-lm-switch' + (on ? ' on' : '') + '"><span class="knob"></span></span>';
    const sw = row.querySelector('.aisa-lm-switch');
    // 用一个可变变量记录当前状态，点击时乐观更新 UI（立即切换滑块），
    // 不依赖异步 storage.onChanged 回执——否则用户会感到"点了没反应、下次才变"。
    let cur = on;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      cur = !cur;
      sw.classList.toggle('on', cur);   // 立即反馈 UI
      // 同步更新本地 settings 缓存：避免随后 storage.onChanged 触发的 renderTab 重渲
      // 读到旧 currentSettings 把滑块覆盖回旧值（这正是"下次才变"延迟感的根因）。
      if (typeof AISA.content.updateSettingsCache === 'function') {
        AISA.content.updateSettingsCache({ [s.key]: cur });
      }
      safeSendMessage({ type: 'AISA_SAVE_SETTINGS', patch: { [s.key]: cur } });
      toast(s.label + '已' + (cur ? '开启' : '关闭'), 1200);
    });
    return row;
  }
  function buildSelectRow(icon, label, key, curVal, options) {
    const row = el('div', 'aisa-lm-field');
    const opts = options.map(([v, t]) => '<option value="' + v + '"' + (v === curVal ? ' selected' : '') + '>' + escapeHtml(t) + '</option>').join('');
    row.innerHTML =
      '<span class="aisa-lm-icon">' + icon + '</span>' +
      '<span class="aisa-lm-text"><span class="aisa-lm-label">' + label + '</span></span>' +
      '<select class="aisa-lm-select">' + opts + '</select>';
    row.querySelector('select').addEventListener('change', (e) => {
      e.stopPropagation();
      if (typeof AISA.content.updateSettingsCache === 'function') {
        AISA.content.updateSettingsCache({ [key]: e.target.value });
      }
      safeSendMessage({ type: 'AISA_SAVE_SETTINGS', patch: { [key]: e.target.value } });
      toast(label + '已更新', 1000);
    });
    return row;
  }
  function buildNumberRow(icon, label, key, curVal, min, max, step) {
    const row = el('div', 'aisa-lm-field');
    row.innerHTML =
      '<span class="aisa-lm-icon">' + icon + '</span>' +
      '<span class="aisa-lm-text"><span class="aisa-lm-label">' + label + '</span></span>' +
      '<input type="number" class="aisa-lm-input" value="' + curVal + '"' + (min != null ? ' min="' + min + '"' : '') + (max != null ? ' max="' + max + '"' : '') + (step != null ? ' step="' + step + '"' : '') + '>';
    const input = row.querySelector('input');
    input.addEventListener('change', (e) => {
      e.stopPropagation();
      let v = parseInt(e.target.value, 10);
      if (isNaN(v)) v = curVal;
      if (min != null && v < min) v = min;
      if (max != null && v > max) v = max;
      e.target.value = v;
      if (typeof AISA.content.updateSettingsCache === 'function') {
        AISA.content.updateSettingsCache({ [key]: v });
      }
      safeSendMessage({ type: 'AISA_SAVE_SETTINGS', patch: { [key]: v } });
      toast(label + '已更新', 1000);
    });
    return row;
  }
  // 当前站点超级复制三态：跟随全局 → 强制开 → 强制关 → 跟随全局
  function buildSiteOverrideRow(settings) {
    const host = hostname();
    const row = el('div', 'aisa-lm-item toggle');
    const overrides = (settings && settings.siteOverrides) || {};
    const ov = overrides[host];
    const curState = ov && typeof ov.superCopy === 'boolean' ? ov.superCopy : null;
    let label, badge, badgeClass;
    if (curState === null) { label = '本站超级复制'; badge = '跟随全局'; badgeClass = 'neutral'; }
    else if (curState === true) { label = '本站超级复制'; badge = '强制开'; badgeClass = 'on'; }
    else { label = '本站超级复制'; badge = '强制关'; badgeClass = 'off'; }
    row.innerHTML =
      '<span class="aisa-lm-icon">🎯</span>' +
      '<span class="aisa-lm-text"><span class="aisa-lm-label">' + label + (host ? '（' + escapeHtml(host) + '）' : '') + '</span>' +
      '<span class="aisa-lm-sub">点击循环：跟随全局 → 强制开 → 强制关</span></span>' +
      '<span class="aisa-lm-badge ' + badgeClass + '">' + badge + '</span>';
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!host) { toast('当前页面无法识别站点', 1500); return; }
      const next = Object.assign({}, overrides);
      let nextLabel;
      if (curState === null) { next[host] = { superCopy: true }; nextLabel = '本站已强制开启超级复制'; }
      else if (curState === true) { next[host] = { superCopy: false }; nextLabel = '本站已强制关闭超级复制'; }
      else { delete next[host]; nextLabel = '本站已恢复跟随全局'; }
      safeSendMessage({ type: 'AISA_SAVE_SETTINGS', patch: { siteOverrides: next } });
      toast(nextLabel, 1500);
    });
    return row;
  }

  // ---------------- 历史 tab ----------------
  function renderHistoryTab(body) {
    // 搜索框 + 清空按钮
    const toolbar = el('div', 'aisa-lm-toolbar');
    toolbar.innerHTML = '<input type="search" class="aisa-lm-search" placeholder="搜索历史…" value="' + escapeHtml(historyFilter) + '"><button class="aisa-lm-btn danger sm" title="清空全部">清空</button>';
    toolbar.querySelector('input').addEventListener('input', (e) => { e.stopPropagation(); historyFilter = e.target.value; renderHistoryList(); });
    toolbar.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('确定清空全部历史记录？此操作不可撤销。')) return;
      const storage = window.AISA && window.AISA.storage;
      if (storage && storage.clearHistory) { storage.clearHistory(); toast('已清空历史记录', 1500); }
    });
    body.appendChild(toolbar);
    const listWrap = el('div', 'aisa-lm-list');
    listWrap.id = 'aisa-lm-history-list';
    listWrap.appendChild(el('div', 'aisa-lm-loading', '加载中…'));
    body.appendChild(listWrap);
    renderHistoryList();
  }

  function renderHistoryList() {
    const listWrap = launcherMenu && launcherMenu.querySelector('#aisa-lm-history-list');
    if (!listWrap) return;
    listWrap.innerHTML = '';
    const storage = window.AISA && window.AISA.storage;
    if (!storage || typeof storage.getHistory !== 'function') {
      listWrap.appendChild(el('div', 'aisa-lm-empty', '暂无历史记录'));
      return;
    }
    storage.getHistory().then((items) => {
      if (!launcherMenu || launcherMenu.classList.contains('hidden')) return;
      listWrap.innerHTML = '';
      const all = Array.isArray(items) ? items : [];
      const q = (historyFilter || '').toLowerCase();
      const list = q ? all.filter((it) => ((it.text || '') + ' ' + (it.source || '')).toLowerCase().includes(q)) : all;
      const shown = list.slice(0, 50);
      if (shown.length === 0) { listWrap.appendChild(el('div', 'aisa-lm-empty', q ? '没有匹配的记录' : '暂无历史记录')); return; }
      shown.forEach((it) => {
        const row = el('div', 'aisa-lm-hitem');
        const preview = (it.text || '').replace(/\s+/g, ' ').slice(0, 120);
        const src = it.source || it.url || '';
        const t = it.time ? new Date(it.time) : null;
        const tstr = t ? (t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')) : '';
        row.innerHTML =
          '<div class="aisa-lm-hpre">' + escapeHtml(preview) + '</div>' +
          '<div class="aisa-lm-hmeta">' + (src ? '<span class="src">' + escapeHtml(src) + '</span> · ' : '') + '<span class="time">' + tstr + '</span></div>' +
          '<div class="aisa-lm-hact"><button class="aisa-lm-btn sm" title="复制">📋</button><button class="aisa-lm-btn sm danger" title="删除">🗑️</button></div>';
        row.querySelector('.aisa-lm-hact button:nth-child(1)').addEventListener('click', (e) => {
          e.stopPropagation();
          const clip = window.AISA && window.AISA.clipboard;
          if (clip && clip.copyText) clip.copyText(it.text || '').then(() => toast('已复制到剪贴板', 1500));
        });
        row.querySelector('.aisa-lm-hact button:nth-child(2)').addEventListener('click', (e) => {
          e.stopPropagation();
          if (storage.removeHistoryItem) { storage.removeHistoryItem(it.id); toast('已删除', 1200); }
        });
        row.addEventListener('click', (e) => { // 点空白处也复制
          if (e.target.closest('button')) return;
          e.stopPropagation();
          const clip = window.AISA && window.AISA.clipboard;
          if (clip && clip.copyText) clip.copyText(it.text || '').then(() => toast('已复制到剪贴板', 1500));
        });
        listWrap.appendChild(row);
      });
      if (list.length > 50) listWrap.appendChild(el('div', 'aisa-lm-hint', '仅显示前 50 条，更多请打开历史页'));
    }).catch(() => { listWrap.innerHTML = ''; listWrap.appendChild(el('div', 'aisa-lm-empty', '读取历史失败')); });
  }

  // ---------------- 站点 tab（AI 站点 CRUD）----------------
  async function renderSitesTab(body) {
    body.appendChild(el('div', 'aisa-lm-loading', '加载中…'));
    const storage = window.AISA && window.AISA.storage;
    let sites = [];
    if (storage && storage.getSites) sites = await storage.getSites();
    // getSites 返回 null 时取默认（background 定义）
    if ((!sites || sites.length === 0) && storage && storage.saveSites) {
      const r = await safeSendMessage({ type: 'AISA_GET_DEFAULT_SITES' });
      sites = (r && r.sites) || [];
    }
    if (!launcherMenu || launcherMenu.classList.contains('hidden')) return;
    body.innerHTML = '';
    // 编辑/新增表单
    body.appendChild(buildSiteForm(siteEditId !== null ? sites.find((s) => s.id === siteEditId) : null));
    body.appendChild(el('div', 'aisa-lm-sep'));
    // 列表（渲染前统一排序：置顶区在前）
    const listWrap = el('div', 'aisa-lm-list');
    if (!sites || sites.length === 0) {
      listWrap.appendChild(el('div', 'aisa-lm-empty', '暂无站点'));
    } else {
      const sorted = storage && storage.sortSites ? storage.sortSites(sites) : sites;
      const firstOther = sorted.findIndex((s) => !s.pinned); // 第一个非置顶（区域边界）
      sorted.forEach((s, idx) => {
        const row = el('div', 'aisa-lm-cruitem' + (s.pinned ? ' is-pinned' : ''));
        row.dataset.id = s.id;
        row.draggable = true; // 纵向拖拽（置顶区/非置顶区各自内部可拖，跨区被拒绝）
        const iconHtml = siteIconHtml(s.icon, s.name);
        const pinBtn = s.pinned
          ? '<button class="aisa-lm-btn sm active" data-act="pin" title="取消置顶">📌</button>'
          : '<button class="aisa-lm-btn sm" data-act="pin" title="置顶">📍</button>';
        row.innerHTML =
          '<span class="aisa-lm-drag" title="拖拽排序">⠿</span>' +
          iconHtml +
          '<div class="aisa-lm-ctext"><div class="aisa-lm-clabel">' + escapeHtml(s.name) + '</div><div class="aisa-lm-curl">' + escapeHtml(s.url) + '</div></div>' +
          '<div class="aisa-lm-cact">' +
            pinBtn +
            '<button class="aisa-lm-btn sm" data-act="up" title="上移">▲</button>' +
            '<button class="aisa-lm-btn sm" data-act="down" title="下移">▼</button>' +
            '<button class="aisa-lm-btn sm" data-act="edit" title="编辑">✎</button>' +
            '<button class="aisa-lm-btn sm danger" data-act="del" title="删除">✕</button>' +
          '</div>';
        // 区域边界：▲▼ 在区域内首位/末位禁用
        const isPinned = !!s.pinned;
        const atZoneTop = isPinned ? idx === 0 : idx === firstOther;
        const atZoneBottom = isPinned ? idx === firstOther - 1 : idx === sorted.length - 1;
        if (atZoneTop) row.querySelector('[data-act="up"]').disabled = true;
        if (atZoneBottom) row.querySelector('[data-act="down"]').disabled = true;
        row.querySelector('[data-act="pin"]').addEventListener('click', (e) => {
          e.stopPropagation();
          if (storage && storage.togglePin) { storage.saveSites(storage.togglePin(sites, s.id)); }
        });
        row.querySelector('[data-act="up"]').addEventListener('click', (e) => { e.stopPropagation(); if (!atZoneTop) moveSite(sorted, idx, -1); });
        row.querySelector('[data-act="down"]').addEventListener('click', (e) => { e.stopPropagation(); if (!atZoneBottom) moveSite(sorted, idx, 1); });
        row.querySelector('[data-act="edit"]').addEventListener('click', (e) => { e.stopPropagation(); siteEditId = s.id; renderTab(); });
        row.querySelector('[data-act="del"]').addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm('删除站点「' + s.name + '」？')) return;
          const next = sites.filter((x) => x.id !== s.id);
          if (storage && storage.saveSites) { storage.saveSites(next); toast('已删除', 1200); }
        });
        bindSiteRowDrag(row, sorted, listWrap, storage);
        listWrap.appendChild(row);
      });
    }
    body.appendChild(listWrap);
    body.appendChild(el('div', 'aisa-lm-hint', '站点列表同步到侧边栏'));
  }

  function buildSiteForm(editing) {
    const wrap = el('div', 'aisa-lm-form');
    wrap.innerHTML =
      '<div class="aisa-lm-formtitle">' + (editing ? '编辑站点' : '添加站点') + '</div>' +
      '<input class="aisa-lm-input block" id="aisa-site-name" placeholder="名称（如 ChatGPT）" value="' + escapeHtml(editing ? editing.name : '') + '">' +
      '<input class="aisa-lm-input block" id="aisa-site-url" placeholder="网址 https://…" value="' + escapeHtml(editing ? editing.url : '') + '">' +
      '<input class="aisa-lm-input block" id="aisa-site-icon" placeholder="图标 emoji（可空，如 🤖）" maxlength="4" value="' + escapeHtml(editing && editing.icon && !/^https?:|^assets\//.test(editing.icon) ? editing.icon : '') + '">' +
      '<label class="aisa-lm-check"><input type="checkbox" id="aisa-site-pin" ' + (editing && editing.pinned ? 'checked' : '') + '><span>置顶到首位</span></label>' +
      '<div class="aisa-lm-formbtns"><button class="aisa-lm-btn primary sm" id="aisa-site-save">' + (editing ? '保存' : '添加') + '</button>' + (editing ? '<button class="aisa-lm-btn sm" id="aisa-site-cancel">取消</button>' : '') + '</div>';
    wrap.querySelector('#aisa-site-save').addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = wrap.querySelector('#aisa-site-name').value.trim();
      const url = wrap.querySelector('#aisa-site-url').value.trim();
      const icon = wrap.querySelector('#aisa-site-icon').value.trim();
      const pinned = wrap.querySelector('#aisa-site-pin').checked;
      if (!name || !url) { toast('请填写名称和网址', 1500); return; }
      const storage = window.AISA && window.AISA.storage;
      if (!storage || !storage.getSites || !storage.saveSites) { toast('保存失败', 1500); return; }
      let sites = (await storage.getSites()) || [];
      if (!sites.length) { const r = await safeSendMessage({ type: 'AISA_GET_DEFAULT_SITES' }); sites = (r && r.sites) || []; }
      const wasEdit = siteEditId !== null;
      if (wasEdit) {
        // 编辑：切置顶时用 togglePin 的语义（放置顶区末尾/取消到非置顶区末尾）
        sites = sites.map((s) => (s.id === siteEditId ? Object.assign({}, s, {
          name: name,
          url: url,
          icon: icon || '🔗'
        }) : s));
        const edited = sites.find((s) => s.id === siteEditId);
        if (edited && !!edited.pinned !== pinned) {
          sites = storage.togglePin(sites, siteEditId);
        }
      } else {
        sites = storage.addSite(sites, {
          id: 'custom_' + Date.now(),
          name: name,
          url: url,
          icon: icon || '🔗'
        });
        if (pinned) sites = storage.togglePin(sites, sites[sites.length - 1].id);
      }
      await storage.saveSites(storage.sortSites(sites));
      siteEditId = null;
      toast(wasEdit ? '已保存' : '已添加', 1200);
      renderTab();
    });
    if (editing) {
      wrap.querySelector('#aisa-site-cancel').addEventListener('click', (e) => { e.stopPropagation(); siteEditId = null; renderTab(); });
    }
    return wrap;
  }

  async function moveSite(sites, idx, dir) {
    const ni = idx + dir;
    if (ni < 0 || ni >= sites.length) return;
    const arr = sites.slice();
    // 区域隔离：不能跨置顶/非置顶边界
    if (!!arr[idx].pinned !== !!arr[ni].pinned) return;
    const storage = window.AISA && window.AISA.storage;
    if (storage && storage.reorderSite && storage.saveSites) {
      // dir=-1 上移 = 放到前一项之前；dir=+1 下移 = 放到后一项之后
      const next = storage.reorderSite(arr, arr[idx].id, arr[ni].id, dir > 0);
      await storage.saveSites(storage.sortSites(next));
      renderTab();
    }
  }

  // 站点列表纵向拖拽：置顶区/非置顶区各自内部可拖，跨区被拒绝
  function bindSiteRowDrag(row, sorted, listWrap, storage) {
    row.addEventListener('dragstart', (e) => {
      siteDragSrcId = row.dataset.id;
      row.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.id); } catch (_) {}
    });
    row.addEventListener('dragover', (e) => {
      if (!siteDragSrcId || row.dataset.id === siteDragSrcId) return;
      const src = sorted.find((s) => s.id === siteDragSrcId);
      const dst = sorted.find((s) => s.id === row.dataset.id);
      if (!src || !dst || !!src.pinned !== !!dst.pinned) return; // 跨区拒绝
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
      if (!siteDragSrcId || row.dataset.id === siteDragSrcId) { siteDragSrcId = null; return; }
      const src = sorted.find((s) => s.id === siteDragSrcId);
      const dst = sorted.find((s) => s.id === row.dataset.id);
      if (!src || !dst || !!src.pinned !== !!dst.pinned) { siteDragSrcId = null; return; }
      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      // 通过 reorderSite 更新对应区优先级（区域隔离由其校验）
      if (storage && storage.reorderSite && storage.saveSites) {
        const next = storage.reorderSite(sorted, siteDragSrcId, row.dataset.id, after);
        await storage.saveSites(storage.sortSites(next));
        renderTab();
      }
      siteDragSrcId = null;
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      Array.from(listWrap.querySelectorAll('.drag-over-top,.drag-over-bottom')).forEach((el) =>
        el.classList.remove('drag-over-top', 'drag-over-bottom')
      );
      siteDragSrcId = null;
    });
  }

  // ---------------- 提示词 tab（CRUD）----------------
  async function renderPromptsTab(body) {
    body.appendChild(el('div', 'aisa-lm-loading', '加载中…'));
    const storage = window.AISA && window.AISA.storage;
    let prompts = (storage && storage.getPrompts) ? (await storage.getPrompts()) : [];
    if (!Array.isArray(prompts)) prompts = [];
    if (!launcherMenu || launcherMenu.classList.contains('hidden')) return;
    body.innerHTML = '';
    const editing = promptEditIdx !== null ? prompts[promptEditIdx] : null;
    body.appendChild(buildPromptForm(editing));
    body.appendChild(el('div', 'aisa-lm-sep'));
    const listWrap = el('div', 'aisa-lm-list');
    if (prompts.length === 0) {
      listWrap.appendChild(el('div', 'aisa-lm-empty', '暂无提示词模板'));
    } else {
      prompts.forEach((p, idx) => {
        const row = el('div', 'aisa-lm-cruitem');
        const preview = (p.content || '').replace(/\s+/g, ' ').slice(0, 40);
        row.innerHTML =
          '<span class="aisa-lm-cicon mono">/' + escapeHtml(p.trigger) + '</span>' +
          '<div class="aisa-lm-ctext"><div class="aisa-lm-clabel">' + escapeHtml(preview || '(空)') + '</div></div>' +
          '<div class="aisa-lm-cact">' +
            '<button class="aisa-lm-btn sm" data-act="up" title="上移">▲</button>' +
            '<button class="aisa-lm-btn sm" data-act="down" title="下移">▼</button>' +
            '<button class="aisa-lm-btn sm" data-act="edit" title="编辑">✎</button>' +
            '<button class="aisa-lm-btn sm danger" data-act="del" title="删除">✕</button>' +
          '</div>';
        row.querySelector('[data-act="up"]').addEventListener('click', (e) => { e.stopPropagation(); movePrompt(prompts, idx, -1); });
        row.querySelector('[data-act="down"]').addEventListener('click', (e) => { e.stopPropagation(); movePrompt(prompts, idx, 1); });
        row.querySelector('[data-act="edit"]').addEventListener('click', (e) => { e.stopPropagation(); promptEditIdx = idx; renderTab(); });
        row.querySelector('[data-act="del"]').addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm('删除提示词 /' + p.trigger + ' ？')) return;
          const next = prompts.filter((_, i) => i !== idx);
          if (storage && storage.savePrompts) { storage.savePrompts(next); toast('已删除', 1200); }
        });
        listWrap.appendChild(row);
      });
    }
    body.appendChild(listWrap);
    body.appendChild(el('div', 'aisa-lm-hint', '在侧边栏输入框打 /触发词 展开模板'));
  }

  function buildPromptForm(editing) {
    const wrap = el('div', 'aisa-lm-form');
    wrap.innerHTML =
      '<div class="aisa-lm-formtitle">' + (editing ? '编辑提示词' : '添加提示词') + '</div>' +
      '<input class="aisa-lm-input block" id="aisa-prompt-trigger" placeholder="触发词（如 fy）" value="' + escapeHtml(editing ? editing.trigger : '') + '">' +
      '<textarea class="aisa-lm-textarea" id="aisa-prompt-content" placeholder="展开内容（如：请翻译以下内容：）">' + escapeHtml(editing ? editing.content : '') + '</textarea>' +
      '<div class="aisa-lm-formbtns"><button class="aisa-lm-btn primary sm" id="aisa-prompt-save">' + (editing ? '保存' : '添加') + '</button>' + (editing ? '<button class="aisa-lm-btn sm" id="aisa-prompt-cancel">取消</button>' : '') + '</div>';
    wrap.querySelector('#aisa-prompt-save').addEventListener('click', async (e) => {
      e.stopPropagation();
      const trigger = wrap.querySelector('#aisa-prompt-trigger').value.trim();
      const content = wrap.querySelector('#aisa-prompt-content').value;
      if (!trigger || !content) { toast('请填写触发词和内容', 1500); return; }
      const storage = window.AISA && window.AISA.storage;
      if (!storage || !storage.getPrompts || !storage.savePrompts) { toast('保存失败', 1500); return; }
      let prompts = (await storage.getPrompts()) || [];
      // 触发词唯一性（新增时校验，编辑时排除自身）
      const dup = prompts.findIndex((p, i) => p.trigger === trigger && i !== promptEditIdx);
      if (dup >= 0) { toast('触发词 /' + trigger + ' 已存在', 1500); return; }
      if (promptEditIdx !== null) {
        prompts = prompts.map((p, i) => i === promptEditIdx ? { trigger: trigger, content: content } : p);
      } else {
        prompts.push({ trigger: trigger, content: content });
      }
      await storage.savePrompts(prompts);
      promptEditIdx = null;
      toast('已保存', 1200);
      renderTab();
    });
    if (editing) {
      wrap.querySelector('#aisa-prompt-cancel').addEventListener('click', (e) => { e.stopPropagation(); promptEditIdx = null; renderTab(); });
    }
    return wrap;
  }

  async function movePrompt(prompts, idx, dir) {
    const ni = idx + dir;
    if (ni < 0 || ni >= prompts.length) return;
    const arr = prompts.slice();
    const tmp = arr[idx]; arr[idx] = arr[ni]; arr[ni] = tmp;
    const storage = window.AISA && window.AISA.storage;
    if (storage && storage.savePrompts) { await storage.savePrompts(arr); renderTab(); }
  }

  function showLauncherMenu() {
    activeTab = 'actions'; // 每次打开都回到「操作」tab
    renderLauncherMenu();
    positionLauncherMenu();
    launcherMenu.classList.remove('hidden');
    launcher.classList.add('menu-open');
    bindStorageChange();
    setTimeout(() => {
      launcherMenuAwayHandler = (e) => {
        if (launcherMenu && !launcherMenu.contains(e.target) && !(launcher && launcher.contains(e.target))) {
          hideLauncherMenu();
        }
      };
      document.addEventListener('mousedown', launcherMenuAwayHandler, true);
    }, 0);
  }

  function bindStorageChange() {
    if (storageChangeBound) return;
    storageChangeBound = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!launcherMenu || launcherMenu.classList.contains('hidden')) return;
        if (area === 'local' && changes.aisa_history && activeTab === 'history') renderTab();
        if (area === 'local' && changes.aisa_sites && activeTab === 'sites') renderTab();
        if (area === 'sync' && (changes.aisa_settings || changes.aisa_prompts)) {
          if (activeTab === 'settings' || activeTab === 'prompts') renderTab();
        }
      });
    } catch (e) {}
  }

  function hideLauncherMenu() {
    if (launcherMenu) launcherMenu.classList.add('hidden');
    if (launcher) launcher.classList.remove('menu-open');
    if (launcherMenuAwayHandler) {
      document.removeEventListener('mousedown', launcherMenuAwayHandler, true);
      launcherMenuAwayHandler = null;
    }
  }

  function toggleLauncherMenu() {
    if (launcherMenu && !launcherMenu.classList.contains('hidden')) {
      hideLauncherMenu();
    } else {
      showLauncherMenu();
    }
  }



  // ==================== 超级复制破解 ====================
  let superCopyActive = false;
  let injectedStyle = null;

  function enableSuperCopy() {
    if (superCopyActive) return;
    superCopyActive = true;

    // 1. CSS：强制允许选择/拖拽
    document.documentElement.classList.add('aisa-supercopy');

    // 2. 清除内联 onXxx 事件处理器
    try {
      ['oncontextmenu', 'oncopy', 'oncut', 'onselectstart', 'ondragstart', 'onpaste', 'onmousedown', 'onkeydown'].forEach((prop) => {
        try { document[prop] = null; } catch (e) {}
        try { document.body && (document.body[prop] = null); } catch (e) {}
      });
    } catch (e) {}

    // 3. 拦截 addEventListener 形式的事件（capture 阶段 + stopImmediatePropagation）
    //    注意：这里只阻止"阻止默认"的行为，让 copy/contextmenu/selectstart 恢复
    //    例外：本扩展自己注入的悬浮控制台（#aisa-launcher-menu）内的事件放行，
    //    否则会吞掉其中站点列表的拖拽（dragstart）等自定义交互。
    ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart', 'paste', 'beforecopy', 'beforecut'].forEach((evName) => {
      window.addEventListener(
        evName,
        function (e) {
          // 来自本扩展悬浮控制台的事件，不拦截
          if (e.target && e.target.closest && e.target.closest('#aisa-launcher-menu')) return;
          // 允许默认行为：立即停止后续可能 preventDefault 的监听器
          e.stopImmediatePropagation();
        },
        true // capture
      );
      document.addEventListener(
        evName,
        function (e) {
          if (e.target && e.target.closest && e.target.closest('#aisa-launcher-menu')) return;
          e.stopImmediatePropagation();
        },
        true
      );
    });

    // 4. 定期清理新增节点上的内联事件（针对动态内容站点，轻量节流）
    if (!injectedStyle) {
      injectedStyle = document.createElement('style');
      injectedStyle.id = 'aisa-supercopy-style';
      injectedStyle.textContent =
        '*, *::before, *::after { -webkit-user-select: text !important; user-select: text !important; }';
      document.documentElement.appendChild(injectedStyle);
    }

    toast('已开启超级复制', 1500);
  }

  function disableSuperCopy() {
    if (!superCopyActive) return;
    superCopyActive = false;
    document.documentElement.classList.remove('aisa-supercopy');
    if (injectedStyle) {
      injectedStyle.remove();
      injectedStyle = null;
    }
    // 事件监听器无法精确移除（匿名函数），但 superCopyActive 标志位足够；下次开启会重新绑定
  }

  // ==================== 自动复制 ====================
  let lastAutoCopied = '';
  async function autoCopySelection(settings) {
    if (!settings.autoCopy) return;
    const text = currentSelectionText(settings.autoCopyFormat);
    if (!text) return;
    if (text.length < (settings.minChars || 1)) return;
    if (text === lastAutoCopied) return; // 避免重复复制
    lastAutoCopied = text;

    const ok = window.AISA.clipboard ? await window.AISA.clipboard.copyText(text) : false;
    // 加入历史（context 失效时跳过，剪贴板写入不受影响）
    if (window.AISA.storage && ok && runtimeAlive()) {
      try { await window.AISA.storage.addHistoryItem(text, document.title || ''); } catch (e) {}
    }
    if (ok) {
      toast('已复制选中内容' + (settings.autoCopyFormat === 'markdown' ? '（Markdown）' : ''), 1200);
    }
  }

  // ==================== 导出给 content.js ====================
  AISA.content = {
    toast,
    ensureFloatBtn,
    showFloatBtnAt,
    hideFloatBtn,
    currentSelectionText,
    isEditableTarget,
    sendQuote,
    enableSuperCopy,
    disableSuperCopy,
    autoCopySelection,
    runtimeAlive,
    safeSendMessage,
    showLauncher,
    hideLauncher
  };
})();
