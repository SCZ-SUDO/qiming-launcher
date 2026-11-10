'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ver = require('./src/core/version');
const inst = require('./src/core/installer');
const javac = require('./src/core/java');
const launcher = require('./src/core/launcher');
const mods = require('./src/core/mods');
const mr = require('./src/core/modrinth');
const { Store } = require('./src/core/store');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

let win = null;
let store = null;
let busy = null; // { kind:'install'|'launch', versionId }
let gameChild = null;

app.setName('Qiming');
if (isWin) app.setAppUserModelId('com.wb.qiming');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(text, kind = 'info') {
  send('toast', { text, kind });
}

const throttled = (() => {
  let last = 0;
  let pending = null;
  return (payload) => {
    pending = payload;
    const now = Date.now();
    if (now - last > 120) {
      last = now;
      send('progress', pending);
    }
  };
})();

function createWindow() {
  const opts = {
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 660,
    show: false,
    backgroundColor: '#0a0e14',
    title: '启明',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  };
  if (isMac) {
    opts.titleBarStyle = 'hiddenInset';
    opts.trafficLightPosition = { x: 16, y: 20 };
    opts.vibrancy = undefined;
  } else {
    opts.frame = false;
  }

  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), process.env.QIMING_PAGE ? { hash: process.env.QIMING_PAGE } : undefined);
  win.once('ready-to-show', () => {
    win.show();
    // 开发自检：QIMING_AUTOLAUNCH=<版本号> 时自动触发一次真实启动
    if (process.env.QIMING_AUTOLAUNCH) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => send('dev', { action: 'launch', versionId: process.env.QIMING_AUTOLAUNCH }), 1200);
      });
    }
    // 开发自检：QIMING_SHOT=<path> 时自动截图并退出
    if (process.env.QIMING_SHOT) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          await fsp.writeFile(process.env.QIMING_SHOT, img.toPNG());
        } catch (e) {
          console.error(e);
        }
        app.quit();
      }, Number(process.env.QIMING_SHOT_DELAY || 2600));
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------------- 状态 ---------------- */

async function buildState() {
  const cfg = store.get();
  const root = cfg.gameDir;
  let installed = [];
  let java = [];
  try {
    installed = await inst.listInstalled(root);
  } catch {}
  try {
    java = await javac.detect({ runtimeRoots: [path.join(root, 'runtime'), cfg.runtimeRoot].filter(Boolean) });
  } catch {}
  if (store.get().javaPath) {
    const p = javac.probe(cfg.javaPath);
    if (p) java = [{ ...p, source: 'custom' }, ...java.filter((j) => j.path !== p.path)];
  }
  return {
    config: cfg,
    platform: process.platform,
    arch: process.arch,
    installed,
    java,
    version: app.getVersion(),
    busy,
    running: !!gameChild,
    home: os.homedir(),
  };
}

async function pushState() {
  send('state', await buildState());
}

/* ---------------- IPC ---------------- */

ipcMain.handle('state', async () => buildState());

ipcMain.handle('config:set', async (_e, patch) => {
  const before = store.get().gameDir;
  const cfg = await store.patch(patch || {});
  if (patch && patch.gameDir && patch.gameDir !== before) await fsp.mkdir(cfg.gameDir, { recursive: true }).catch(() => {});
  await pushState();
  return cfg;
});

ipcMain.handle('dir:pick', async (_e, kind) => {
  const props = { properties: ['openDirectory', 'createDirectory'] };
  if (kind === 'java') {
    props.properties = isMac ? ['openFile', 'openDirectory'] : ['openFile'];
    props.filters = [{ name: 'Java', extensions: isWin ? ['exe'] : ['*'] }];
  }
  const r = await dialog.showOpenDialog(win, {
    title: kind === 'java' ? '选择 java 可执行文件' : '选择游戏目录',
    defaultPath: store.get().gameDir,
    ...props,
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('folder:open', async (_e, target) => {
  const cfg = store.get();
  const map = {
    game: cfg.gameDir,
    versions: path.join(cfg.gameDir, 'versions'),
    mods: path.join(cfg.gameDir, 'mods'),
    saves: path.join(cfg.gameDir, 'saves'),
    logs: path.join(cfg.gameDir, 'logs'),
    assets: path.join(cfg.gameDir, 'assets'),
  };
  let dir = typeof target === 'string' && target.startsWith('abs:') ? target.slice(4) : map[target] || cfg.gameDir;
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('remote:versions', async (_e, force) => {
  const cfg = store.get();
  const mf = await ver.getManifest(cfg.gameDir, { force: !!force });
  return {
    latest: mf.latest,
    versions: (mf.versions || []).map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })),
  };
});

ipcMain.handle('install', async (_e, { versionId, loader }) => {
  if (busy) return { ok: false, error: '当前有任务正在进行' };
  busy = { kind: 'install', versionId };
  await pushState();
  const cfg = store.get();
  const root = cfg.gameDir;
  try {
    const mf = await ver.getManifest(root);
    const emit = (p) => throttled({ ...p, tag: 'install', versionId });
    let id = versionId;
    if (loader === 'fabric') {
      id = await inst.installFabric({ root, mcVersion: versionId, emit, manifest: mf });
    } else if (loader === 'quilt') {
      id = await inst.installQuilt({ root, mcVersion: versionId, emit, manifest: mf });
    } else {
      await inst.installVersion({ root, versionId, emit, manifest: mf });
    }
    await store.patch({ selectedVersion: id });
    busy = null;
    send('install:done', { ok: true, versionId: id });
    await pushState();
    return { ok: true, versionId: id };
  } catch (e) {
    busy = null;
    send('install:done', { ok: false, error: e.message });
    await pushState();
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch', async (_e, { versionId }) => {
  if (busy) return { ok: false, error: '当前有任务正在进行' };
  const cfg = store.get();
  const root = cfg.gameDir;
  const id = versionId || cfg.selectedVersion;
  if (!id) return { ok: false, error: '请先选择一个版本' };

  // 版本隔离：先问清楚这个版本对应的真实 MC 版本，再决定用哪个游戏目录，
  // 最后检查那个目录里的 mods 是否真的适配它 —— 否则 Fabric 会抛一屏英文堆栈。
  const mcVersion = await mods.resolveMcVersion(root, id);
  const picked = await mods.resolveGameDir(root, mcVersion, cfg.versionGameDirs);
  const gameDir = picked.dir;
  if (mcVersion) {
    const chk = await mods.checkMods(gameDir, mcVersion);
    if (chk.bad.length) {
      const list = chk.bad.slice(0, 6).map((b) => `${b.name || b.id}（需要 ${b.range}）`).join('、');
      const more = chk.bad.length > 6 ? ` 等 ${chk.bad.length} 个` : '';
      return {
        ok: false,
        error:
          `这个版本是 Minecraft ${mcVersion}，但目录里的模组不适配：${list}${more}。\n` +
          `目录：${gameDir}\n` +
          `解决办法：把该版本的模组放进 ${path.join(gameDir, 'mods')}，` +
          `或为 ${mcVersion} 单独准备一个目录（命名 ${path.basename(gameDir)}-${mcVersion} 会被自动识别）。`,
      };
    }
  }

  busy = { kind: 'launch', versionId: id };
  await pushState();
  send('launch:start', { versionId: id });
  const onLog = (entry) => send('log', entry);
  try {
    const mf = await ver.getManifest(root);
    const emit = (p) => throttled({ ...p, tag: 'launch', versionId: id });
    onLog({
      level: 'info',
      text: `版本 ${id} → Minecraft ${mcVersion || '未知'}，游戏目录 ${gameDir}` +
        (picked.reason === 'sibling' ? '（自动识别的同版本目录）' : ''),
    });
    const res = await launcher.launch({
      root,
      versionId: id,
      manifest: mf,
      config: { ...cfg, gameDir },
      onLog,
      emit,
      onExit: async ({ code }) => {
        gameChild = null;
        busy = null;
        send('launch:exit', { code, versionId: id });
        await pushState();
      },
    });
    gameChild = res.child;
    busy = null;
    await store.patch({ lastPlayed: id, selectedVersion: id });
    send('progress', { tag: 'launch', percent: 1, phase: 'running', label: '游戏已启动' });
    await pushState();
    return { ok: true, pid: res.pid };
  } catch (e) {
    busy = null;
    gameChild = null;
    onLog({ level: 'error', text: e.message });
    send('launch:exit', { code: -1, error: e.message, versionId: id });
    await pushState();
    return { ok: false, error: e.message };
  }
});

/** 当前选中版本对应的实例信息（模组页所有操作都用它） */
async function currentInstance() {
  const cfg = store.get();
  const root = cfg.gameDir;
  const id = cfg.selectedVersion;
  if (!id) return null;
  let mcVersion = null;
  try {
    mcVersion = await mods.resolveMcVersion(root, id);
  } catch { /* 解析不到就留空 */ }
  const picked = await mods.resolveGameDir(root, mcVersion, cfg.versionGameDirs);
  return {
    versionId: id,
    mcVersion,
    gameDir: picked.dir,
    modsDir: path.join(picked.dir, 'mods'),
  };
}

ipcMain.handle('mods:search', async (_e, { query, offset = 0 } = {}) => {
  const cur = await currentInstance();
  if (!cur) return { ok: false, error: '请先选择一个版本' };
  if (!cur.mcVersion) return { ok: false, error: '无法识别当前版本的 MC 版本号' };
  try {
    const r = await mr.search({ query: query || '', version: cur.mcVersion, loader: 'fabric', limit: 20, offset });
    return { ok: true, ...r, mcVersion: cur.mcVersion, modsDir: cur.modsDir };
  } catch (e) {
    return { ok: false, error: `搜索失败：${e.message}` };
  }
});

ipcMain.handle('mods:list', async () => {
  const cur = await currentInstance();
  if (!cur) return { ok: false, error: '请先选择一个版本' };
  try {
    const list = await mr.listLocal({ modsDir: cur.modsDir, version: cur.mcVersion });
    return { ok: true, list, mcVersion: cur.mcVersion, modsDir: cur.modsDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:install', async (_e, { id } = {}) => {
  if (!id) return { ok: false, error: '缺少项目 ID' };
  if (busy) return { ok: false, error: '当前有任务正在进行' };
  const cur = await currentInstance();
  if (!cur) return { ok: false, error: '请先选择一个版本' };
  if (!cur.mcVersion) return { ok: false, error: '无法识别当前版本的 MC 版本号' };
  busy = { kind: 'mods' };
  await pushState();
  const emit = (p) => send('mods:progress', p);
  try {
    const res = await mr.install({
      id,
      version: cur.mcVersion,
      loader: 'fabric',
      modsDir: cur.modsDir,
      onLog: (e) => emit({ type: 'log', ...e }),
    });
    busy = null;
    await pushState();
    const failed = (!res.installed || !res.installed.length) && res.errors && res.errors.length;
    if (failed) {
      return { ok: false, error: res.errors.map((x) => x.error).join('；'), ...res };
    }
    return { ok: true, ...res };
  } catch (e) {
    busy = null;
    await pushState();
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:import', async () => {
  const cur = await currentInstance();
  if (!cur) return { ok: false, error: '请先选择一个版本' };
  const picked = await dialog.showOpenDialog(win, {
    title: '选择要导入的模组（可多选）',
    filters: [{ name: 'Fabric/Quilt 模组', extensions: ['jar'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: true, imported: [], canceled: true };
  await fsp.mkdir(cur.modsDir, { recursive: true });
  const imported = [];
  const errors = [];
  for (const src of picked.filePaths) {
    try {
      const meta = await mods.readModMeta(src);
      const base = path.basename(src);
      let dest = path.join(cur.modsDir, base);
      if (fs.existsSync(dest)) dest = path.join(cur.modsDir, base.replace(/\.jar$/i, `-${Date.now()}.jar`));
      await fsp.copyFile(src, dest);
      let compatible = true;
      let range = '';
      if (meta && meta.depends && meta.depends.minecraft) {
        const dep = meta.depends.minecraft;
        const ranges = Array.isArray(dep) ? dep : [dep];
        range = ranges.join(' / ');
        if (cur.mcVersion) compatible = ranges.some((r) => mods.satisfies(cur.mcVersion, typeof r === 'string' ? r : ''));
      }
      imported.push({
        file: path.basename(dest),
        name: (meta && meta.name && (meta.name.zh_cn || meta.name.en_us)) || (meta && meta.id) || base,
        version: (meta && meta.version) || '',
        compatible,
        range,
      });
    } catch (e) {
      errors.push({ file: path.basename(src), error: e.message });
    }
  }
  return { ok: true, imported, errors };
});

ipcMain.handle('mods:toggle', async (_e, { file, enable } = {}) => {
  const cur = await currentInstance();
  if (!cur || !file) return { ok: false, error: '参数不完整' };
  const src = path.join(cur.modsDir, file);
  const isDisabled = /\.disabled$/i.test(file);
  const wantEnable = typeof enable === 'boolean' ? enable : isDisabled;
  try {
    if (wantEnable && isDisabled) {
      await fsp.rename(src, src.replace(/\.disabled$/i, ''));
    } else if (!wantEnable && !isDisabled) {
      await fsp.rename(src, src + '.disabled');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:remove', async (_e, { file } = {}) => {
  const cur = await currentInstance();
  if (!cur || !file) return { ok: false, error: '参数不完整' };
  const target = path.join(cur.modsDir, file);
  try {
    // 移到废纸篓而不是直接删，万一误点还能捞回来
    await shell.trashItem(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:reveal', async () => {
  const cur = await currentInstance();
  if (!cur) return { ok: false, error: '请先选择一个版本' };
  await fsp.mkdir(cur.modsDir, { recursive: true }).catch(() => {});
  shell.openPath(cur.modsDir);
  return { ok: true };
});

ipcMain.handle('version:delete', async (_e, { versionId }) => {
  const cfg = store.get();
  const dir = ver.paths(cfg.gameDir).versionDir(versionId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    if (cfg.selectedVersion === versionId) await store.patch({ selectedVersion: '' });
    await pushState();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('java:detect', async () => {
  const cfg = store.get();
  const list = await javac.detect({ runtimeRoots: [path.join(cfg.gameDir, 'runtime'), cfg.runtimeRoot].filter(Boolean) });
  return list;
});

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
  userData: app.getPath('userData'),
}));

ipcMain.handle('window:control', async (_e, action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

ipcMain.handle('shell:openUrl', async (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

/* ---------------- 生命周期 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData'));
    await store.load();

    if (isMac) {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: '启明',
            submenu: [
              { role: 'about', label: '关于启明' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏启明' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出启明' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo', label: '撤销' },
              { role: 'redo', label: '重做' },
              { type: 'separator' },
              { role: 'cut', label: '剪切' },
              { role: 'copy', label: '复制' },
              { role: 'paste', label: '粘贴' },
              { role: 'selectAll', label: '全选' },
            ],
          },
          {
            label: '窗口',
            submenu: [
              { role: 'minimize', label: '最小化' },
              { role: 'zoom', label: '缩放' },
              { role: 'togglefullscreen', label: '全屏' },
            ],
          },
        ])
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
