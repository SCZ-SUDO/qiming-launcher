'use strict';
/**
 * zip.js — 极简 ZIP 读取/解包（纯 Node，支持 store/deflate，足够处理 natives 与 JRE 压缩包）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function listEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const off = entry.localOffset;
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('ZIP 局部头损坏');
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}`);
}

function safeJoin(destDir, name) {
  const cleaned = name.replace(/\\/g, '/');
  if (cleaned.split('/').includes('..')) return null;
  const target = path.join(destDir, cleaned);
  const rel = path.relative(destDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

async function extractFile(zipPath, destDir, { exclude = [] } = {}) {
  const buf = await fsp.readFile(zipPath);
  const entries = listEntries(buf);
  let written = 0;
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (exclude.some((p) => name.startsWith(p) || name.includes('/' + p))) continue;
    const target = safeJoin(destDir, name);
    if (!target) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const data = readEntry(buf, entry);
    await fsp.writeFile(target, data);
    written++;
  }
  return written;
}

module.exports = { listEntries, readEntry, extractFile };
