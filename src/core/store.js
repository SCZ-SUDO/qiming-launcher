'use strict';
/**
 * store.js — 配置读写（纯 Node）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

function defaultGameDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'minecraft');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft');
  }
  return path.join(home, '.minecraft');
}

/** 首次启动时探测本机已有的游戏目录（有 versions 的优先） */
function detectGameDir() {
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [
          path.join(home, 'Library', 'Application Support', 'minecraft'),
          path.join(home, '.minecraft'),
          path.join(home, 'Documents', 'minecraft'),
        ]
      : process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft'),
          path.join(home, '.minecraft'),
          path.join(home, 'Desktop', '.minecraft'),
        ]
      : [path.join(home, '.minecraft')];
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'versions')).isDirectory()) return dir;
    } catch {}
  }
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {}
  }
  return defaultGameDir();
}

const DEFAULTS = {
  gameDir: defaultGameDir(),
  runtimeRoot: '', // 空 = <gameDir>/runtime
  username: 'Steve',
  memoryMB: 4096,
  javaPath: '',
  width: 1280,
  height: 720,
  fullscreen: false,
  extraJvm: '',
  autoJava: true,
  selectedVersion: '',
  lastPlayed: '',
  closeOnLaunch: false,
};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.data = { ...DEFAULTS };
  }

  async load() {
    let raw = null;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch {}
    if (raw == null) {
      // 首次启动：自动找本机已有的游戏目录
      this.data.gameDir = detectGameDir();
      await this.save().catch(() => {});
    } else {
      try {
        this.data = merge(this.data, JSON.parse(raw));
      } catch {}
    }
    return this.data;
  }

  async save() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async patch(obj) {
    this.data = merge(this.data, obj);
    await this.save();
    return this.data;
  }

  get() {
    return this.data;
  }
}

module.exports = { Store, DEFAULTS, defaultGameDir, detectGameDir };
