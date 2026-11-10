'use strict';
/**
 * net.js — HTTP / 下载 / 校验 / 并发控制（纯 Node，无 Electron 依赖）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const UA = 'QimingLauncher/1.0.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRaw(url, { tries = 3, timeout = 30000, headers } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, ...(headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts) {
  const res = await fetchRaw(url, opts);
  return res.json();
}

async function fetchText(url, opts) {
  const res = await fetchRaw(url, opts);
  return res.text();
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** 同名文件是否可信 */
async function isTrusted(file, { sha1, size }) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    if (size != null && st.size !== size) return false;
    if (sha1) {
      if (!size && st.size === 0) return false;
      return (await sha1File(file)) === sha1;
    }
    return st.size > 0 || size === 0;
  } catch {
    return false;
  }
}

/**
 * 下载单个文件到磁盘，返回 { skipped, bytes }
 * onStatus({ phase:'skip'|'download'|'done', bytes })
 */
async function downloadOne(url, dest, { sha1, size, onBytes, tries = 3, timeout = 120000 } = {}) {
  if (await isTrusted(dest, { sha1, size })) {
    let n = size;
    if (n == null) n = (await fsp.stat(dest)).size;
    if (onBytes) onBytes(n);
    return { skipped: true, bytes: n };
  }
  await ensureDir(path.dirname(dest));
  const tmp = dest + '.part';
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchRaw(url, { tries: 1, timeout });
      const total = Number(res.headers.get('content-length')) || size || 0;
      const fh = await fsp.open(tmp, 'w');
      let written = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await fh.write(value);
          written += value.length;
          if (onBytes) onBytes(value.length);
        }
      } finally {
        await fh.close();
      }
      if (total && written !== total) throw new Error(`长度不符 ${written}/${total}`);
      if (sha1) {
        const got = await sha1File(tmp);
        if (got !== sha1) throw new Error(`SHA1 不符 ${got}`);
      }
      await fsp.rm(dest, { force: true });
      await fsp.rename(tmp, dest);
      return { skipped: false, bytes: written, total };
    } catch (e) {
      lastErr = e;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

/** 并发映射 */
async function mapLimit(items, limit, worker, onTick) {
  const results = new Array(items.length);
  let cursor = 0;
  let finished = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { error: e };
      }
      finished++;
      if (onTick) onTick(finished, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 批量下载：自动按 size 汇总做进度
 * tasks: [{url, dest, sha1, size}]
 */
async function downloadAll(tasks, { concurrency = 48, onBytes, onTick } = {}) {
  const total = tasks.reduce((s, t) => s + (t.size || 0), 0);
  let done = 0;
  let lastEmit = 0;
  const emit = (n) => {
    done += n;
    const now = Date.now();
    if (onBytes && (now - lastEmit > 90)) {
      lastEmit = now;
      onBytes(done, total);
    }
  };
  const results = await mapLimit(
    tasks,
    concurrency,
    (t) => downloadOne(t.url, t.dest, { sha1: t.sha1, size: t.size, onBytes: emit }),
    onTick
  );
  if (onBytes) onBytes(done, total);
  const failed = results.filter((r) => r && r.error);
  if (failed.length) {
    const first = failed[0].error;
    const err = new Error(`有 ${failed.length} 个文件下载失败：${first.message}`);
    err.failures = failed.length;
    throw err;
  }
  return { total, done };
}

module.exports = {
  UA,
  sleep,
  fetchRaw,
  fetchJson,
  fetchText,
  sha1File,
  ensureDir,
  isTrusted,
  downloadOne,
  downloadAll,
  mapLimit,
};
