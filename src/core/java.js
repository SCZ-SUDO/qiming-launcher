'use strict';
/**
 * java.js — Java 探测 / 版本识别 / 缺失时自动下载 Adoptium JRE
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const net = require('./net');
const zip = require('./zip');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const JDK_DIR_NAME = isMac ? 'Contents/Home' : '';

const versionCache = new Map();

function javaExe(home) {
  // macOS 上有两种目录结构：JRE bundle 的 .../Contents/Home/bin/java，
  // 以及 Mojang 运行时的 .../bin/java。先看直连结构，不存在再拼 Contents/Home。
  // （原实现无条件拼 JDK_DIR_NAME，而 detect() 收集 home 时已经拼过一次，导致双拼）
  const exe = isWin ? 'java.exe' : 'java';
  const direct = path.join(home, 'bin', exe);
  if (!isWin && !fs.existsSync(direct)) return path.join(home, JDK_DIR_NAME, 'bin', exe);
  return direct;
}

async function existsFile(p) {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 读取 java 主版本号 */
function probe(bin) {
  if (versionCache.has(bin)) return versionCache.get(bin);
  let result = null;
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 12000, windowsHide: true });
    const text = `${r.stderr || ''}${r.stdout || ''}`;
    const m = text.match(/version\s+"([^"]+)"/) || text.match(/openjdk\s+([0-9][^\s]*)/) || text.match(/java\s+version\s+"([^"]+)"/);
    if (m) {
      const raw = m[1];
      let major = parseInt(raw.split('.')[0], 10);
      if (major === 1) major = parseInt(raw.split('.')[1], 10);
      result = { path: bin, major, version: raw, vendor: /graal/i.test(text) ? 'GraalVM' : /adoptium|temurin/i.test(text) ? 'Temurin' : /zulu/i.test(text) ? 'Zulu' : /oracle/i.test(text) ? 'Oracle' : 'OpenJDK' };
    }
  } catch {}
  // 失败结果不缓存（刚下载的 java 可能被杀软短暂占用）
  if (result) versionCache.set(bin, result);
  return result;
}

function globDirs(base, depth = 2) {
  const out = [];
  const walk = (dir, d) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      out.push(full);
      if (d > 1) walk(full, d - 1);
    }
  };
  walk(base, depth);
  return out;
}

/** 从 release 文件兜底识别版本（java -version 偶尔会被系统占用而失败） */
function releaseInfo(home, bin) {
  const cands = [path.join(home, 'release'), path.join(home, 'Contents', 'Home', 'release')];
  for (const rel of cands) {
    try {
      const m = /JAVA_VERSION="([^"]+)"/.exec(fs.readFileSync(rel, 'utf8'));
      if (m) {
        let major = parseInt(m[1].split('.')[0], 10);
        if (major === 1) major = parseInt(m[1].split('.')[1], 10);
        return { path: bin, major, version: m[1], vendor: /temurin|adoptium/i.test(m[1]) ? 'Temurin' : 'OpenJDK' };
      }
    } catch {}
  }
  return null;
}

/** 汇总所有可能存在的 Java */
async function detect({ runtimeRoots = [] } = {}) {
  const homes = new Set();
  const pushHome = (h) => {
    if (h && h.trim()) homes.add(h.trim());
  };

  if (process.env.JAVA_HOME) pushHome(process.env.JAVA_HOME);
  if (process.env.JDK_HOME) pushHome(process.env.JDK_HOME);

  if (isMac) {
    try {
      const r = spawnSync('/usr/libexec/java_home', ['-V'], { encoding: 'utf8', timeout: 10000 });
      const text = `${r.stdout || ''}${r.stderr || ''}`;
      for (const line of text.split('\n')) {
        const m = line.match(/(\/.*?Contents\/Home)/);
        if (m) pushHome(m[1]);
      }
    } catch {}
    for (const base of ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'), '/opt/homebrew/opt', '/usr/local/opt']) {
      for (const d of globDirs(base, 1)) pushHome(d.endsWith('Contents/Home') ? d : path.join(d, isMac ? 'Contents/Home' : ''));
    }
  }

  if (isWin) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    for (const base of [
      path.join(pf, 'Java'),
      path.join(pf, 'Eclipse Adoptium'),
      path.join(pf, 'Eclipse Foundation'),
      path.join(pf, 'BellSoft'),
      path.join(pf, 'Microsoft'),
      path.join(pf86, 'Java'),
      path.join(lad, 'Programs', 'Eclipse Adoptium'),
      path.join(os.homedir(), '.jdks'),
    ]) {
      for (const d of globDirs(base, 1)) pushHome(d);
    }
  }

  // 启动器自带运行时
  for (const root of runtimeRoots) {
    for (const d of globDirs(root, 2)) pushHome(d);
  }

  // PATH 中的 java
  try {
    const r = spawnSync(isWin ? 'where' : 'which', ['java'], { encoding: 'utf8', timeout: 8000 });
    const first = String(r.stdout || '').split(/\r?\n/).filter(Boolean)[0];
    if (first) pushHome(path.dirname(path.dirname(first)));
  } catch {}

  const seen = new Set();
  const list = [];
  for (const home of homes) {
    const exe = javaExe(home);
    const bin = (await existsFile(exe)) ? exe : null;
    if (!bin || seen.has(bin)) continue;
    seen.add(bin);
    const info = probe(bin) || releaseInfo(home, bin);
    if (info) list.push({ ...info, home: home.replace(/[\\/]bin[\\/]java(\.exe)?$/, '') });
  }
  list.sort((a, b) => a.major - b.major);
  // 同一份 JDK 常被多个来源探到（JDK 目录 + /usr/bin/java），按 版本/厂商 去重，保留先出现者
  const seenKey = new Set();
  return list.filter((j) => {
    const key = `${j.major}-${j.version}-${j.vendor}`;
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  });
}

/** 挑选合适的 Java */
async function pick({ required, runtimeRoots = [], preferred }) {
  if (preferred) {
    const info = probe(preferred);
    if (info) return { ...info, source: 'custom' };
  }
  const list = await detect({ runtimeRoots });
  const exact = list.find((j) => j.major === required);
  if (exact) return { ...exact, source: 'system' };
  if (required >= 16) {
    const higher = list.filter((j) => j.major >= required).sort((a, b) => a.major - b.major)[0];
    if (higher) return { ...higher, source: 'system' };
  }
  return null;
}

const ADOPTIUM_OS = isMac ? 'mac' : isWin ? 'windows' : 'linux';
const ADOPTIUM_ARCH = process.arch === 'arm64' ? 'aarch64' : 'x64';

/* ---------------- Mojang 官方 Java 运行时（首选，CDN 快且版本精确） ---------------- */

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  if (isWin) return process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (isMac) return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux';
}

async function downloadMojangRuntime(component, runtimeRoot, { emit } = {}) {
  if (emit) emit({ phase: 'java', label: '查询 Mojang 官方 Java 运行时…', percent: 0.02 });
  const index = await net.fetchJson(RUNTIME_INDEX, { timeout: 30000 });
  const key = platformKey();
  const bucket = index[key] && index[key][component];
  if (!bucket || !bucket.length) throw new Error(`Mojang 未提供 ${key} / ${component} 运行时`);
  const entry = bucket[0];
  const dir = path.join(runtimeRoot, component);

  // 幂等：已经下过就直接复用，否则每次启动游戏都要重下约 90MB
  const existing = isMac && fs.existsSync(path.join(dir, 'Contents', 'Home', 'bin', 'java'))
    ? path.join(dir, 'Contents', 'Home', 'bin', 'java')
    : path.join(dir, 'bin', isWin ? 'java.exe' : 'java');
  if (fs.existsSync(existing)) {
    const cached = probe(existing);
    if (cached) {
      if (emit) emit({ phase: 'java', label: `复用已下载的 Java ${cached.major} 运行时`, percent: 1 });
      return { ...cached, source: 'mojang', vendor: cached.vendor || 'Mojang' };
    }
  }

  const manifest = await net.fetchJson(entry.manifest.url, { timeout: 30000 });

  const tasks = [];
  const links = [];
  for (const [rel, info] of Object.entries(manifest.files || {})) {
    const dest = path.join(dir, rel);
    if (info.type === 'directory') {
      await net.ensureDir(dest);
    } else if (info.type === 'link') {
      links.push({ dest, target: info.target });
    } else if (info.type === 'file' && info.downloads && info.downloads.raw) {
      const raw = info.downloads.raw;
      tasks.push({ url: raw.url, dest, sha1: raw.sha1, size: raw.size, executable: !!info.executable });
    }
  }

  if (emit) emit({ phase: 'java', label: `下载 Java 运行时（${tasks.length} 个文件）…`, percent: 0.05 });
  await net.downloadAll(tasks, {
    concurrency: 24,
    onBytes: (done, total) =>
      emit && emit({ phase: 'java', label: `下载 Java 运行时 ${(Math.min(done, total) / 1048576).toFixed(0)} MB…`, percent: 0.05 + 0.9 * (total ? done / total : 0) }),
  });

  for (const l of links) {
    try {
      await fsp.mkdir(path.dirname(l.dest), { recursive: true });
      await fsp.rm(l.dest, { force: true }).catch(() => {});
      await fsp.symlink(l.target, l.dest).catch(() => {});
    } catch {}
  }
  if (!isWin) {
    for (const t of tasks) {
      if (t.executable) await fsp.chmod(t.dest, 0o755).catch(() => {});
    }
    // bin 目录整体给执行权，避免个别文件缺权限
    try {
      const bin = path.join(dir, 'bin');
      for (const f of await fsp.readdir(bin)) await fsp.chmod(path.join(bin, f), 0o755).catch(() => {});
    } catch {}
  }

  const bin = isMac && fs.existsSync(path.join(dir, 'Contents', 'Home', 'bin', 'java'))
    ? path.join(dir, 'Contents', 'Home', 'bin', 'java')
    : path.join(dir, 'bin', isWin ? 'java.exe' : 'java');
  if (!(await existsFile(bin))) throw new Error('运行时下载完成但未找到 java 可执行文件');
  versionCache.delete(bin);

  // 刚下载完可能被杀软/索引占用（Windows 上会 EBUSY），重试几次
  let info = null;
  for (let i = 0; i < 4 && !info; i++) {
    info = probe(bin);
    if (!info) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (!info) {
    // 兜底：读 JDK/JRE 的 release 文件
    let verStr = null;
    for (const rel of [path.join(dir, 'release'), path.join(dir, '..', 'release'), path.join(dir, 'Contents', 'Home', 'release')]) {
      try {
        const m = /JAVA_VERSION="([^"]+)"/.exec(await fsp.readFile(rel, 'utf8'));
        if (m) {
          verStr = m[1];
          break;
        }
      } catch {}
    }
    const major = verStr ? parseInt(String(verStr).split('.')[0], 10) : null;
    info = { path: bin, major: major === 1 ? 8 : major, version: verStr || component, vendor: 'Mojang' };
  }
  if (emit) emit({ phase: 'java', label: `Java ${info.major} 运行时就绪`, percent: 1 });
  return { ...info, source: 'mojang', vendor: 'Mojang' };
}

/** 下载并解压 Adoptium JRE，返回 java 可执行文件路径 */
async function downloadJre(major, runtimeRoot, { onProgress, emit } = {}) {
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${ADOPTIUM_OS}/${ADOPTIUM_ARCH}/jre/hotspot/normal/eclipse`;
  const dir = path.join(runtimeRoot, `jre-${major}`);
  await net.ensureDir(dir);
  const ext = isWin ? 'zip' : 'tar.gz';
  const archive = path.join(runtimeRoot, `jre-${major}-${Date.now()}.${ext}`);
  if (emit) emit({ phase: 'java', label: `下载 Java ${major} 运行时…`, percent: 0 });
  // onBytes 是增量回调，这里自行累计并按经验体积估算进度
  let got = 0;
  const EST = 55 * 1024 * 1024;
  await net.downloadOne(url, archive, {
    timeout: 600000,
    onBytes: (n) => {
      got += n;
      const pct = Math.min(0.88, got / EST);
      if (onProgress) onProgress(pct);
      if (emit) emit({ phase: 'java', label: `下载 Java ${major} 运行时…（${(got / 1048576).toFixed(1)} MB）`, percent: pct });
    },
  });

  if (emit) emit({ phase: 'java', label: '解压 Java 运行时…', percent: 0.92 });
  if (isWin) {
    await zip.extractFile(archive, dir);
  } else {
    await new Promise((resolve, reject) => {
      const p = spawn('tar', ['-xzf', archive, '-C', dir], { stdio: 'ignore' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('tar 解压失败'))));
      p.on('error', reject);
    });
  }
  await fsp.rm(archive, { force: true }).catch(() => {});

  // 找到真正的 java 可执行文件
  const found = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === (isWin ? 'java.exe' : 'java') && full.includes(`${path.sep}bin${path.sep}`)) found.push(full);
    }
  };
  walk(dir, 0);
  if (!found.length) throw new Error('Java 解压后未找到可执行文件');
  const bin = found[0];
  if (!isWin) {
    await new Promise((resolve) => {
      const p = spawn('chmod', ['-R', 'a+x', path.dirname(bin)], { stdio: 'ignore' });
      p.on('exit', resolve);
      p.on('error', resolve);
    });
  }
  versionCache.delete(bin);
  const info = probe(bin);
  if (emit) emit({ phase: 'java', label: `Java ${major} 就绪`, percent: 1 });
  return { path: bin, major: info ? info.major : major, version: info ? info.version : String(major), vendor: 'Temurin', source: 'downloaded' };
}

/** 确保有可用的 Java，返回 {path, major} */
async function ensure({ required, component, runtimeRoot, runtimeRoots = [], preferred, onProgress, emit }) {
  const found = await pick({ required, runtimeRoots: [runtimeRoot, ...runtimeRoots], preferred });
  if (found) return found;
  // 1) Mojang 官方运行时（与游戏版本精确匹配，macOS ARM 也有原生包）
  if (component) {
    try {
      const r = await downloadMojangRuntime(component, runtimeRoot, { emit });
      if (r.major == null || r.major >= required || required < 16) return r;
    } catch (e) {
      if (emit) emit({ phase: 'java', label: `Mojang 运行时不可用（${e.message}），改用 Adoptium…`, percent: 0 });
    }
  }
  // 2) Adoptium 兜底
  return downloadJre(required, runtimeRoot, { onProgress, emit });
}

module.exports = { detect, pick, ensure, downloadJre, downloadMojangRuntime, probe, javaExe, platformKey };
