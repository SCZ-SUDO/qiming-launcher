'use strict';
/**
 * launcher.js — 组装 classpath 与启动命令，拉起 Java 进程
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const net = require('./net');
const ver = require('./version');
const inst = require('./installer');
const javac = require('./java');

const P = ver.paths;

async function prepare({ root, versionId, manifest, config, onLog, emit }) {
  const chain = await ver.resolveChain(root, versionId, manifest);
  const merged = ver.mergeChain(chain);
  const pp = P(root);
  const gameDir = config.gameDir || root;
  await net.ensureDir(gameDir);

  // 1. 补齐文件（幂等，已存在会跳过）
  await inst.installVersion({ root, versionId, emit, manifest });
  const chain2 = await ver.resolveChain(root, versionId, manifest);
  const merged2 = ver.mergeChain(chain2);

  // 2. classpath
  const { libs, natives } = ver.collectLibraries(merged2);
  const classpath = [];
  const missing = [];
  for (const lib of libs) {
    const full = path.join(pp.libraries, lib.path);
    try {
      await fsp.access(full);
      classpath.push(full);
    } catch {
      missing.push(lib.path);
    }
  }
  if (missing.length) onLog({ level: 'warn', text: `有 ${missing.length} 个依赖库缺失，已跳过` });
  const jar = pp.versionJar(merged2.jar);
  classpath.push(jar);

  const nativesDir = pp.natives(merged2.id);
  await net.ensureDir(nativesDir);
  const assetsDir = pp.assets;
  const assetIndexName = merged2.assetIndex ? merged2.assetIndex.id : merged2.assets;

  // 3. Java
  const required = ver.requiredJava(merged2);
  const component = (merged2.javaVersion && merged2.javaVersion.component) || null;
  onLog({ level: 'info', text: `需要 Java ${required}${component ? '（' + component + '）' : ''}，正在定位运行时…` });
  const java = await javac.ensure({
    required,
    component,
    runtimeRoot: path.join(config.runtimeRoot || path.join(root, 'runtime')),
    preferred: config.javaPath || null,
    emit,
  });
  onLog({ level: 'ok', text: `使用 Java：${java.version}（${java.path}）` });

  // 4. 命令
  const auth = {
    name: config.username || 'Steve',
    uuid: ver.offlineUuid(config.username || 'Steve'),
    accessToken: '00000000000000000000000000000000',
  };
  const { jvm, game, mainClass } = ver.buildCommand({
    merged: merged2,
    classpath,
    nativesDir,
    gameDir,
    assetsDir,
    assetIndexName,
    auth,
    memory: config.memoryMB,
    extraJvm: config.extraJvm,
    width: config.width,
    height: config.height,
    fullscreen: config.fullscreen,
  });

  return { merged: merged2, java, jvm, game, mainClass, classpath, gameDir, nativesCount: natives.length };
}

async function launch({ root, versionId, manifest, config, onLog, emit, onExit }) {
  const prep = await prepare({ root, versionId, manifest, config, onLog, emit });
  const args = [...prep.jvm, prep.mainClass, ...prep.game];
  onLog({ level: 'cmd', text: `"${prep.java.path}" ${args.length} 个参数` });
  onLog({ level: 'info', text: `启动 ${prep.merged.id}（classpath ${prep.classpath.length} 项）…` });

  const child = spawn(prep.java.path, args, {
    cwd: prep.gameDir,
    windowsHide: false,
    env: { ...process.env, PATH: `${path.dirname(prep.java.path)}${path.delimiter}${process.env.PATH || ''}` },
  });

  let logSize = 0;
  const handle = (buf, level) => {
    const text = buf.toString('utf8');
    // 游戏自己的日志另外落盘
    appendLog(prep.gameDir, text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      onLog({ level, text: line });
    }
    logSize += text.length;
  };
  child.stdout.on('data', (b) => handle(b, 'game'));
  child.stderr.on('data', (b) => handle(b, 'game'));

  child.on('error', (e) => onLog({ level: 'error', text: `启动失败：${e.message}` }));
  child.on('exit', (code, signal) => {
    onLog({ level: code === 0 ? 'ok' : 'error', text: `游戏进程退出，code=${code}${signal ? ' signal=' + signal : ''}` });
    if (onExit) onExit({ code, signal });
  });

  return { child, pid: child.pid, prep };
}

function appendLog(gameDir, text) {
  try {
    const dir = path.join(gameDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'qiming-launcher.log'), text);
  } catch {}
}

module.exports = { prepare, launch };
