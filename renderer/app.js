'use strict';

const q = window.qiming;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state = null;
let remote = null;         // { latest, versions }
let dlFilter = 'release';
let installTarget = null;  // versionId
let installLoader = 'vanilla';
let consoleOpen = false;
let running = false;

/* ---------------- 工具 ---------------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function typeTag(type) {
  if (type === 'release') return '<span class="tag rel">正式</span>';
  if (type === 'snapshot') return '<span class="tag snap">快照</span>';
  if (type === 'old_beta' || type === 'old_alpha') return '<span class="tag old">远古</span>';
  return `<span class="tag mod">${esc(type || '未知')}</span>`;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

function log(entry) {
  const body = $('#consoleBody');
  const div = document.createElement('div');
  div.className = entry.level || '';
  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  div.textContent = `[${stamp}] ${entry.text}`;
  body.appendChild(div);
  while (body.children.length > 800) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

const feedItems = [];
function feed(text, kind = '') {
  feedItems.unshift({ text, kind, at: Date.now() });
  if (feedItems.length > 8) feedItems.pop();
  const ul = $('#feed');
  ul.innerHTML = feedItems.map((i) => `<li class="${i.kind}">${esc(i.text)}</li>`).join('');
}

/* ---------------- 状态渲染 ---------------- */

function installedList() {
  return (state && state.installed) || [];
}

function currentVersionId() {
  const cfg = state.config;
  const list = installedList();
  const ids = list.map((v) => v.id);
  if (cfg.selectedVersion && ids.includes(cfg.selectedVersion)) return cfg.selectedVersion;
  if (cfg.lastPlayed && ids.includes(cfg.lastPlayed)) return cfg.lastPlayed;
  const rel = list.find((v) => v.type === 'release');
  return (rel || list[0] || {}).id || '';
}

function renderQuickVers(list, cur) {
  const qv = $('#quickVers');
  if (!qv) return;
  if (!list.length) {
    qv.innerHTML = '<span class="muted" style="font-size:12px">还没有安装版本</span>';
    return;
  }
  qv.innerHTML = list
    .slice(0, 8)
    .map((v) => `<button class="qv${v.id === cur ? ' on' : ''}" data-id="${esc(v.id)}" title="${esc(v.id)}">${esc(v.id)}</button>`)
    .join('');
}

function renderHome() {
  const cfg = state.config;
  $('#username').value = cfg.username || '';
  const sel = $('#versionSelect');
  const list = installedList();
  const cur = currentVersionId();
  if (!list.length) {
    sel.innerHTML = '<option value="">（尚未安装版本）</option>';
  } else {
    sel.innerHTML = list
      .map((v) => `<option value="${esc(v.id)}"${v.id === cur ? ' selected' : ''}>${esc(v.id)}</option>`)
      .join('');
  }
  renderQuickVers(list, cur);

  const java = (state.java || [])[0];
  const pill = $('#javaPill');
  if (java) {
    pill.textContent = `Java ${java.major}`;
    pill.className = 'pill ok';
  } else {
    pill.textContent = 'Java 未检测到';
    pill.className = 'pill bad';
  }
  $('#memPill').textContent = `${cfg.memoryMB} MB`;
  $('#infoJava').textContent = java ? `${java.version}（${java.vendor}）` : '未检测到，启动时自动下载';
  $('#infoMem').textContent = `${cfg.memoryMB} MB`;
  $('#infoOs').textContent = `${state.platform === 'darwin' ? 'macOS' : state.platform === 'win32' ? 'Windows' : 'Linux'} · ${state.arch || ''}`;
  $('#infoCount').textContent = String(list.length);

  const btn = $('#btnLaunch');
  const hint = $('#launchHint');
  if (running) {
    btn.disabled = true;
    $('.btn-launch-label').textContent = '运行中';
    hint.textContent = '游戏已启动';
  } else if (!list.length) {
    btn.disabled = false;
    $('.btn-launch-label').textContent = '去下载版本';
    hint.textContent = '还没有安装任何版本';
  } else {
    btn.disabled = false;
    $('.btn-launch-label').textContent = '启动游戏';
    const v = list.find((x) => x.id === currentVersionId());
    hint.textContent = v ? `${v.id} · 离线模式` : '选择一个版本';
  }
}

function renderVersions() {
  const list = installedList();
  $('#verSub').textContent = `${state.config.gameDir} · ${list.length} 个版本`;
  const box = $('#verList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">本地还没有版本，去「下载」页装一个吧</div>';
    return;
  }
  const cur = currentVersionId();
  box.innerHTML = list
    .map(
      (v) => `
      <div class="row" data-id="${esc(v.id)}">
        <div class="row-main">
          <div class="row-title">${esc(v.id)}${v.id === cur ? ' <span class="tag rel">当前</span>' : ''}${v.inheritsFrom ? '<span class="tag mod">加载器</span>' : ''}</div>
          <div class="row-sub">
            ${typeTag(v.type)}
            <span>${fmtDate(v.releaseTime)}</span>
            ${v.javaVersion ? `<span>Java ${v.javaVersion}+</span>` : ''}
            ${v.jarOk ? '' : '<span style="color:#ffb454">客户端 jar 缺失</span>'}
          </div>
        </div>
        <div class="row-actions">
          <button class="row-btn primary" data-act="launch">启动</button>
          <button class="row-btn" data-act="folder">目录</button>
          <button class="row-btn danger" data-act="delete">删除</button>
        </div>
      </div>`
    )
    .join('');
}

function renderSettings() {
  const cfg = state.config;
  $('#setGameDir').value = cfg.gameDir || '';
  $('#setUsername').value = cfg.username || '';
  $('#setMem').value = cfg.memoryMB;
  $('#setMemOut').value = `${cfg.memoryMB} MB`;
  $('#setJava').value = cfg.javaPath || '';
  $('#setW').value = cfg.width;
  $('#setH').value = cfg.height;
  $('#setFull').checked = !!cfg.fullscreen;
  $('#setJvm').value = cfg.extraJvm || '';
  renderJavaList();
}

function renderJavaList() {
  const box = $('#javaList');
  const list = state.java || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:18px 0">未检测到 Java，启动时会自动下载</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (j) => `<div class="java-row">
        <span class="jv">Java ${j.major}</span>
        <span class="jp" title="${esc(j.path)}">${esc(j.path)}</span>
      </div>`
    )
    .join('');
}

async function renderAbout() {
  const info = await q.appInfo();
  $('#appVer').textContent = `v${info.version}`;
  $('#aboutMeta').innerHTML = [
    `Electron ${info.electron}`,
    `Chromium ${info.chrome}`,
    `Node ${info.node}`,
    `${info.platform} / ${info.arch}`,
    `配置目录 ${info.userData}`,
  ]
    .map((t) => `<span>${esc(t)}</span>`)
    .join('');
}

async function renderAll() {
  renderHome();
  renderVersions();
  renderSettings();
}

/* ---------------- 下载页 ---------------- */

async function loadRemote(force = false) {
  const box = $('#dlList');
  if (!remote || force) {
    box.innerHTML = '<div class="empty">正在获取版本清单…</div>';
    try {
      remote = await q.remoteVersions(force);
      $('#dlSub').textContent = `共 ${remote.versions.length} 个版本 · 最新正式版 ${remote.latest.release}`;
    } catch (e) {
      box.innerHTML = `<div class="empty">获取失败：${esc(e.message || e)}</div>`;
      return;
    }
  }
  renderDownload();
}

function filteredRemote() {
  if (!remote) return [];
  const kw = $('#dlSearch').value.trim().toLowerCase();
  return remote.versions.filter((v) => {
    if (dlFilter === 'release' && v.type !== 'release') return false;
    if (dlFilter === 'snapshot' && v.type !== 'snapshot') return false;
    if (dlFilter === 'old' && !['old_beta', 'old_alpha'].includes(v.type)) return false;
    if (kw && !v.id.toLowerCase().includes(kw)) return false;
    return true;
  });
}

function renderDownload() {
  const box = $('#dlList');
  const list = filteredRemote();
  if (!list.length) {
    box.innerHTML = '<div class="empty">没有匹配的版本</div>';
    return;
  }
  const installedIds = new Set(installedList().map((v) => v.id));
  const shown = list.slice(0, 120);
  box.innerHTML =
    shown
      .map(
        (v) => `
      <div class="row" data-id="${esc(v.id)}">
        <div class="row-main">
          <div class="row-title">${esc(v.id)} ${installedIds.has(v.id) ? '<span class="tag rel">已安装</span>' : ''}</div>
          <div class="row-sub">${typeTag(v.type)}<span>${fmtDate(v.releaseTime)}</span></div>
        </div>
        <div class="row-actions always">
          <button class="row-btn primary" data-act="install">安装</button>
        </div>
      </div>`
      )
      .join('') +
    (list.length > shown.length ? `<div class="empty">还有 ${list.length - shown.length} 个版本，用搜索缩小范围</div>` : '');
}

/* ---------------- 安装弹窗 ---------------- */

function openInstallModal(versionId) {
  installTarget = versionId;
  installLoader = 'vanilla';
  $('#modalVer').innerHTML = `准备安装 <b>${esc(versionId)}</b>`;
  $$('#loaderPick .loader').forEach((b) => b.classList.toggle('active', b.dataset.loader === 'vanilla'));
  $('#modalMask').hidden = false;
}

function closeInstallModal() {
  $('#modalMask').hidden = true;
  installTarget = null;
}

async function doInstall() {
  if (!installTarget) return;
  const id = installTarget;
  const loader = installLoader;
  $('#modalInstall').disabled = true;
  closeInstallModal();
  showTask('准备安装…');
  log({ level: 'info', text: `开始安装 ${id}（${loader}）` });
  const res = await q.install({ versionId: id, loader });
  $('#modalInstall').disabled = false;
  if (!res.ok) {
    toast(`安装失败：${res.error}`, 'err');
    log({ level: 'error', text: `安装失败：${res.error}` });
    hideTask();
    return;
  }
  toast(`${res.versionId} 安装完成`, 'ok');
  feed(`${res.versionId} 安装完成`);
  log({ level: 'ok', text: `安装完成：${res.versionId}` });
  setTimeout(hideTask, 1500);
  await refreshState();
}

/* ---------------- 任务条 ---------------- */

let taskTimer = null;
function showTask(label) {
  clearTimeout(taskTimer);
  $('#taskbar').hidden = false;
  $('#taskLabel').textContent = label;
  $('#taskPct').textContent = '0%';
  $('#taskBar').style.width = '0%';
  $('#taskMeta').textContent = '';
  $('#statusDot').classList.add('busy');
}
function hideTask() {
  taskTimer = setTimeout(() => {
    $('#taskbar').hidden = true;
    $('#statusDot').classList.remove('busy');
  }, 800);
}
function updateTask(p) {
  if (!p) return;
  $('#taskbar').hidden = false;
  if (p.label) $('#taskLabel').textContent = p.label;
  const pct = Math.max(0, Math.min(100, Math.round((p.percent || 0) * 100)));
  $('#taskPct').textContent = `${pct}%`;
  $('#taskBar').style.width = `${pct}%`;
  const bits = [];
  if (p.files && p.files.total) bits.push(`${p.files.done}/${p.files.total} 个文件`);
  if (p.totalBytes) bits.push(`${fmtBytes(p.bytes || 0)} / ${fmtBytes(p.totalBytes)}`);
  $('#taskMeta').textContent = bits.join(' · ');
}

/* ---------------- 主流程 ---------------- */

async function refreshState() {
  state = await q.state();
  running = !!state.running;
  await renderAll();
}

async function doLaunch(versionId) {
  const id = versionId || currentVersionId();
  if (!id) {
    go('download');
    toast('请先安装一个版本', 'err');
    return;
  }
  $('#btnLaunch').disabled = true;
  running = true;
  renderHome();
  showTask('准备启动…');
  log({ level: 'info', text: `准备启动 ${id}…` });
  const res = await q.launch({ versionId: id });
  if (!res.ok) {
    running = false;
    renderHome();
    toast(`启动失败：${res.error}`, 'err');
    log({ level: 'error', text: `启动失败：${res.error}` });
    hideTask();
    return;
  }
  feed(`${id} 已启动`);
  toast('游戏已启动', 'ok');
  setTimeout(() => {
    hideTask();
    if (state.config.closeOnLaunch) q.windowControl('minimize');
  }, 1200);
}

function go(page) {
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('hidden', p.id !== `page-${page}`));
  const titles = { home: '首页', download: '下载', mods: '模组', versions: '版本', settings: '设置', about: '关于' };
  $('#pageTitle').textContent = titles[page] || page;
  if (page === 'download') loadRemote();
  if (page === 'about') renderAbout();
  if (page === 'settings') renderSettings();
  if (page === 'versions') renderVersions();
  if (page === 'mods') loadMods();
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('#railNav').addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-btn');
    if (btn) go(btn.dataset.page);
  });

  $('#username').addEventListener(
    'input',
    debounce(async (e) => {
      state.config = await q.setConfig({ username: e.target.value.trim() || 'Steve' });
    }, 500)
  );

  $('#versionSelect').addEventListener('change', async (e) => {
    state.config = await q.setConfig({ selectedVersion: e.target.value });
    renderHome();
  });

  $('#quickVers').addEventListener('click', async (e) => {
    const b = e.target.closest('.qv');
    if (!b) return;
    state.config = await q.setConfig({ selectedVersion: b.dataset.id });
    renderHome();
  });

  $('#btnLaunch').addEventListener('click', () => doLaunch());
  $('#btnOpenGame').addEventListener('click', () => q.openFolder('game'));
  $$('#page-home [data-folder]').forEach((b) => b.addEventListener('click', () => q.openFolder(b.dataset.folder)));

  $('#dlChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    dlFilter = chip.dataset.filter;
    $$('#dlChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderDownload();
  });
  $('#dlSearch').addEventListener('input', debounce(renderDownload, 200));
  $('#btnRefreshList').addEventListener('click', () => loadRemote(true));
  $('#btnGoDownload').addEventListener('click', () => go('download'));
  $('#btnOpenVersions').addEventListener('click', () => q.openFolder('versions'));

  $('#dlList').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    openInstallModal(row.dataset.id);
  });

  $('#verList').addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const act = e.target.closest('[data-act]');
    const id = row.dataset.id;
    if (!act) {
      await q.setConfig({ selectedVersion: id });
      go('home');
      return;
    }
    if (act.dataset.act === 'launch') doLaunch(id);
    if (act.dataset.act === 'folder') q.openFolder(`abs:${state.config.gameDir}/versions/${id}`);
    if (act.dataset.act === 'delete') {
      if (!confirm(`确定删除版本 ${id}？该目录下所有文件都会被移除。`)) return;
      const r = await q.deleteVersion({ versionId: id });
      if (r.ok) {
        toast(`${id} 已删除`, 'ok');
        feed(`${id} 已删除`);
        await refreshState();
      } else toast(`删除失败：${r.error}`, 'err');
    }
  });

  // 设置
  const commit = (patch) => q.setConfig(patch).then((cfg) => {
    state.config = cfg;
    renderHome();
    state.java && renderJavaList();
  });

  $('#setGameDir').addEventListener('change', (e) => commit({ gameDir: e.target.value.trim() }));
  $('#setUsername').addEventListener('change', (e) => commit({ username: e.target.value.trim() || 'Steve' }));
  $('#setMem').addEventListener('input', (e) => {
    $('#setMemOut').value = `${e.target.value} MB`;
    $('#memPill').textContent = `${e.target.value} MB`;
  });
  $('#setMem').addEventListener('change', (e) => commit({ memoryMB: Number(e.target.value) }));
  $('#setJava').addEventListener('change', (e) => commit({ javaPath: e.target.value.trim() }));
  $('#setW').addEventListener('change', (e) => commit({ width: Number(e.target.value) || 854 }));
  $('#setH').addEventListener('change', (e) => commit({ height: Number(e.target.value) || 480 }));
  $('#setFull').addEventListener('change', (e) => commit({ fullscreen: e.target.checked }));
  $('#setJvm').addEventListener('change', (e) => commit({ extraJvm: e.target.value }));

  $$('[data-pick]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const p = await q.pickDir(btn.dataset.pick);
      if (!p) return;
      if (btn.dataset.pick === 'game') {
        $('#setGameDir').value = p;
        await commit({ gameDir: p });
        state = await q.state();
        await renderAll();
        toast('游戏目录已切换', 'ok');
      } else {
        $('#setJava').value = p;
        await commit({ javaPath: p });
        state = await q.state();
        await renderAll();
        toast('Java 路径已设置', 'ok');
      }
    })
  );
  $('#btnAutoJava').addEventListener('click', async () => {
    $('#setJava').value = '';
    await commit({ javaPath: '' });
    state = await q.state();
    await renderAll();
    toast('已切换为自动探测', 'ok');
  });
  $('#btnRedetect').addEventListener('click', async () => {
    await q.detectJava();
    state = await q.state();
    await renderAll();
    toast('已重新检测', 'ok');
  });

  // 窗口控制
  $('#winControls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (b) q.windowControl(b.dataset.w);
  });

  // 控制台
  const toggleConsole = () => {
    consoleOpen = !consoleOpen;
    $('#console').classList.toggle('open', consoleOpen);
    $('#btnToggleLog').textContent = consoleOpen ? '收起' : '展开';
  };
  $('#consoleHead').addEventListener('click', (e) => {
    if (e.target.id === 'btnClearLog') return;
    toggleConsole();
  });
  $('#btnToggleLog').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleConsole();
  });
  $('#btnClearLog').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#consoleBody').innerHTML = '';
  });

  // 弹窗
  $('#modalClose').addEventListener('click', closeInstallModal);
  $('#modalCancel').addEventListener('click', closeInstallModal);
  $('#modalMask').addEventListener('click', (e) => {
    if (e.target.id === 'modalMask') closeInstallModal();
  });
  $('#loaderPick').addEventListener('click', (e) => {
    const b = e.target.closest('.loader');
    if (!b) return;
    installLoader = b.dataset.loader;
    $$('#loaderPick .loader').forEach((x) => x.classList.toggle('active', x === b));
  });
  $('#modalInstall').addEventListener('click', doInstall);

  // 主进程事件
  q.on('state', (s) => {
    state = s;
    running = !!s.running;
    renderHome();
    renderVersions();
    renderJavaList();
  });
  q.on('progress', (p) => updateTask(p));
  q.on('log', (entry) => {
    log(entry);
    if (entry.level === 'error') $('#consoleDot').classList.add('on');
  });
  q.on('launch:start', () => {
    running = true;
    showTask('启动中…');
    renderHome();
  });
  q.on('launch:exit', async ({ code, error }) => {
    running = false;
    hideTask();
    if (code === 0) {
      feed('游戏正常退出');
      toast('游戏已退出', 'ok');
    } else {
      feed(error ? `启动失败：${error}` : `游戏异常退出（${code}）`, 'err');
      if (error) toast(error, 'err');
    }
    await refreshState();
  });
  q.on('install:done', () => {});
  q.on('toast', (t) => toast(t.text, t.kind));
  // 开发自检用：由主进程触发一次真实启动
  q.on('dev', (d) => {
    if (d && d.action === 'launch') {
      go('home');
      doLaunch(d.versionId);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modalMask').hidden) closeInstallModal();
  });
}


/* ---------------- 模组页 ---------------- */

const modsState = { tab: 'local', query: '', results: null, local: [], mcVersion: '', busy: null };

function fmtNum(n) {
  if (!n && n !== 0) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(0) + ' 万';
  return String(n);
}

function modsRow(html) {
  return `<div class="row">${html}</div>`;
}

function renderModsLocal() {
  const box = $('#modsList');
  const list = modsState.local || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty">这个版本还没装模组。去「在线搜索」找一个，或者导入本地 jar。</div>';
    return;
  }
  box.innerHTML = list
    .map((m) => {
      const tags = [];
      if (!m.enabled) tags.push('<span class="tag old">已禁用</span>');
      if (!m.compatible) tags.push('<span class="tag bad">与当前版本不符</span>');
      return modsRow(`
      <div class="row-main">
        <div class="row-title">${esc(m.name)} ${m.version ? `<span class="tag mod">${esc(m.version)}</span>` : ''} ${tags.join(' ')}</div>
        <div class="row-sub">
          <span>${esc(m.file)}</span>
          ${m.range ? `<span>需要 MC ${esc(m.range)}</span>` : ''}
          <span>${(m.size / 1024).toFixed(0)} KB</span>
        </div>
      </div>
      <div class="row-actions always">
        <button class="row-btn" data-act="toggle" data-file="${esc(m.file)}" data-enable="${m.enabled ? '0' : '1'}">${m.enabled ? '禁用' : '启用'}</button>
        <button class="row-btn" data-act="remove" data-file="${esc(m.file)}">删除</button>
      </div>`);
    })
    .join('');
}

function renderModsBrowse() {
  const box = $('#modsList');
  const r = modsState.results;
  if (!r) {
    box.innerHTML = '<div class="empty">输入关键词搜索，结果只显示和你当前版本 + Fabric 兼容的模组。</div>';
    return;
  }
  if (!r.hits || !r.hits.length) {
    box.innerHTML = '<div class="empty">没有找到匹配的模组。</div>';
    return;
  }
  const installedIds = new Set((modsState.local || []).map((m) => m.id).filter(Boolean));
  box.innerHTML = r.hits
    .map((h) => {
      const has = installedIds.has(h.id);
      return modsRow(`
      <div class="row-main">
        <div class="row-title">${esc(h.title)} <span class="tag">${esc(h.author || '')}</span>${has ? '<span class="tag rel">已安装</span>' : ''}</div>
        <div class="row-sub"><span>${esc((h.description || '').slice(0, 90))}</span></div>
        <div class="row-sub"><span>↓ ${fmtNum(h.downloads)}</span><span>${esc(h.slug)}</span></div>
      </div>
      <div class="row-actions always">
        <button class="row-btn" data-act="install" data-id="${esc(h.id)}" data-title="${esc(h.title)}" ${modsState.busy === h.id ? 'disabled' : ''}>${modsState.busy === h.id ? '安装中…' : '安装'}</button>
      </div>`);
    })
    .join('');
}

function renderMods() {
  $('#modsChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.tab === modsState.tab));
  if (modsState.tab === 'local') renderModsLocal();
  else renderModsBrowse();
}

async function loadMods() {
  const box = $('#modsList');
  box.innerHTML = '<div class="empty">正在读取…</div>';
  const res = await q.modsList();
  if (!res || !res.ok) {
    box.innerHTML = `<div class="empty">${esc((res && res.error) || '读取失败')}</div>`;
    $('#modsSub').textContent = '需要先选一个已安装的版本';
    return;
  }
  modsState.local = res.list || [];
  modsState.mcVersion = res.mcVersion || '';
  $('#modsSub').textContent = `Minecraft ${modsState.mcVersion || '未知'} · Fabric · 已装 ${modsState.local.length} 个`;
  renderMods();
}

async function doModsSearch() {
  const q0 = ($('#modsSearch').value || '').trim();
  modsState.query = q0;
  if (!q0) { modsState.results = null; renderMods(); return; }
  $('#modsList').innerHTML = '<div class="empty">搜索中…</div>';
  const res = await q.modsSearch({ query: q0 });
  if (!res.ok) {
    $('#modsList').innerHTML = `<div class="empty">${esc(res.error || '搜索失败')}</div>`;
    return;
  }
  modsState.results = res;
  modsState.tab = 'browse';
  renderMods();
}

function bindMods() {
  $('#modsChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    modsState.tab = b.dataset.tab;
    if (modsState.tab === 'browse' && !modsState.results && modsState.query) doModsSearch();
    else renderMods();
  });

  $('#modsSearch').addEventListener('input', debounce(() => doModsSearch(), 600));

  $('#btnModsImport').addEventListener('click', async () => {
    const res = await q.modsImport();
    if (!res.ok) return toast(res.error || '导入失败', 'error');
    if (res.canceled) return;
    const okCount = (res.imported || []).length;
    const bad = (res.imported || []).filter((x) => !x.compatible);
    if (okCount) {
      toast(`已导入 ${okCount} 个模组${bad.length ? `，其中 ${bad.length} 个与当前版本不符` : ''}`, bad.length ? 'warn' : 'ok');
    } else {
      toast('没有导入任何文件', 'warn');
    }
    await loadMods();
  });

  $('#btnModsFolder').addEventListener('click', () => q.modsReveal());

  $('#modsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'toggle') {
      const res = await q.modsToggle({ file: btn.dataset.file, enable: btn.dataset.enable === '1' });
      if (!res.ok) toast(res.error || '操作失败', 'error');
      await loadMods();
    } else if (act === 'remove') {
      const name = btn.dataset.file;
      if (!confirm(`把「${name}」移到废纸篓？`)) return;
      const res = await q.modsRemove({ file: name });
      if (!res.ok) toast(res.error || '删除失败', 'error');
      else toast('已移到废纸篓', 'ok');
      await loadMods();
    } else if (act === 'install') {
      const id = btn.dataset.id;
      modsState.busy = id;
      renderMods();
      const res = await q.modsInstall({ id });
      modsState.busy = null;
      if (!res.ok) toast(res.error || '安装失败', 'error');
      else if ((res.installed || []).length) toast(`已安装 ${res.installed.map((x) => x.name).join('、')}`, 'ok');
      else if ((res.skipped || []).length) toast('该模组已安装或没有兼容版本', 'warn');
      await loadMods();
    }
  });

  q.on('mods:progress', (p) => {
    if (p && p.type === 'log' && p.text) log({ level: p.level || 'info', text: p.text });
  });
}

bindMods();

/* ---------------- 启动 ---------------- */

(async function main() {
  document.body.classList.toggle('mac', q.platform === 'darwin');
  if (q.platform !== 'darwin') $('#winControls').hidden = false;
  bind();
  try {
    state = await q.state();
    await renderAll();
    log({ level: 'ok', text: `启明 v${state.version} 已就绪 · 游戏目录 ${state.config.gameDir}` });
    if (!installedList().length) feed('还没有安装版本，去「下载」看看');
    const initial = (location.hash || '').replace('#', '');
    if (['home', 'download', 'mods', 'versions', 'settings', 'about'].includes(initial)) go(initial);
  } catch (e) {
    log({ level: 'error', text: `初始化失败：${e.message}` });
  }
})();
