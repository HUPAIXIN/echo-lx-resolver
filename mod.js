/*
 * LX 音源解析 (echo.lx-resolver) — renderer side.
 *
 * 在流媒体页工具栏的音质选择(.streaming-quality-select)旁边注入一个同模板的
 * "解析音源"下拉:本地 / 账号 / 自定义洛雪音源,列表最后一行是"添加音源"。
 * 音源项支持右键菜单(更新 / 编辑 / 删除)。
 */

const mod = echoExternalMod;
const manifest = mod.manifest || {};
const invoke = (method, payload) => mod.main.invoke(`lxResolver.${method}`, payload);
// main.invoke 的 HTTP 层返回 { ok, result },统一剥掉外层。
const unwrap = (response) => (response && typeof response === 'object' && 'result' in response ? response.result : response);
const toast = (message) => { try { mod.toast(message); } catch { /* noop */ } };

// ------------------------------------------------------------------- state

const state = {
  mode: 'local',
  sources: [],
  accounts: { netease: false, qqmusic: false },
  hookReady: false,
  menuOpen: false,
};

let refreshSeq = 0;
let stateEverLoaded = false;
const refreshState = async () => {
  const seq = ++refreshSeq;
  try {
    const next = unwrap(await invoke('getState'));
    if (seq !== refreshSeq) return;
    state.mode = next.mode || 'local';
    state.sources = Array.isArray(next.sources) ? next.sources : [];
    state.accounts = next.accounts || { netease: false, qqmusic: false };
    state.hookReady = Boolean(next.hookReady);
    stateEverLoaded = true;
    renderAnchorLabel();
    renderAnchorDot();
    mod.console?.log?.(`[lx-resolver] state ok: mode=${state.mode} sources=${state.sources.length}`);
  } catch (error) {
    mod.console?.warn?.(`[lx-resolver] getState failed: ${error?.message || error}`);
  }
};

// -------------------------------------------------------------------- css

mod.extend?.css?.('lx-resolver-styles', `
  /* 下拉按钮也挂在 body 上(fixed 跟随音质按钮定位),流媒体页重渲染不会带走它。 */
  .lx-resolve-anchor { position: fixed; z-index: 1400; display: flex; align-items: center; gap: 6px; }
  .lx-resolve-anchor .sort-button-label { max-width: 16em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 下拉面板挂在 body 上(fixed 定位),不受流媒体页重渲染影响;视觉沿用 sort-menu 模板。
     注意:不能写 top/left 的 !important,否则会覆盖 JS 设置的内联定位坐标。 */
  .sort-menu.lx-floating {
    position: fixed !important;
    z-index: 2147483000 !important;
    min-width: 264px; max-height: min(430px, 70vh); overflow-y: auto;
  }
  .lx-source-option { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 14px; text-align: left; }
  .lx-opt-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .lx-opt-name { font-size: 13px; font-weight: 600; color: inherit; }
  .lx-opt-desc { font-size: 11px; opacity: 0.62; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .lx-opt-check { font-size: 13px; opacity: 0.9; }
  .lx-opt-add { color: #7dd3fc; font-weight: 600; }
  .lx-menu-divider { height: 1px; margin: 6px 4px; background: rgba(255, 255, 255, 0.12); }
  .lx-opt-disabled { opacity: 0.45; cursor: not-allowed; }
  .lx-context-menu {
    position: fixed; z-index: 2147483600; min-width: 148px; padding: 6px;
    background: rgba(15, 23, 42, 0.96); backdrop-filter: blur(18px);
    border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column;
  }
  .lx-context-menu button {
    all: unset; cursor: pointer; padding: 8px 12px; border-radius: 8px;
    font-size: 12.5px; color: #e2e8f0; font-family: inherit;
  }
  .lx-context-menu button:hover { background: rgba(255, 255, 255, 0.1); }
  .lx-context-menu button.lx-danger:hover { background: rgba(248, 113, 113, 0.16); color: #fca5a5; }
  .streaming-state { max-width: 100%; overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
  .lx-anchor-dot {
    position: absolute; top: -4px; right: -4px; width: 9px; height: 9px; border-radius: 50%;
    background: #f87171; box-shadow: 0 0 7px rgba(248, 113, 113, 0.85); border: 1px solid rgba(15, 23, 42, 0.9);
  }
  .lx-opt-name-row { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .lx-update-dot { width: 7px; height: 7px; border-radius: 50%; background: #f87171; flex: none; box-shadow: 0 0 5px rgba(248, 113, 113, 0.8); }
  .lx-search-clear:hover { opacity: 1; color: #fca5a5; }
  .lx-modal-overlay {
    position: fixed; inset: 0; z-index: 2147483700; display: flex; align-items: center; justify-content: center;
    background: rgba(2, 6, 23, 0.62); backdrop-filter: blur(6px);
  }
  .lx-modal {
    width: min(480px, calc(100vw - 48px)); padding: 22px 24px;
    background: rgba(15, 23, 42, 0.97); border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 16px; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    display: flex; flex-direction: column; gap: 12px; color: #e2e8f0;
    font-family: inherit;
  }
  .lx-modal h3 { all: unset; font-size: 16px; font-weight: 700; color: #f1f5f9; }
  .lx-modal .lx-hint { font-size: 12px; opacity: 0.66; line-height: 1.5; }
  .lx-modal input[type="text"] {
    all: unset; box-sizing: border-box; width: 100%; padding: 10px 12px; border-radius: 10px;
    background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.14);
    font-size: 13px; color: #f1f5f9;
  }
  .lx-modal input[type="text"]:focus { border-color: rgba(125, 211, 252, 0.55); }
  .lx-modal .lx-or { display: flex; align-items: center; gap: 10px; font-size: 11px; opacity: 0.5; }
  .lx-modal .lx-or::before, .lx-modal .lx-or::after { content: ""; flex: 1; height: 1px; background: rgba(255, 255, 255, 0.14); }
  .lx-file-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
  .lx-file-row .lx-file-name { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lx-btn {
    all: unset; cursor: pointer; box-sizing: border-box; padding: 9px 16px; border-radius: 10px;
    font-size: 12.5px; font-weight: 600; text-align: center; font-family: inherit;
    background: rgba(255, 255, 255, 0.08); color: #e2e8f0; border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .lx-btn:hover { background: rgba(255, 255, 255, 0.13); }
  .lx-btn.lx-primary { background: #0ea5e9; border-color: transparent; color: #fff; }
  .lx-btn.lx-primary:hover { background: #38bdf8; }
  .lx-btn.lx-ghost { background: transparent; }
  .lx-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  .lx-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
  .lx-origin-line { font-size: 11px; opacity: 0.6; word-break: break-all; }
`);

// -------------------------------------------------------------------- util

const CHEVRON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const modeLabel = () => {
  if (state.mode === 'local') return '本地';
  if (state.mode === 'account') return '账号';
  if (state.mode.startsWith('lx:')) {
    const id = state.mode.slice(3);
    const source = state.sources.find((item) => item.id === id);
    return source ? source.name : '未知音源';
  }
  return '解析音源';
};


const platformSummary = (source) => {
  const names = { wy: '网易云', tx: 'Q Q', kw: '酷我', kg: '酷狗', mg: '咪咕', git: 'Git' };
  const list = Array.isArray(source.platforms) ? source.platforms : [];
  if (!list.length) return '洛雪音源';
  return list.map((key) => names[key] || key).join(' / ');
};

// ------------------------------------------------------------------ menu

let openMenuEl = null;

const closeMenus = () => {
  state.menuOpen = false;
  openMenuEl?.remove();
  openMenuEl = null;
  document.querySelectorAll('.lx-resolve-anchor').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  closeContextMenu();
};

const sourceOption = (source) => {
  const option = el('button', 'sort-option lx-source-option');
  option.type = 'button';
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', String(state.mode === `lx:${source.id}`));
  option.title = `${source.name}(${platformSummary(source)})\n右键:更新 / 编辑 / 删除`;
  const main = el('span', 'lx-opt-main');
  const nameRow = el('span', 'lx-opt-name-row');
  if (source.hasUpdate) {
    const dot = el('span', 'lx-update-dot');
    dot.title = '有可用的新版本';
    nameRow.append(dot);
  }
  nameRow.append(el('span', 'lx-opt-name', source.name));
  main.append(nameRow);
  const bits = [];
  if (source.author) bits.push(source.author);
  if (source.version) bits.push(`v${String(source.version).replace(/^v/u, '')}`);
  const desc = el('span', 'lx-opt-desc', bits.length ? `${platformSummary(source)} · ${bits.join(' · ')}` : platformSummary(source));
  main.append(desc);
  option.append(main);
  if (state.mode === `lx:${source.id}`) option.append(el('span', 'lx-opt-check', '✓'));
  option.addEventListener('click', () => void selectMode(`lx:${source.id}`));
  option.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event.clientX, event.clientY, source);
  });
  return option;
};

const buildMenu = (button) => {
  const menu = el('div', 'sort-menu lx-floating streaming-resolve-menu');
  menu.setAttribute('role', 'listbox');
  menu.dataset.state = 'open';

  const builtinOption = (key, name, desc, available, unavailableHint) => {
    const option = el('button', 'sort-option lx-source-option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(state.mode === key));
    const main = el('span', 'lx-opt-main');
    main.append(el('span', 'lx-opt-name', name));
    main.append(el('span', 'lx-opt-desc', available ? desc : unavailableHint));
    option.append(main);
    if (state.mode === key) option.append(el('span', 'lx-opt-check', '✓'));
    if (!available) option.classList.add('lx-opt-disabled');
    option.addEventListener('click', () => {
      if (!available) { toast(unavailableHint); return; }
      void selectMode(key);
    });
    return option;
  };

  menu.append(builtinOption('local', '本地', '公共解析 · 无需登录', true, ''));
  menu.append(builtinOption('account', '账号', '使用已登录账号解析', state.accounts.netease, '需要先登录网易云音乐账号'));

  menu.append(el('div', 'lx-menu-divider'));

  for (const source of state.sources) menu.append(sourceOption(source));

  const add = el('button', 'sort-option lx-opt-add', '＋ 添加音源…');
  add.type = 'button';
  add.addEventListener('click', () => { closeMenus(); openAddDialog(); });
  menu.append(add);

  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
  const topCandidate = rect.bottom + 6;
  const top = topCandidate + menuRect.height > window.innerHeight - 8
    ? Math.max(8, rect.top - menuRect.height - 6)
    : topCandidate;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  return menu;
};

let anchorBtn = null;

const buildAnchorButton = () => {
  const button = el('button', 'sort-button lx-resolve-anchor');
  button.type = 'button';
  button.title = '解析音源';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.append(el('span', 'sort-button-label', modeLabel()));
  const chevron = el('span');
  chevron.style.display = 'inline-flex';
  chevron.innerHTML = CHEVRON_SVG;
  button.append(chevron);
  const anchorDot = el('span', 'lx-anchor-dot');
  anchorDot.title = '有音源可更新';
  anchorDot.style.display = state.sources.some((item) => item.hasUpdate) ? '' : 'none';
  button.append(anchorDot);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = state.menuOpen && openMenuEl && openMenuEl.isConnected;
    closeMenus();
    if (!isOpen) {
      state.menuOpen = true;
      button.setAttribute('aria-expanded', 'true');
      openMenuEl = buildMenu(button);
      void refreshState().then(() => {
        if (state.menuOpen && openMenuEl && openMenuEl.isConnected) {
          openMenuEl.remove();
          openMenuEl = buildMenu(button);
        }
      });
    }
  });
  return button;
};

// 每次巡检把按钮对齐到音质选择旁边;不在流媒体页时隐藏。
const ensureAnchor = () => {
  // 菜单若被外部 DOM 清理带走,同步开关状态,避免按钮失灵。
  if (state.menuOpen && openMenuEl && !openMenuEl.isConnected) {
    state.menuOpen = false;
    openMenuEl = null;
  }
  const qualityBox = document.querySelector('.streaming-quality-select');
  if (!qualityBox || !qualityBox.isConnected) {
    if (anchorBtn) anchorBtn.style.display = 'none';
    return;
  }
  if (!anchorBtn || !anchorBtn.isConnected) {
    anchorBtn = buildAnchorButton();
    document.body.append(anchorBtn);
  }
  const rect = qualityBox.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    anchorBtn.style.display = 'none';
    return;
  }
  anchorBtn.style.display = '';
  anchorBtn.style.visibility = 'hidden';
  const width = anchorBtn.offsetWidth || 96;
  const height = anchorBtn.offsetHeight || 34;
  let left = rect.left - width - 8;
  if (left < 8) left = rect.right + 8;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  anchorBtn.style.left = `${left}px`;
  anchorBtn.style.top = `${Math.max(8, rect.top + rect.height / 2 - height / 2)}px`;
  anchorBtn.style.visibility = '';
  renderAnchorDot();
};

const renderAnchorLabel = () => {
  const label = anchorBtn?.querySelector('.sort-button-label');
  if (label) label.textContent = modeLabel();
};

const renderAnchorDot = () => {
  const dot = anchorBtn?.querySelector('.lx-anchor-dot');
  if (dot) dot.style.display = state.sources.some((item) => item.hasUpdate) ? '' : 'none';
};

const selectMode = async (mode) => {
  const previous = state.mode;
  try {
    const result = unwrap(await invoke('setMode', { mode }));
    state.mode = result?.mode || mode;
  } catch (error) {
    toast(`切换失败: ${error.message || error}`);
    state.mode = previous;
  }
  closeMenus();
  ensureAnchor();
  renderAnchorLabel();
  if (state.mode !== previous) toast(state.mode === 'local' ? '已切换到本地解析,下次播放生效' : state.mode === 'account' ? '已切换到账号解析,下次播放生效' : '已切换到自定义音源,下次播放生效');
};

// -------------------------------------------------------------- context menu

let contextMenu = null;

const closeContextMenu = () => {
  contextMenu?.remove();
  contextMenu = null;
};

const openContextMenu = (x, y, source) => {
  closeContextMenu();
  contextMenu = el('div', 'lx-context-menu');
  contextMenu.setAttribute('data-lx-id', source.id);

  const item = (label, className, handler) => {
    const button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', () => { closeContextMenu(); void handler(); });
    return button;
  };

  contextMenu.append(
    item('更新', '', async () => {
      toast(`正在检测「${source.name}」的更新…`);
      try {
        const result = unwrap(await invoke('updateSource', { id: source.id }));
        await refreshState();
        rerenderOpenMenu();
        renderAnchorDot();
        if (result?.updated) toast(result.message || `已更新「${result?.source?.name || source.name}」`);
        else if (result?.error) toast(`更新失败: ${result.error}`);
        else toast(result?.message || '已是最新版本');
      } catch (error) { toast(`更新失败: ${error.message || error}`); }
    }),
    item('编辑', '', () => openEditDialog(source)),
    item('删除', 'lx-danger', async () => {
      try {
        const result = unwrap(await invoke('deleteSource', { id: source.id }));
        if (result?.mode) state.mode = result.mode;
        await refreshState();
        rerenderOpenMenu();
        renderAnchorLabel();
        toast(`已删除「${source.name}」`);
      } catch (error) { toast(`删除失败: ${error.message || error}`); }
    }),
  );

  document.body.append(contextMenu);
  const rect = contextMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  contextMenu.style.left = `${Math.max(8, left)}px`;
  contextMenu.style.top = `${Math.max(8, top)}px`;
};

const rerenderOpenMenu = () => {
  if (!state.menuOpen) return;
  if (openMenuEl && openMenuEl.isConnected) {
    const button = anchorBtn && anchorBtn.isConnected ? anchorBtn : null;
    openMenuEl.remove();
    openMenuEl = button ? buildMenu(button) : null;
    if (!openMenuEl) state.menuOpen = false;
  }
};

// ------------------------------------------------------------------- modals

let overlay = null;

const closeModal = () => {
  overlay?.remove();
  overlay = null;
};

const buildModal = (title) => {
  closeModal();
  overlay = el('div', 'lx-modal-overlay');
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal(); });
  const panel = el('div', 'lx-modal');
  panel.append(el('h3', '', title));
  overlay.append(panel);
  document.body.append(overlay);
  return panel;
};

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result || '');
    resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
  };
  reader.onerror = () => reject(new Error('读取文件失败'));
  reader.readAsDataURL(file);
});

const openAddDialog = () => {
  const panel = buildModal('添加洛雪音源');
  panel.append(el('p', 'lx-hint', '支持洛雪(LX Music)音源:粘贴音源脚本直链 URL,或选择本地 JS / JSON / TXT 文件。两种方式二选一,同时填写时优先使用文件。'));

  const urlInput = el('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'https://…(音源脚本直链)';
  panel.append(urlInput);

  panel.append(el('div', 'lx-or', '或'));

  const fileRow = el('div', 'lx-file-row');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.js,.json,.txt,text/javascript,application/json,text/plain';
  fileInput.style.display = 'none';
  const pickButton = el('button', 'lx-btn lx-ghost', '选择文件…');
  const fileName = el('span', 'lx-file-name', '未选择文件');
  pickButton.type = 'button';
  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    fileName.textContent = fileInput.files?.[0]?.name || '未选择文件';
  });
  fileRow.append(pickButton, fileName, fileInput);
  panel.append(fileRow);

  const actions = el('div', 'lx-modal-actions');
  const cancel = el('button', 'lx-btn lx-ghost', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', closeModal);
  const submit = el('button', 'lx-btn lx-primary', '添加');
  submit.type = 'button';
  submit.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file && !urlInput.value.trim()) { toast('请填写 URL 或选择文件'); return; }
    submit.setAttribute('disabled', '');
    submit.textContent = '添加中…';
    try {
      if (file) {
        const dataBase64 = await fileToBase64(file);
        await invoke('addSource', { dataBase64, name: file.name, originPath: file.path || `选自本地:${file.name}` });
      } else {
        await invoke('addSource', { url: urlInput.value.trim() });
      }
      await refreshState();
      closeModal();
      toast('音源已添加,可在列表中选择');
    } catch (error) {
      toast(`添加失败: ${error.message || error}`);
      submit.removeAttribute('disabled');
      submit.textContent = '添加';
    }
  });
  actions.append(cancel, submit);
  panel.append(actions);
  urlInput.focus();
};

const openEditDialog = (source) => {
  const panel = buildModal(`编辑音源 — ${source.name}`);
  panel.append(el('p', 'lx-hint', '修改显示名称;也可以整体替换脚本内容——粘贴一个新的音源 URL(更新来源随之切换),或选择本地新文件。三者都不填则只保存名称。'));
  if (source.originUrl) panel.append(el('p', 'lx-origin-line', `当前来源:URL ${source.originUrl}`));
  else if (source.originPath) panel.append(el('p', 'lx-origin-line', `当前来源:本地文件 ${source.originPath}`));

  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = source.name || '';
  nameInput.placeholder = '音源显示名称';
  panel.append(nameInput);

  const urlInput = el('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'https://…(粘贴新的音源 URL,可选)';
  panel.append(urlInput);

  panel.append(el('div', 'lx-or', '或'));

  const fileRow = el('div', 'lx-file-row');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.js,.json,.txt,text/javascript,application/json,text/plain';
  fileInput.style.display = 'none';
  const pickButton = el('button', 'lx-btn lx-ghost', '选择新文件…');
  const fileName = el('span', 'lx-file-name', '保留现有脚本');
  pickButton.type = 'button';
  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    fileName.textContent = fileInput.files?.[0]?.name || '保留现有脚本';
  });
  fileRow.append(pickButton, fileName, fileInput);
  panel.append(fileRow);

  const actions = el('div', 'lx-modal-actions');
  const cancel = el('button', 'lx-btn lx-ghost', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', closeModal);
  const save = el('button', 'lx-btn lx-primary', '保存');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    const urlValue = urlInput.value.trim();
    if (!file && !urlValue && nameInput.value.trim() === (source.name || '')) { closeModal(); return; }
    save.setAttribute('disabled', '');
    save.textContent = '保存中…';
    try {
      const payload = { id: source.id, name: nameInput.value.trim() || source.name };
      if (file) {
        payload.dataBase64 = await fileToBase64(file);
        payload.originPath = file.path || `选自本地:${file.name}`;
      } else if (urlValue) {
        payload.url = urlValue;
      }
      await invoke('editSource', payload);
      await refreshState();
      closeModal();
      rerenderOpenMenu();
      renderAnchorLabel();
      renderAnchorDot();
      toast('音源已保存');
    } catch (error) {
      toast(`保存失败: ${error.message || error}`);
      save.removeAttribute('disabled');
      save.textContent = '保存';
    }
  });
  actions.append(cancel, save);
  panel.append(actions);
};

// ------------------------------------------------------------------ wiring

const onNativeEvent = (event) => {
  const detail = event.detail || {};
  if (detail.name !== 'lx-resolver') return;
  const kind = detail.payload?.event;
  if (kind === 'sources-changed' || kind === 'mode-changed') {
    void refreshState().then(() => {
      rerenderOpenMenu();
      renderAnchorLabel();
    });
  }
};

const onGlobalClick = (event) => {
  if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu();
  if (state.menuOpen && !event.target.closest?.('.lx-resolve-anchor, .sort-menu.lx-floating')) closeMenus();
};

const onWindowBlur = () => { closeMenus(); };

window.addEventListener('echo-native', onNativeEvent);
window.addEventListener('click', onGlobalClick, true);
window.addEventListener('blur', onWindowBlur);

void refreshState();
const watchdog = setInterval(() => {
  try { ensureAnchor(); } catch { /* noop */ }
  if (!stateEverLoaded) { void refreshState().catch(() => {}); }
}, 800);
ensureAnchor();

mod.console?.log?.(`[${manifest.name || 'lx-resolver'}] renderer ready`);

// 热重载/停用时由 loader 调用,避免旧实例的巡检与监听器残留。
return () => {
  clearInterval(watchdog);
  window.removeEventListener('echo-native', onNativeEvent);
  window.removeEventListener('click', onGlobalClick, true);
  window.removeEventListener('blur', onWindowBlur);
  closeMenus();
  closeModal();
  anchorBtn?.remove();
  anchorBtn = null;
};
