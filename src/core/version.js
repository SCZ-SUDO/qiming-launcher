'use strict';
/**
 * version.js — 版本清单、版本 JSON 继承链、库规则、启动参数拼装（纯 Node）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('./net');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCE_URL = 'https://resources.download.minecraft.net';

const OS_NAME = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
const ARCH_BITS = ['x64', 'arm64'].includes(process.arch) ? '64' : '32';
const ARCH_NAME = process.arch === 'arm64' ? 'arm64' : 'x64';

const paths = (root) => ({
  root,
  versions: path.join(root, 'versions'),
  libraries: path.join(root, 'libraries'),
  assets: path.join(root, 'assets'),
  cache: path.join(root, 'cache'),
  natives: (id) => path.join(root, 'versions', id, 'natives'),
  versionDir: (id) => path.join(root, 'versions', id),
  versionJson: (id) => path.join(root, 'versions', id, `${id}.json`),
  versionJar: (id) => path.join(root, 'versions', id, `${id}.jar`),
});

/* ---------------- 版本清单 ---------------- */

async function getManifest(root, { force = false } = {}) {
  const cacheFile = path.join(paths(root).cache, 'version_manifest_v2.json');
  if (!force) {
    try {
      const raw = await fsp.readFile(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.versions)) return parsed;
    } catch {}
  }
  const json = await net.fetchJson(MANIFEST_URL, { timeout: 30000 });
  await net.ensureDir(path.dirname(cacheFile));
  await fsp.writeFile(cacheFile, JSON.stringify(json), 'utf8').catch(() => {});
  return json;
}

/* ---------------- 版本 JSON 与继承 ---------------- */

async function readLocalJson(root, id) {
  try {
    const txt = await fsp.readFile(paths(root).versionJson(id), 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function getVersionJson(root, id, manifest) {
  const local = await readLocalJson(root, id);
  if (local) return local;
  const mf = manifest || (await getManifest(root));
  const entry = (mf.versions || []).find((v) => v.id === id);
  if (!entry) throw new Error(`未找到版本 ${id}`);
  const json = await net.fetchJson(entry.url, { timeout: 30000 });
  await net.ensureDir(paths(root).versionDir(id));
  await fsp.writeFile(paths(root).versionJson(id), JSON.stringify(json, null, 2), 'utf8');
  return json;
}

/** 沿 inheritsFrom 向上收集，返回 [child, parent, ...] */
async function resolveChain(root, id, manifest) {
  const chain = [];
  const seen = new Set();
  let curId = id;
  while (curId && !seen.has(curId) && chain.length < 6) {
    seen.add(curId);
    const json = await getVersionJson(root, curId, manifest);
    chain.push(json);
    curId = json.inheritsFrom;
  }
  if (!chain.length) throw new Error(`版本 ${id} 解析失败`);
  return chain;
}

const libKey = (lib) => {
  const parts = String(lib.name || '').split(':');
  return `${parts[0]}:${parts[1]}:${parts[3] || ''}`;
};

function mergeChain(chain) {
  const child = chain[0];
  const merged = {
    id: child.id,
    type: child.type || 'release',
    releaseTime: child.releaseTime || child.time,
    mainClass: child.mainClass,
    minimumLauncherVersion: child.minimumLauncherVersion,
    libraries: [],
    arguments: { game: [], jvm: [] },
    minecraftArguments: child.minecraftArguments,
    logging: child.logging,
    complianceLevel: child.complianceLevel,
  };
  // 子版本在前，父版本在后；去重交给 collectLibraries（必须先按规则过滤再判重，
  // 否则同一 artifact 的不同版本会互相挤掉，例如 1.16.5 的 LWJGL 3.2.1/3.2.2）
  for (const json of chain) {
    merged.libraries.push(...(json.libraries || []));
    if (json.arguments) {
      if (Array.isArray(json.arguments.game)) merged.arguments.game.push(...json.arguments.game);
      if (Array.isArray(json.arguments.jvm)) merged.arguments.jvm.push(...json.arguments.jvm);
    }
    if (!merged.assetIndex && json.assetIndex) merged.assetIndex = json.assetIndex;
    if (!merged.assets && json.assets) merged.assets = json.assets;
    if (!merged.downloads && json.downloads) merged.downloads = json.downloads;
    if (!merged.javaVersion && json.javaVersion) merged.javaVersion = json.javaVersion;
    if (!merged.minecraftArguments && json.minecraftArguments) merged.minecraftArguments = json.minecraftArguments;
    if (json.mainClass) merged.mainClass = merged.mainClass || json.mainClass;
  }
  // 客户端 jar 所在的版本（可能是父版本）
  const jarOwner = chain.find((j) => j.downloads && j.downloads.client) || child;
  merged.jar = child.jar || jarOwner.id;
  merged.jarDownloads = (chain.find((j) => j.id === merged.jar) || jarOwner).downloads;
  merged.baseVersion = chain[chain.length - 1].id;
  return merged;
}

/* ---------------- 规则 ---------------- */

function ruleMatches(rule, features) {
  if (rule.os) {
    const { name, arch, version } = rule.os;
    if (name && name !== OS_NAME) return false;
    if (arch && arch !== 'x86' && arch !== ARCH_BITS) {
      const okArch = arch === 'arm64' ? ARCH_NAME === 'arm64' : arch === 'x86' ? ARCH_BITS === '32' : false;
      if (!okArch) return false;
    }
    if (version && !new RegExp(version).test(os.release())) return false;
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) {
      const actual = !!features[k];
      if (actual !== !!v) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allow = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allow = rule.action === 'allow';
  }
  return allow;
}

/* ---------------- 库解析 ---------------- */

function mavenToPath(name) {
  let ext = 'jar';
  let body = String(name);
  const at = body.indexOf('@');
  if (at > -1) {
    ext = body.slice(at + 1);
    body = body.slice(0, at);
  }
  const [group, artifact, version, classifier] = body.split(':');
  const groupPath = String(group || '').replace(/\./g, '/');
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return `${groupPath}/${artifact}/${version}/${file}`;
}

function mavenUrl(name, repoBase) {
  // A library may carry its own maven repo (`url`); Mojang's is only the default.
  if (typeof repoBase === 'string' && repoBase.trim()) {
    const base = repoBase.trim().replace(/\/+$/, '');
    return `${base}/${mavenToPath(name)}`;
  }
  return `https://libraries.minecraft.net/${mavenToPath(name)}`;
}

/**
 * 返回 { libs:[{path,url,sha1,size}], natives:[{path,url,sha1,size,extract}] }
 * 顺序：先按 os 规则过滤，再按 group:artifact:classifier 判重（先出现者优先，子版本在前）
 */
function collectLibraries(merged) {
  const libs = [];
  const natives = [];
  const seen = new Set();
  const pathSeen = new Set();
  const pushLib = (entry) => {
    if (pathSeen.has(entry.path)) return;
    pathSeen.add(entry.path);
    libs.push(entry);
  };
  for (const lib of merged.libraries || []) {
    if (!lib.name) continue;
    if (!rulesAllow(lib.rules)) continue;
    // 同一坐标可能存在「classpath 本体」与「natives 附加包」两条，需分别判重
    const key = libKey(lib) + (lib.natives ? '|natives' : '');
    if (seen.has(key)) continue;
    seen.add(key);
    const dl = lib.downloads || {};
    // 1) natives 附加包（老版本走 classifiers + 解包）
    if (lib.natives) {
      const rawKey = lib.natives[OS_NAME];
      const cls = rawKey && dl.classifiers ? dl.classifiers[String(rawKey).replace('${arch}', ARCH_BITS)] : null;
      if (cls && cls.path) {
        natives.push({
          path: cls.path,
          url: cls.url,
          sha1: cls.sha1,
          size: cls.size,
          extract: lib.extract || {},
        });
      }
    }
    // 2) 主 artifact 上 classpath（带 natives 的库同样需要）
    if (dl.artifact && dl.artifact.path) {
      pushLib({
        path: dl.artifact.path,
        url: dl.artifact.url || mavenUrl(lib.name, lib.url),
        sha1: dl.artifact.sha1,
        size: dl.artifact.size,
      });
    } else if (!lib.natives) {
      // Fabric / Quilt profiles declare their libraries as { name, url } with no
      // `downloads.artifact`, and that `url` is the maven repo that actually
      // serves them (maven.fabricmc.net). Falling back to Mojang's repo for those
      // gives 404s — every Fabric loader dependency after the game itself
      // (asm, sponge-mixin, intermediary, ...). Honour the declared repo first.
      pushLib({ path: mavenToPath(lib.name), url: mavenUrl(lib.name, lib.url) });
    }
  }
  // 去重后按路径稳定排序，保证 classpath 顺序可复现
  return { libs, natives };
}

/* ---------------- 参数拼装 ---------------- */

function flattenArgList(list, ctx) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(substitute(item, ctx));
    } else if (item && typeof item === 'object') {
      if (!rulesAllow(item.rules, ctx.features)) continue;
      const values = Array.isArray(item.value) ? item.value : [item.value];
      for (const v of values) if (typeof v === 'string') out.push(substitute(v, ctx));
    }
  }
  return out;
}

function substitute(str, ctx) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, key) => {
    const v = ctx.vars[key];
    return v === undefined || v === null ? m : String(v);
  });
}

function offlineUuid(name) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requiredJava(merged) {
  if (merged.javaVersion && merged.javaVersion.majorVersion) return merged.javaVersion.majorVersion;
  return 8;
}

function buildCommand({ merged, classpath, nativesDir, gameDir, assetsDir, assetIndexName, auth, memory, extraJvm, width, height, fullscreen }) {
  const p = paths(gameDir);
  const cpSep = process.platform === 'win32' ? ';' : ':';
  const vars = {
    auth_player_name: auth.name,
    version_name: merged.id,
    game_directory: gameDir,
    assets_root: assetsDir,
    game_assets: path.join(assetsDir, 'virtual', assetIndexName || 'legacy'),
    assets_index_name: assetIndexName,
    auth_uuid: auth.uuid,
    auth_access_token: auth.accessToken,
    auth_session: `token:${auth.accessToken}:${auth.uuid}`,
    user_type: auth.type || 'legacy',
    version_type: merged.type || 'release',
    user_properties: '{}',
    clientid: '',
    auth_xuid: '',
    natives_directory: nativesDir,
    launcher_name: 'Qiming',
    launcher_version: '1.0.0',
    classpath: classpath.join(cpSep),
    classpath_separator: cpSep,
    resolution_width: width || 854,
    resolution_height: height || 480,
  };
  const ctx = { vars, features: { is_demo_user: false, has_custom_resolution: !!(width && height), has_quick_plays_support: false, is_quick_play_singleplayer: false } };

  // JVM
  const jvm = [];
  const mem = Number(memory) || 4096;
  jvm.push(`-Xmx${mem}M`, `-Xms${Math.min(mem, Math.max(512, Math.round(mem / 4)))}M`);
  jvm.push('-XX:+UseG1GC', '-XX:-UseAdaptiveSizePolicy', '-XX:-OmitStackTraceInFastThrow', '-Dfile.encoding=UTF-8', '-Dlog4j2.formatMsgNoLookups=true');
  if (extraJvm && extraJvm.trim()) jvm.push(...extraJvm.trim().split(/\s+/));

  let jsonJvm = [];
  if (Array.isArray(merged.arguments.jvm) && merged.arguments.jvm.length) {
    jsonJvm = flattenArgList(merged.arguments.jvm, ctx);
    // 去掉空的 -Dos.* 之类
    jsonJvm = jsonJvm.filter((a) => a && !/^-Dos\.(name|version)=$/.test(a));
  } else {
    jsonJvm = [`-Djava.library.path=${nativesDir}`, '-cp', classpath.join(cpSep)];
  }
  const hasCp = jsonJvm.some((a) => a === '-cp' || a === '-classpath' || a.startsWith('-cp='));
  if (!hasCp) jsonJvm.push('-cp', classpath.join(cpSep));
  if (!jsonJvm.some((a) => a.startsWith('-Djava.library.path'))) jsonJvm.unshift(`-Djava.library.path=${nativesDir}`);

  // 游戏参数
  let game = [];
  if (Array.isArray(merged.arguments.game) && merged.arguments.game.length) {
    game = flattenArgList(merged.arguments.game, ctx);
  } else if (merged.minecraftArguments) {
    game = merged.minecraftArguments.split(/\s+/).filter(Boolean).map((a) => substitute(a, ctx));
    game.push('--userProperties', '{}');
  }
  game = game.filter((a) => !/^\$\{.*\}$/.test(a));

  if (width && height && !game.includes('--width')) game.push('--width', String(width), '--height', String(height));
  if (fullscreen) game.push('--fullscreen');

  return { jvm: [...jvm, ...jsonJvm], game, mainClass: merged.mainClass, vars };
}

module.exports = {
  MANIFEST_URL,
  RESOURCE_URL,
  OS_NAME,
  ARCH_BITS,
  ARCH_NAME,
  paths,
  getManifest,
  getVersionJson,
  resolveChain,
  mergeChain,
  rulesAllow,
  mavenToPath,
  collectLibraries,
  buildCommand,
  offlineUuid,
  requiredJava,
};
