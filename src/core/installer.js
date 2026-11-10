'use strict';
/**
 * installer.js — 把某个版本真正装到磁盘（客户端、依赖库、natives、资源文件）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('./net');
const ver = require('./version');
const zip = require('./zip');

const P = ver.paths;

function progress(emit, phase, label, extra = {}) {
  if (emit) emit({ phase, label, percent: 0, ...extra });
}

/** 版本是否已完整安装（粗略检查：json + client jar + libraries 存在） */
async function isInstalled(root, id) {
  try {
    const json = await ver.getVersionJson(root, id);
    const merged = ver.mergeChain(await ver.resolveChain(root, id));
    const jarPath = P(root).versionJar(merged.jar);
    const st = await fsp.stat(jarPath);
    if (!st.size) return false;
    const { libs } = ver.collectLibraries(merged);
    for (const lib of libs.slice(0, 400)) {
      await fsp.access(path.join(P(root).libraries, lib.path));
    }
    return true;
  } catch {
    return false;
  }
}

async function installVersion({ root, versionId, emit, manifest }) {
  const pp = P(root);
  await net.ensureDir(pp.libraries);
  await net.ensureDir(pp.assets);
  await net.ensureDir(pp.versions);

  progress(emit, 'resolve', '解析版本信息…');
  const chain = await ver.resolveChain(root, versionId, manifest);
  const merged = ver.mergeChain(chain);

  /* ---- 1. 客户端 jar ---- */
  const client = (merged.jarDownloads && merged.jarDownloads.client) || null;
  if (!client) throw new Error(`版本 ${versionId} 缺少客户端下载信息`);
  progress(emit, 'client', '下载客户端…', { files: { done: 0, total: 1 } });
  await net.downloadOne(client.url, pp.versionJar(merged.jar), {
    sha1: client.sha1,
    size: client.size,
    onBytes: (n) => emit && emit({ phase: 'client', label: '下载客户端…', percent: 1, bytes: n, totalBytes: client.size }),
  });

  /* ---- 2. 依赖库 ---- */
  const { libs, natives } = ver.collectLibraries(merged);
  const libTasks = libs.map((l) => ({
    url: l.url,
    dest: path.join(pp.libraries, l.path),
    sha1: l.sha1,
    size: l.size,
  }));
  progress(emit, 'libraries', `下载依赖库（${libTasks.length} 个）…`, { files: { done: 0, total: libTasks.length } });
  await net.downloadAll(libTasks, {
    concurrency: 16,
    onBytes: (done, total) => emit && emit({ phase: 'libraries', label: '下载依赖库…', bytes: done, totalBytes: total, percent: total ? done / total : 0 }),
    onTick: (done, total) => emit && emit({ phase: 'libraries', label: '下载依赖库…', files: { done, total }, percent: total ? done / total : 0 }),
  });

  /* ---- 3. natives 解包 ---- */
  const nativesDir = pp.natives(merged.id);
  if (natives.length) {
    progress(emit, 'natives', '解包本地库…');
    await fsp.rm(nativesDir, { recursive: true, force: true }).catch(() => {});
    await net.ensureDir(nativesDir);
    for (const n of natives) {
      const jarPath = path.join(pp.libraries, n.path);
      if (!(await net.isTrusted(jarPath, { sha1: n.sha1, size: n.size }))) {
        await net.downloadOne(n.url, jarPath, { sha1: n.sha1, size: n.size });
      }
      const exclude = ['META-INF/'];
      if (n.extract && Array.isArray(n.extract.exclude)) exclude.push(...n.extract.exclude);
      await zip.extractFile(jarPath, nativesDir, { exclude }).catch(() => {});
    }
  }

  /* ---- 4. 资源文件 ---- */
  if (merged.assetIndex && merged.assetIndex.url) {
    const idxName = merged.assetIndex.id || 'legacy';
    const idxFile = path.join(pp.assets, 'indexes', `${idxName}.json`);
    progress(emit, 'assets', '下载资源索引…');
    await net.downloadOne(merged.assetIndex.url, idxFile, {
      sha1: merged.assetIndex.sha1,
      size: merged.assetIndex.size,
    });
    const index = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
    const objects = Object.entries(index.objects || {});
    const tasks = objects.map(([, o]) => {
      const sub = String(o.hash).slice(0, 2);
      return {
        url: `${ver.RESOURCE_URL}/${sub}/${o.hash}`,
        dest: path.join(pp.assets, 'objects', sub, o.hash),
        sha1: o.hash,
        size: o.size,
      };
    });
    progress(emit, 'assets', `下载资源文件（${tasks.length} 个）…`, { files: { done: 0, total: tasks.length } });
    await net.downloadAll(tasks, {
      concurrency: 64,
      onBytes: (done, total) => emit && emit({ phase: 'assets', label: '下载资源文件…', bytes: done, totalBytes: total, percent: total ? done / total : 0 }),
      onTick: (done, total) => emit && emit({ phase: 'assets', label: '下载资源文件…', files: { done, total }, percent: total ? done / total : 0 }),
    });

    if (index.virtual) {
      progress(emit, 'assets', '生成虚拟资源目录…');
      const vDir = path.join(pp.assets, 'virtual', idxName);
      for (const [name, o] of objects) {
        const src = path.join(pp.assets, 'objects', String(o.hash).slice(0, 2), o.hash);
        const dst = path.join(vDir, name);
        await net.ensureDir(path.dirname(dst));
        await fsp.copyFile(src, dst).catch(() => {});
      }
    }
    if (index.map_to_resources) {
      const rDir = path.join(root, 'resources');
      for (const [name, o] of objects) {
        const src = path.join(pp.assets, 'objects', String(o.hash).slice(0, 2), o.hash);
        const dst = path.join(rDir, name);
        await net.ensureDir(path.dirname(dst));
        await fsp.copyFile(src, dst).catch(() => {});
      }
    }
  }

  progress(emit, 'done', '安装完成', { percent: 1 });
  return { id: merged.id, jar: merged.jar, libraries: libs.length, natives: natives.length };
}

/* ---------------- 模组加载器（Fabric / Quilt） ---------------- */

async function installFabric({ root, mcVersion, emit, manifest }) {
  progress(emit, 'resolve', '查询 Fabric 加载器版本…');
  const list = await net.fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, { timeout: 30000 });
  if (!Array.isArray(list) || !list.length) throw new Error('Fabric 不支持该游戏版本');
  const best = list.find((x) => x.loader && x.loader.stable) || list[0];
  const loaderVer = best.loader.version;
  progress(emit, 'resolve', `Fabric Loader ${loaderVer}，获取配置…`);
  const profile = await net.fetchJson(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVer)}/profile/json`,
    { timeout: 30000 }
  );
  const id = profile.id || `fabric-loader-${loaderVer}-${mcVersion}`;
  profile.id = id;
  if (!profile.inheritsFrom) profile.inheritsFrom = mcVersion;
  const dir = P(root).versionDir(id);
  await net.ensureDir(dir);
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2), 'utf8');
  await installVersion({ root, versionId: id, emit, manifest });
  return id;
}

async function installQuilt({ root, mcVersion, emit, manifest }) {
  progress(emit, 'resolve', '查询 Quilt 加载器版本…');
  const list = await net.fetchJson(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`, { timeout: 30000 });
  if (!Array.isArray(list) || !list.length) throw new Error('Quilt 不支持该游戏版本');
  const loaderVer = list[0].loader.version;
  progress(emit, 'resolve', `Quilt Loader ${loaderVer}，获取配置…`);
  const profile = await net.fetchJson(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVer)}/profile/json`,
    { timeout: 30000 }
  );
  const id = profile.id || `quilt-loader-${loaderVer}-${mcVersion}`;
  profile.id = id;
  if (!profile.inheritsFrom) profile.inheritsFrom = mcVersion;
  const dir = P(root).versionDir(id);
  await net.ensureDir(dir);
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2), 'utf8');
  await installVersion({ root, versionId: id, emit, manifest });
  return id;
}

/** 列出本地已安装版本 */
async function listInstalled(root) {
  const dir = P(root).versions;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const jsonPath = path.join(dir, name, `${name}.json`);
      const raw = await fsp.readFile(jsonPath, 'utf8');
      const json = JSON.parse(raw);
      const st = await fsp.stat(jsonPath);
      let jarOk = false;
      try {
        const jar = P(root).versionJar(name);
        jarOk = (await fsp.stat(jar)).size > 0;
      } catch {}
      out.push({
        id: json.id || name,
        type: json.type || (json.inheritsFrom ? 'modded' : 'release'),
        inheritsFrom: json.inheritsFrom || null,
        releaseTime: json.releaseTime || json.time || st.mtime.toISOString(),
        javaVersion: json.javaVersion ? json.javaVersion.majorVersion : null,
        jarOk,
        folder: path.join(dir, name),
      });
    } catch {}
  }
  out.sort((a, b) => String(b.releaseTime).localeCompare(String(a.releaseTime)));
  return out;
}

module.exports = { installVersion, installFabric, installQuilt, listInstalled, isInstalled };
