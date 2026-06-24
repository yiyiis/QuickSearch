/* src/sidepanel/composer.js
 * @ 引用器逻辑：
 *  - contenteditable 编辑器，监听输入
 *  - 输入 @ 时弹出候选菜单（当前选中 / 当前页面 / 其他标签页）
 *  - 选择候选 → 插入"引用芯片"（带 data-ref 的 span）
 *  - 「组装并复制」→ 把编辑器内容序列化为纯文本（芯片展开为引用块）→ 复制到剪贴板
 *
 * 依赖：window.AISA.storage / .clipboard；background 消息转发。
 * 需在 sidepanel.js 之后、且 DOM 就绪后调用 initComposer()。
 */
(function () {
  const storage = window.AISA.storage;
  const clipboard = window.AISA.clipboard;

  const editor = document.getElementById('cmp-editor');
  const atMenu = document.getElementById('at-menu');
  const statsEl = document.getElementById('cmp-stats');
  const toastEl = document.getElementById('toast');

  // 引用数据缓存：id → { kind, label, text }
  const refs = new Map();
  let refSeq = 0;
  
  let prompts = [];

  // ---------- 工具 ----------
  function showToast(msg, duration) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), duration || 1800);
  }

  function focusEditorAtEnd() {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 读取光标前缀，用于检测 @ 或 / 触发与查询词
  function getAtContext() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent.slice(0, range.startOffset);
    const match = text.match(/([@/、／])([^\s@/、／]*)$/);
    if (!match) return null;
    const triggerChar = match[1] === '@' ? '@' : '/';
    return { triggerChar: triggerChar, rawTrigger: match[1], query: match[2], atStart: range.startOffset - match[0].length, textNode: node };
  }

  // 删除光标前的 @xxx 或 /xxx
  function removeAtToken(ctx) {
    if (!ctx) return;
    const node = ctx.textNode;
    const before = node.textContent.slice(0, ctx.atStart);
    const after = node.textContent.slice(ctx.atStart + (ctx.rawTrigger + ctx.query).length);
    node.textContent = before + after;
    // 把光标放到删除点
    const range = document.createRange();
    range.setStart(node, ctx.atStart);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- 芯片 ----------
  function insertChip(ref) {
    const id = 'ref_' + (++refSeq);
    refs.set(id, ref);

    const chip = document.createElement('span');
    chip.className = 'cmp-chip' + (ref.kind === 'prompt' ? ' cmp-chip-prompt' : '');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('data-ref', id);
    
    // 如果是提示词，label自带有 '/' 前缀，引用则补上 '@'
    const prefix = ref.kind === 'prompt' ? '' : '@';
    chip.innerHTML = prefix + escapeHtml(ref.label) + '<span class="chip-x" title="' + AISA.i18n.t('移除') + '">×</span>';

    chip.querySelector('.chip-x').addEventListener('click', (e) => {
      e.preventDefault();
      refs.delete(id);
      chip.remove();
      updateStats();
    });

    // 在当前光标处插入芯片 + 一个空格
    const sel = window.getSelection();
    let range;
    if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.insertNode(chip);
    // 空格
    const space = document.createTextNode('\u00a0');
    chip.after(space);
    // 将光标严格定位在空格文本节点内部的末尾，防止 contenteditable 迷失焦点
    range.setStart(space, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    updateStats();
  }

  // ---------- @ 候选菜单 ----------
  function hideAtMenu() {
    atMenu.classList.add('hidden');
    atMenu.innerHTML = '';
    // 清理 fixed 定位的 inline 样式，避免下次显示时闪到旧位置
    atMenu.style.top = '';
    atMenu.style.left = '';
    atMenu.style.width = '';
    atMenu.style.maxHeight = '';
  }

  function buildCandidates() {
    return [
      { kind: 'quote', label: AISA.i18n.t('已选引用'), icon: '📌', group: AISA.i18n.t('快速') },
      { kind: 'selection', label: AISA.i18n.t('当前选中'), icon: '✂️', group: AISA.i18n.t('快速') },
      { kind: 'page', label: AISA.i18n.t('当前页面正文'), icon: '📄', group: AISA.i18n.t('快速') },
      { kind: 'tabs', label: AISA.i18n.t('其他标签页…'), icon: '🗂', group: AISA.i18n.t('更多'), isDynamic: true },
      { kind: 'history', label: AISA.i18n.t('剪贴板历史…'), icon: '📋', group: AISA.i18n.t('更多'), isDynamic: true }
    ];
  }

  function renderAtMenu(ctx, dynamicTabs, dynamicHistory) {
    const query = (ctx.query || '').toLowerCase();
    let items = buildCandidates();

    // 其他标签页：展开为每个 tab 一项
    let tabItems = [];
    if (dynamicTabs && dynamicTabs.length) {
      tabItems = dynamicTabs
        .filter((t) => !t.active) // 排除当前活动页
        .map((t) => ({
          kind: 'tab',
          label: t.title || AISA.i18n.t('(无标题)'),
          icon: '🔖',
          group: AISA.i18n.t('其他标签页'),
          tabId: t.id,
          url: t.url
        }));
    }

    // 剪贴板历史：展开为每条一项
    let historyItems = [];
    if (dynamicHistory && dynamicHistory.length) {
      historyItems = dynamicHistory.map((h) => ({
        kind: 'history',
        label: truncate(h.text.replace(/\s+/g, ' ').trim(), 30) || AISA.i18n.t('(空)'),
        icon: '🕐',
        group: AISA.i18n.t('剪贴板历史'),
        text: h.text,
        source: h.source || '',
        time: h.time || 0,
        id: h.id
      }));
    }

    // 合并 + 过滤（历史条目同时按正文内容匹配查询词）
    const all = items.concat(tabItems, historyItems).filter((it) => {
      if (!query) return true;
      const hay = (it.label || '') + ' ' + (it.kind === 'history' ? (it.text || '') : '');
      return hay.toLowerCase().indexOf(query) !== -1;
    });

    if (!all.length) {
      hideAtMenu();
      return;
    }

    atMenu.innerHTML = '';
    let lastGroup = null;
    all.forEach((it, idx) => {
      if (it.group !== lastGroup) {
        const g = document.createElement('div');
        g.className = 'at-group';
        g.textContent = it.group;
        atMenu.appendChild(g);
        lastGroup = it.group;
      }
      const row = document.createElement('div');
      row.className = 'at-item' + (idx === 0 ? ' active' : '');
      let sub = '';
      if (it.kind === 'tab') sub = shortUrl(it.url) || '';
      else if (it.kind === 'page') sub = AISA.i18n.t('提取正文');
      else if (it.kind === 'selection') sub = AISA.i18n.t('网页选区');
      else if (it.kind === 'quote') {
        // 显示顶部引用的前几个字，便于辨认；为空时提示
        const qt = fetchQuoteText();
        sub = qt ? AISA.i18n.t('顶部引用：') + truncate(qt.replace(/\s+/g, ' '), 24) : AISA.i18n.t('（顶部暂无引用）');
      }
      else if (it.kind === 'history') sub = it.source ? it.source + ' · ' + fmtTime(it.time) : fmtTime(it.time);
      row.innerHTML =
        '<span class="at-ico">' + it.icon + '</span>' +
        '<span class="at-main">' +
          '<span class="at-title">' + escapeHtml(it.label) + '</span>' +
          (sub ? '<span class="at-sub">' + escapeHtml(sub) + '</span>' : '') +
        '</span>';
      row.addEventListener('mouseenter', () => {
        Array.from(atMenu.querySelectorAll('.at-item')).forEach((el) => el.classList.remove('active'));
        row.classList.add('active');
      });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 防止失焦
      });
      row.addEventListener('click', () => chooseCandidate(it, ctx));
      atMenu.appendChild(row);
    });

    atMenu.classList.remove('hidden');
    positionAtMenu();
  }

  // ---------- / 自定义提示词菜单 ----------
  function renderPromptMenu(ctx) {
    const query = (ctx && ctx.query) ? ctx.query.toLowerCase() : '';
    const filtered = prompts.filter(p => p.trigger.toLowerCase().includes(query) || p.content.toLowerCase().includes(query));
    
    if (!filtered.length && query) {
      hideAtMenu();
      return;
    }

    atMenu.innerHTML = '';
    const g = document.createElement('div');
    g.className = 'at-group';
    g.textContent = AISA.i18n.t('自定义提示词模板 (输入 / 快速匹配)');
    atMenu.appendChild(g);

    if (!filtered.length) {
      const row = document.createElement('div');
      row.className = 'at-item active';
      row.innerHTML =
        '<span class="at-ico">⚙️</span>' +
        '<span class="at-main">' +
          '<span class="at-title">' + AISA.i18n.t('去设置页添加模板...') + '</span>' +
        '</span>';
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        hideAtMenu();
        chrome.runtime.openOptionsPage();
      });
      atMenu.appendChild(row);
    } else {
      filtered.forEach((it, idx) => {
        const row = document.createElement('div');
        row.className = 'at-item' + (idx === 0 ? ' active' : '');
        row.innerHTML =
          '<span class="at-ico">⚡</span>' +
          '<span class="at-main">' +
            '<span class="at-title">/' + escapeHtml(it.trigger) + '</span>' +
            '<span class="at-sub">' + escapeHtml(truncate(it.content.replace(/\s+/g, ' '), 30)) + '</span>' +
          '</span>';
        row.addEventListener('mouseenter', () => {
          Array.from(atMenu.querySelectorAll('.at-item')).forEach((el) => el.classList.remove('active'));
          row.classList.add('active');
        });
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => choosePrompt(it, ctx));
        atMenu.appendChild(row);
      });
    }

    atMenu.classList.remove('hidden');
    positionAtMenu();
  }

  function choosePrompt(p, ctx) {
    hideAtMenu();
    if (ctx) removeAtToken(ctx);
    
    // 作为“芯片”插入，保持输入框清爽
    insertChip({
      kind: 'prompt',
      label: '/' + p.trigger,
      text: p.content
    });
    updateStats();
  }

  // 把 @ 菜单定位到编辑器正下方，向下延伸；
  // 下方空间不足时自动调小 maxHeight 并允许内部滚动。
  function positionAtMenu() {
    const rect = editor.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const top = rect.bottom + 4; // 编辑器底部下方 4px
    const availBelow = viewportH - top - 8; // 留 8px 底部边距

    // 左右对齐编辑器
    atMenu.style.left = rect.left + 'px';
    atMenu.style.top = top + 'px';
    atMenu.style.width = rect.width + 'px';
    atMenu.style.removeProperty('right');

    if (availBelow < 120) {
      // 下方空间太小：向上展开（贴编辑器上方）
      const height = Math.min(260, rect.top - 8);
      atMenu.style.top = Math.max(4, rect.top - 4 - height) + 'px';
      atMenu.style.maxHeight = Math.max(120, height) + 'px';
    } else {
      atMenu.style.maxHeight = Math.min(260, availBelow) + 'px';
    }
  }

  function moveActive(delta) {
    const rows = Array.from(atMenu.querySelectorAll('.at-item'));
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.classList.contains('active'));
    if (i < 0) i = 0;
    i = (i + delta + rows.length) % rows.length;
    rows.forEach((r) => r.classList.remove('active'));
    rows[i].classList.add('active');
    rows[i].scrollIntoView({ block: 'nearest' });
  }
  function activeRow() {
    return atMenu.querySelector('.at-item.active');
  }

  // ---------- 候选选择：拉取数据 → 插入芯片 ----------
  async function chooseCandidate(it, ctx) {
    hideAtMenu();
    removeAtToken(ctx);

    if (it.kind === 'tabs') {
      // 展开为每个 tab 的列表，无需插入；这里直接重新渲染带 tabs 的菜单
      const tabs = await fetchTabs();
      if (!tabs.length) {
        showToast(AISA.i18n.t('没有其他标签页'));
        return;
      }
      // 恢复 @ 并重新打开带 tab 列表的菜单
      reinsertAt();
      renderAtMenu(getAtContext(), tabs);
      return;
    }

    if (it.kind === 'history' && it.isDynamic) {
      // "剪贴板历史…" 入口：展开为每条历史
      const hist = await fetchHistory();
      if (!hist.length) {
        showToast(AISA.i18n.t('暂无剪贴板历史'));
        return;
      }
      reinsertAt();
      renderAtMenu(getAtContext(), null, hist);
      return;
    }

    let ref = null;
    if (it.kind === 'quote') {
      // 从顶部可编辑的 quote-bar 取实时内容
      const text = fetchQuoteText();
      if (!text) { showToast(AISA.i18n.t('顶部暂无引用，可先在上方输入框编辑一段')); return; }
      ref = { kind: 'quote', label: AISA.i18n.t('已选引用'), text: text, source: fetchQuoteSource() };
    } else if (it.kind === 'selection') {
      const text = await fetchSelection();
      if (!text) { showToast(AISA.i18n.t('当前网页没有选中文字')); return; }
      ref = { kind: 'selection', label: AISA.i18n.t('当前选中'), text: text, source: await currentTitle() };
    } else if (it.kind === 'page') {
      const data = await fetchPage();
      if (!data || !data.content) { showToast(AISA.i18n.t('无法提取当前页面正文')); return; }
      ref = {
        kind: 'page',
        label: truncate(data.title || AISA.i18n.t('当前页面'), 18),
        text: data.content,
        meta: { url: data.url, title: data.title, truncated: data.truncated }
      };
    } else if (it.kind === 'tab') {
      const t = await fetchTabText(it.tabId);
      if (!t || !t.ok) { showToast(AISA.i18n.t('无法读取该标签页')); return; }
      ref = {
        kind: 'tab',
        label: truncate(t.title || AISA.i18n.t('标签页'), 18),
        text: t.summary || '',
        meta: { url: t.url, title: t.title }
      };
    } else if (it.kind === 'history') {
      // 具体某条历史
      if (!it.text) { showToast(AISA.i18n.t('该历史为空')); return; }
      ref = {
        kind: 'history',
        label: AISA.i18n.t('剪贴板历史'),
        text: it.text,
        source: it.source || ''
      };
    }
    if (ref) {
      insertChip(ref);
      showToast(AISA.i18n.t('已引用 ') + ref.label);
    }
  }

  function reinsertAt() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const offset = range.startOffset;
    node.textContent = node.textContent.slice(0, offset) + '@' + node.textContent.slice(offset);
    const r = document.createRange();
    r.setStart(node, offset + 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ---------- 数据拉取（经 background / content script）----------
  // 获取"被引用目标"所在的 tab：侧边栏与某个 tab 绑定（sidePanel.open 时）。
  // 简化：取当前窗口的活动 tab 作为"当前页面/选中"的来源。
  function activeTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
    });
  }
  async function currentTitle() {
    const t = await activeTab();
    return t ? t.title : '';
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        if (chrome.runtime.lastError) {
          // content script 可能未注入（如 chrome:// 页面、PDF），返回失败
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false });
      });
    });
  }

  async function fetchSelection() {
    const t = await activeTab();
    if (!t || !t.id) return '';
    const resp = await sendToTab(t.id, { type: 'AISA_GET_SELECTION' });
    return resp && resp.text ? resp.text : '';
  }

  async function fetchPage() {
    const t = await activeTab();
    if (!t || !t.id) return null;
    const resp = await sendToTab(t.id, { type: 'AISA_GET_PAGE_DATA', maxLength: 12000 });
    return resp && resp.ok ? resp.data : null;
  }

  async function fetchTabText(tabId) {
    // 经 background 转发，避免 sidepanel 直接收不到响应
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'AISA_SEND_TO_TAB', tabId: tabId, message: { type: 'AISA_GET_TAB_TEXT' } },
        (resp) => resolve(resp || { ok: false })
      );
    });
  }

  async function fetchTabs() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'AISA_QUERY_TABS' }, (resp) => {
        resolve(resp && resp.ok ? resp.tabs : []);
      });
    });
  }

  // 顶部 quote-bar（可编辑）的实时文本：经 sidepanel.js 暴露的接口读取
  function fetchQuoteText() {
    return (window.AISA && window.AISA.getQuoteText) ? window.AISA.getQuoteText() : '';
  }
  function fetchQuoteSource() {
    // sidepanel 未单独暴露 source，这里简化为空（引用块里仍会展示文本本身）
    return '';
  }

  // 剪贴板历史：直接读 chrome.storage（sidepanel 上下文可用），无需跨域
  async function fetchHistory() {
    try {
      const list = await storage.getHistory();
      // 取最近 30 条，去掉完全相同的重复
      const seen = new Set();
      const out = [];
      for (const h of list) {
        const key = (h.text || '').trim();
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h);
        if (out.length >= 30) break;
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  // ---------- 序列化编辑器为纯文本（芯片展开为引用块）----------
  function serializeEditor() {
    let out = '';
    editor.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') {
          out += '\n';
        } else if (node.classList.contains('cmp-chip')) {
          const refId = node.getAttribute('data-ref');
          const ref = refs.get(refId);
          if (ref) {
            if (ref.kind === 'prompt') {
              if (out && !out.endsWith('\n')) out += ' ';
              out += ref.text;
              if (!out.endsWith('\n')) out += ' ';
            } else {
              out += `\n"""${ref.label}\n${ref.text}\n"""\n`;
            }
          }
        } else {
          out += node.textContent;
          if (tag === 'div' || tag === 'p') out += '\n';
        }
      }
    });
    return out.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function updateStats() {
    const text = serializeEditor();
    const len = text.length;
    statsEl.textContent = len >= 1000 ? (len / 1000).toFixed(1) + AISA.i18n.t('k 字') : len + AISA.i18n.t(' 字');
  }

  // ---------- 快捷添加模板面板 ----------
  const qaModal = document.getElementById('cmp-quick-add-modal');
  const qaTrigger = document.getElementById('qa-trigger');
  const qaContent = document.getElementById('qa-content');

  document.getElementById('cmp-quick-add').addEventListener('click', () => {
    const text = serializeEditor();
    qaContent.value = text;
    qaTrigger.value = '';
    qaModal.classList.remove('hidden');
    qaTrigger.focus();
  });

  document.getElementById('qa-cancel').addEventListener('click', () => {
    qaModal.classList.add('hidden');
  });

  document.getElementById('qa-confirm').addEventListener('click', async () => {
    const trigger = qaTrigger.value.trim();
    const content = qaContent.value.trim();
    if (!trigger || !content) {
      showToast(AISA.i18n.t('标志和内容不能为空'), 2000);
      return;
    }
    if (prompts.find((p) => p.trigger === trigger)) {
      showToast(AISA.i18n.t('标志已存在'), 2000);
      return;
    }
    prompts.push({ trigger, content });
    await storage.savePrompts(prompts);
    qaModal.classList.add('hidden');
    showToast(AISA.i18n.t('模板保存成功！'), 2000);
  });

  // +引用：取顶部 quote-bar（可编辑）的当前内容
  document.getElementById('cmp-add-quote').addEventListener('click', async () => {
    focusEditorAtEnd();
    const text = fetchQuoteText();
    if (!text) { showToast(AISA.i18n.t('顶部没有引用，先在网页选中文字点"发到侧边栏"，或直接在上方输入')); return; }
    insertChip({ kind: 'quote', label: AISA.i18n.t('已选引用'), text: text, source: fetchQuoteSource() });
    showToast(AISA.i18n.t('已引用顶部内容'));
  });

  document.getElementById('cmp-add-selection').addEventListener('click', async () => {
    focusEditorAtEnd();
    const text = await fetchSelection();
    if (!text) { showToast(AISA.i18n.t('当前网页没有选中文字')); return; }
    const title = await currentTitle();
    insertChip({ kind: 'selection', label: AISA.i18n.t('当前选中'), text: text, source: title });
    showToast(AISA.i18n.t('已引用当前选中'));
  });

  document.getElementById('cmp-add-page').addEventListener('click', async () => {
    focusEditorAtEnd();
    const data = await fetchPage();
    if (!data || !data.content) { showToast(AISA.i18n.t('无法提取当前页面正文')); return; }
    insertChip({
      kind: 'page',
      label: truncate(data.title || AISA.i18n.t('当前页面'), 18),
      text: data.content,
      meta: { url: data.url, title: data.title, truncated: data.truncated }
    });
    showToast(AISA.i18n.t('已引用当前页面'));
  });

  document.getElementById('cmp-clear').addEventListener('click', () => {
    editor.innerHTML = '';
    refs.clear();
    updateStats();
  });

  document.getElementById('cmp-copy').addEventListener('click', async () => {
    const text = serializeEditor();
    if (!text) { showToast(AISA.i18n.t('内容为空')); return; }
    const ok = await clipboard.copyText(text);
    if (ok) {
      showToast(AISA.i18n.t('已复制！点 AI 输入框按 Ctrl+V 粘贴'), 3500);
      // 同时记入历史
      try { await storage.addHistoryItem(text, AISA.i18n.t('提示词组装')); } catch (e) {}
    } else {
      showToast(AISA.i18n.t('复制失败'));
    }
  });

  // ---------- 编辑器事件 ----------
  editor.addEventListener('input', async () => {
    updateStats();
    const ctx = getAtContext();
    if (ctx) {
      if (ctx.triggerChar === '/') {
        renderPromptMenu(ctx);
      } else {
        // 首次打开，不预加载 tabs（避免每次都查）；用户输入 @ 后按需展开
        renderAtMenu(ctx, null);
      }
    } else {
      hideAtMenu();
    }
  });

  editor.addEventListener('keydown', (e) => {
    const menuOpen = !atMenu.classList.contains('hidden');
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = activeRow();
        if (row) row.click();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideAtMenu(); return; }
    }
  });

  // 点击外部关闭菜单
  document.addEventListener('mousedown', (e) => {
    if (!atMenu.classList.contains('hidden') && !atMenu.contains(e.target) && e.target !== editor) {
      hideAtMenu();
    }
  });

  // 窗口/侧边栏尺寸变化时，若菜单正打开则重新定位，防止错位
  window.addEventListener('resize', () => {
    if (!atMenu.classList.contains('hidden')) positionAtMenu();
  });

  // ---------- 工具：转义 / 截断 ----------
  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function shortUrl(u) {
    try {
      const url = new URL(u);
      return url.hostname + (url.pathname === '/' ? '' : url.pathname.slice(0, 20));
    } catch (e) { return ''; }
  }
  function getIconForKind(k) {
    if (k === 'selection') return '📄';
    if (k === 'page') return '🌐';
    if (k === 'quote') return '💬';
    if (k === 'prompt') return '✨';
    return '🔗';
  }
  function fmtTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const pad = (n) => (n < 10 ? '0' + n : n);
      if (sameDay) return AISA.i18n.t('今天 ') + pad(d.getHours()) + ':' + pad(d.getMinutes());
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  // 暴露给外部（sidepanel.js / background 转发的消息）调用的接口
  window.AISA = window.AISA || {};
  window.AISA.initComposer = async function () {
    await AISA.i18n.init();
    AISA.i18n.applyToDOM();
    updateStats();
    prompts = (await storage.getPrompts()) || [];
  };
  
  // 监听设置更新重新拉取 prompts
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'AISA_SETTINGS_CHANGED') {
      storage.getPrompts().then(p => prompts = p || []);
    }
  });
  // 外部插入一条引用（如网页浮动按钮"加到组装"）
  // ref: { label, text, source }
  window.AISA.addRefToComposer = function (ref) {
    if (!ref || !ref.text) return false;
    focusEditorAtEnd();
    insertChip({
      kind: ref.kind || 'external',
      label: ref.label || AISA.i18n.t('引用'),
      text: ref.text,
      source: ref.source || ''
    });
    showToast(AISA.i18n.t('已加到提示词组装'));
    return true;
  };
  // 当前组装区芯片数量（供折叠条摘要显示）
  window.AISA.getComposerChipCount = function () {
    return editor.querySelectorAll('.cmp-chip[data-ref]').length;
  };
})();
