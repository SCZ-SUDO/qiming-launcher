'use strict';
/**
 * mods.js — 版本隔离：解析版本号、检查 mods 兼容性、决定该用哪个游戏目录。
 *
 * 背景：Minecraft 一个游戏目录只有一份 mods/，而 1.21.6 与 1.21.4 的模组互不兼容。
 * 于是同一台机器上常常并存多套实例。这里做三件事：
 *   1) 从 versions/<id>.json 的继承链里取真实 MC 版本
 *   2) 读每个模组的 fabric.mod.json，判断它的 minecraft 依赖是否覆盖目标版本
 *   3) 为该版本挑一个不会被互相污染的目录（<基础目录>-<MC版本>）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

/* ---------------- 版本号 ---------------- */

function parseVer(v) {
  const m = String(v || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** 判断 mcVersion 是否落在 Fabric 风格的范围表达式里。解析不了的按"兼容"处理，宁可不拦。 */
function satisfies(mcVersion, range) {
  const cur = parseVer(mcVersion);
  if (!cur) return true;
  const expr = String(range || '*').trim();
  if (!expr || expr === '*') return true;
  // Fabric 用空格分隔多个子句，全部满足才算通过
  for (const rawClause of expr.split(/\s+/)) {
    const clause = rawClause.trim();
    if (!clause || clause === '*') continue;
    // 末尾的 '-' 在 Fabric 语义里表示"含预发布"，对比较无影响
    const bare = clause.replace(/-$/, '');
    const m = bare.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
    if (!m) return true;
    const op = m[1] || '=';
    const target = parseVer(m[2]);
    if (!target) return true;
    const c = cmp(cur, target);
    if (op === '>=' && !(c >= 0)) return false;
    else if (op === '<=' && !(c <= 0)) return false;
    else if (op === '>' && !(c > 0)) return false;
    else if (op === '<' && !(c < 0)) return false;
    else if (op === '=' && !(c === 0)) return false;
    else if (op === '~' || op === '^') {
      // ~1.21.6 → >=1.21.6 <1.22.0 ; ^1.21.6 → >=1.21.6 <2.0.0
      if (!(c >= 0)) return false;
      const upper = op === '~' ? [target[0], target[1] + 1, 0] : [target[0] + 1, 0, 0];
      if (!(cmp(cur, upper) < 0)) return false;
    }
  }
  return true;
}

/* ---------------- 版本 JSON ---------------- */

function readGzJson(file) {
  try {
    const raw = fs.readFileSync(file);
    return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
}

/** 沿着 inheritsFrom 找到真正的基础 MC 版本 */
async function resolveMcVersion(root, versionId) {
  const dir = path.join(root, 'versions');
  let cur = versionId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const file = path.join(dir, cur, `${cur}.json`);
    let json = null;
    try {
      json = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      break;
    }
    if (json.inheritsFrom) {
      cur = json.inheritsFrom;
      continue;
    }
    return cur;
  }
  return null;
}

/* ---------------- mods 检查 ---------------- */

/** 从 jar 里读 fabric.mod.json（只读中央目录，不整包解压） */
async function readModMeta(jarPath) {
  try {
    const stat = await fsp.stat(jarPath);
    const fd = await fsp.open(jarPath, 'r');
    try {
      // 定位 EOCD
      const tailLen = Math.min(stat.size, 66 * 1024);
      const tail = Buffer.alloc(tailLen);
      await fd.read(tail, 0, tailLen, stat.size - tailLen);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) return null;
      const cdCount = tail.readUInt16LE(eocd + 10);
      let off = tail.readUInt32LE(eocd + 16);
      // 遍历中央目录找 fabric.mod.json
      for (let n = 0; n < cdCount; n++) {
        const head = Buffer.alloc(46);
        await fd.read(head, 0, 46, off);
        if (head.readUInt32LE(0) !== 0x02014b50) break;
        const nameLen = head.readUInt16LE(28);
        const extraLen = head.readUInt16LE(30);
        const commentLen = head.readUInt16LE(32);
        const localOff = head.readUInt32LE(42);
        const nameBuf = Buffer.alloc(nameLen);
        await fd.read(nameBuf, 0, nameLen, off + 46);
        const name = nameBuf.toString('utf8');
        if (name === 'fabric.mod.json') {
          // 读本地头，拿到真实数据偏移
          const lh = Buffer.alloc(30);
          await fd.read(lh, 0, 30, localOff);
          const lNameLen = lh.readUInt16LE(26);
          const lExtraLen = lh.readUInt16LE(28);
          const compSize = head.readUInt32LE(20);
          const method = head.readUInt16LE(10);
          const dataOff = localOff + 30 + lNameLen + lExtraLen;
          const comp = Buffer.alloc(compSize);
          await fd.read(comp, 0, compSize, dataOff);
          const raw =
            method === 0 ? comp : zlib.inflateRawSync(comp, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
          return JSON.parse(raw.toString('utf8'));
        }
        off += 46 + nameLen + extraLen + commentLen;
      }
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
  return null;
}

/** 扫描 mods 目录，找出与目标 MC 版本不兼容的模组 */
async function checkMods(gameDir, mcVersion) {
  const dir = path.join(gameDir, 'mods');
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return { exists: false, total: 0, bad: [] };
  }
  const bad = [];
  for (const f of files) {
    const meta = await readModMeta(path.join(dir, f));
    if (!meta) continue; // 非 Fabric 模组或读不出：不判
    const dep = meta.depends && meta.depends.minecraft;
    if (!dep) continue;
    const ranges = Array.isArray(dep) ? dep : [dep];
    const ok = ranges.some((r) => satisfies(mcVersion, typeof r === 'string' ? r : ''));
    if (!ok) {
      bad.push({
        file: f,
        id: meta.id || f,
        name: (meta.name && (meta.name['zh_cn'] || meta.name.en_us)) || meta.name || meta.id || f,
        range: ranges.join(' / '),
      });
    }
  }
  return { exists: true, total: files.length, bad };
}

/**
 * 为某个版本挑游戏目录。
 * 顺序：显式映射 → 同级 <base>-<mcVersion>（存在即用）→ 基础目录。
 */
async function resolveGameDir(base, mcVersion, versionGameDirs) {
  if (versionGameDirs && mcVersion && versionGameDirs[mcVersion]) {
    return { dir: versionGameDirs[mcVersion], reason: 'mapped' };
  }
  if (mcVersion) {
    const sibling = `${base}-${mcVersion}`;
    try {
      const st = await fsp.stat(sibling);
      if (st.isDirectory()) return { dir: sibling, reason: 'sibling' };
    } catch {
      /* 不存在就继续 */
    }
  }
  return { dir: base, reason: 'base' };
}

module.exports = { parseVer, satisfies, resolveMcVersion, checkMods, resolveGameDir, readModMeta };
