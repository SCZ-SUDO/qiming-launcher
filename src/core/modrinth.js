'use strict';
/**
 * modrinth.js — Modrinth 公开 API 封装：搜索 / 取版本 / 安装（含必装前置）。
 *
 * 设计要点：
 *   - 只依赖 net.js 的下载器，不碰 electron，方便单独跑测试
 *   - 安装前先扫 mods 目录，同 id 的旧版本会被替换（不留重复 jar）
 *   - 必装前置（dependency_type='required'）递归装，带 visited 防环、深度上限
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('./net');
const modsCore = require('./mods');

const API = 'https://api.modrinth.com/v2';
const HEADERS = {
  'User-Agent': 'qiming-launcher/1.0 (personal use)',
  Accept: 'application/json',
};

function facetJson(list) {
  return JSON.stringify(list);
}

/** 搜索模组（按 MC 版本 + 加载器过滤，只返回兼容的） */
async function search({ query = '', version, loader = 'fabric', limit = 20, offset = 0 }) {
  const facets = [['project_type:mod']];
  if (version) facets.push([`versions:${version}`]);
  if (loader) facets.push([`categories:${loader}`]);
  const params = new URLSearchParams({
    query: query || '',
    limit: String(limit),
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
    facets: facetJson(facets),
  });
  const data = await net.fetchJson(`${API}/search?${params}`, { headers: HEADERS });
  return {
    total: data.total_hits,
    hits: (data.hits || []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      icon: h.icon_url,
      categories: h.categories || [],
      versions: h.versions || [],
      updated: h.date_modified,
    })),
  };
}

/** 取某项目在指定 MC 版本/加载器下的版本列表（新的在前） */
async function getVersions({ id, version, loader = 'fabric' }) {
  const params = new URLSearchParams();
  if (version) params.set('game_versions', JSON.stringify([version]));
  if (loader) params.set('loaders', JSON.stringify([loader]));
  const list = await net.fetchJson(`${API}/project/${id}/version?${params}`, { headers: HEADERS });
  return Array.isArray(list) ? list : [];
}

/** 取最新一个匹配版本 */
async function pickVersion({ id, version, loader = 'fabric' }) {
  const list = await getVersions({ id, version, loader });
  return list[0] || null;
}

/** 扫 mods 目录，返回 id -> [{file, version}] */
async function scanInstalled(modsDir) {
  const map = new Map();
  let files = [];
  try {
    files = await fsp.readdir(modsDir);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!/\.jar(\.disabled)?$/i.test(f)) continue;
    const meta = await modsCore.readModMeta(path.join(modsDir, f));
    if (!meta || !meta.id) continue;
    const arr = map.get(meta.id) || [];
    arr.push({ file: f, version: meta.version, disabled: /\.disabled$/i.test(f) });
    map.set(meta.id, arr);
  }
  return map;
}

/**
 * 安装一个项目（含必装前置）。
 * @returns {{installed: Array, errors: Array, skipped: Array}}
 */
async function install({ id, version, loader = 'fabric', modsDir, onLog = () => {}, depth = 0, visited = new Set() }) {
  const result = { installed: [], errors: [], skipped: [] };
  if (depth > 3) return result;
  if (visited.has(id)) return result;
  visited.add(id);

  let picked;
  try {
    picked = await pickVersion({ id, version, loader });
  } catch (e) {
    result.errors.push({ id, error: `查询版本失败：${e.message}` });
    return result;
  }
  if (!picked) {
    result.skipped.push({ id, reason: `没有适配 ${version} / ${loader} 的版本` });
    return result;
  }

  const file = (picked.files || []).find((f) => f.primary) || (picked.files || [])[0];
  if (!file) {
    result.errors.push({ id, error: '该版本没有可下载文件' });
    return result;
  }

  await net.ensureDir(modsDir);
  const installed = await scanInstalled(modsDir);

  // 判重：目标文件名已存在（最可靠，因为 jar 内的 id 和 Modrinth 的 project_id 不是一回事）
  const already = installed.get(picked.project_id) || [];
  let exists = false;
  try {
    const existing = await fsp.readdir(modsDir);
    exists = existing.includes(file.filename);
  } catch { /* 目录不存在就当没装 */ }
  if (exists || already.some((x) => x.version === picked.version_number && !x.disabled)) {
    onLog({ level: 'info', text: `${picked.name} ${picked.version_number} 已在 mods 里，跳过` });
    result.skipped.push({ id, reason: `已安装（${file.filename}）` });
  } else {
    // 删掉同项目的旧版本 jar（避免同一个模组两个版本并存）
    for (const old of already) {
      try {
        await fsp.unlink(path.join(modsDir, old.file));
        onLog({ level: 'info', text: `移除旧版本 ${old.file}` });
      } catch { /* 忽略 */ }
    }
    const dest = path.join(modsDir, file.filename);
    onLog({ level: 'info', text: `下载 ${picked.name} ${picked.version_number}（${(file.size / 1024 / 1024).toFixed(1)} MB）` });
    try {
      await net.downloadOne(file.url, dest, { size: file.size, sha1: file.hashes && file.hashes.sha1 });
      result.installed.push({ id: picked.project_id, name: picked.name, version: picked.version_number, file: file.filename });
      onLog({ level: 'ok', text: `✓ ${picked.name} ${picked.version_number}` });
    } catch (e) {
      result.errors.push({ id, error: `${picked.name} 下载失败：${e.message}` });
      return result;
    }
  }

  // 必装前置
  for (const dep of picked.dependencies || []) {
    if (dep.dependency_type !== 'required') continue;
    if (!dep.project_id) continue;
    const sub = await install({
      id: dep.project_id,
      version,
      loader,
      modsDir,
      onLog,
      depth: depth + 1,
      visited,
    });
    result.installed.push(...sub.installed);
    result.errors.push(...sub.errors);
    result.skipped.push(...sub.skipped);
  }

  return result;
}

/** 列出 mods 目录里的模组（含兼容性判断） */
async function listLocal({ modsDir, version }) {
  let files = [];
  try {
    files = await fsp.readdir(modsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!/\.jar(\.disabled)?$/i.test(f)) continue;
    const full = path.join(modsDir, f);
    let size = 0;
    try {
      size = (await fsp.stat(full)).size;
    } catch { /* 忽略 */ }
    const meta = await modsCore.readModMeta(full);
    const enabled = !/\.disabled$/i.test(f);
    let compatible = true;
    let range = '';
    if (meta && meta.depends && meta.depends.minecraft) {
      const dep = meta.depends.minecraft;
      const ranges = Array.isArray(dep) ? dep : [dep];
      range = ranges.join(' / ');
      compatible = version ? ranges.some((r) => modsCore.satisfies(version, typeof r === 'string' ? r : '')) : true;
    }
    out.push({
      file: f,
      enabled,
      size,
      id: (meta && meta.id) || '',
      name: (meta && meta.name && (meta.name.zh_cn || meta.name.en_us || meta.name)) || (meta && meta.name) || f,
      version: (meta && meta.version) || '',
      range,
      compatible,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

module.exports = { search, getVersions, pickVersion, install, listLocal, scanInstalled };
