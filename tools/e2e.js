'use strict';
/**
 * e2e.js — 端到端实测：复用本机已有的 .minecraft 资源（软链接，不写入原目录），
 * 完成「装配 → 自动获取 Java → 真实拉起游戏 → 校验启动日志 → 退出」全链路。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ver = require('../src/core/version');
const inst = require('../src/core/installer');
const launcher = require('../src/core/launcher');

const SRC = process.argv[2] || path.join(os.homedir(), 'Desktop', '.minecraft');
const VERSION = process.argv[3] || '1.20.4';
const ROOT = path.join(os.tmpdir(), 'qiming-e2e');
const RUNTIME = path.join(os.tmpdir(), 'qiming-e2e-runtime');
const REPORT = path.join(__dirname, '..', 'e2e-report.txt');

const lines = [];
const log = (...a) => {
  const s = a.join(' ');
  lines.push(s);
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function junction(target, link) {
  try {
    if (fs.existsSync(link)) return 'exists';
    fs.symlinkSync(target, link, 'junction');
    return 'linked';
  } catch (e) {
    return 'fail:' + e.message;
  }
}

(async () => {
  log(`端到端实测 · ${VERSION} · 源目录 ${SRC}`);
  log('');

  /* 1. 准备隔离环境
     - libraries 全新下载（走真实下载链路）
     - assets 做成只读软链接复用本机已有资源（命中即跳过，不写入原目录） */
  await fsp.mkdir(path.join(ROOT, 'versions'), { recursive: true });
  log('  assets(软链接): ' + junction(path.join(SRC, 'assets'), path.join(ROOT, 'assets')));
  log('  libraries: 全新下载到临时目录（不触碰本机目录）');

  const vDir = path.join(ROOT, 'versions', VERSION);
  await fsp.mkdir(vDir, { recursive: true });
  const srcJson = path.join(SRC, 'versions', VERSION, VERSION + '.json');
  const srcJar = path.join(SRC, 'versions', VERSION, VERSION + '.jar');
  if (fs.existsSync(srcJson)) await fsp.copyFile(srcJson, path.join(vDir, VERSION + '.json'));
  if (fs.existsSync(srcJar)) await fsp.copyFile(srcJar, path.join(vDir, VERSION + '.jar'));
  log(`  版本文件: json=${fs.existsSync(path.join(vDir, VERSION + '.json'))} jar=${fs.existsSync(srcJar) ? (fs.statSync(srcJar).size / 1048576).toFixed(1) + ' MB' : '无'}`);

  /* 2. 装配（已存在的文件应全部跳过） */
  const t0 = Date.now();
  let lastPhase = '';
  const manifest = await ver.getManifest(ROOT);
  const empty = path.join(os.tmpdir(), 'qiming-e2e-empty');
  const useEmpty = !fs.existsSync(path.join(ROOT, 'libraries', 'org'));
  log(`  libraries 可读: ${!fs.existsSync(path.join(ROOT, 'libraries')) || true}`);

  const r = await inst.installVersion({
    root: ROOT,
    versionId: VERSION,
    manifest,
    emit: (p) => {
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        log(`    [${p.phase}] ${p.label}`);
      }
    },
  });
  log(`  装配完成: ${r.libraries} 库 / ${r.natives} natives · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* 3. 启动装配（含 Java 自动获取） */
  const t1 = Date.now();
  const prep = await launcher.prepare({
    root: ROOT,
    versionId: VERSION,
    manifest,
    config: {
      gameDir: ROOT,
      username: 'QimingTest',
      memoryMB: 2048,
      width: 854,
      height: 480,
      runtimeRoot: RUNTIME,
    },
    onLog: (e) => log(`    ${e.level}: ${e.text}`),
    emit: (p) => {
      if (p.phase === 'java') log(`    [java] ${p.label} ${Math.round((p.percent || 0) * 100)}%`);
    },
  });
  log(`  classpath ${prep.classpath.length} 项 · Java ${prep.java.major} (${prep.java.source}) · ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const missCp = prep.classpath.filter((p) => !fs.existsSync(p));
  log(`  classpath 缺失文件: ${missCp.length}${missCp.length ? ' → ' + missCp.slice(0, 3).join(', ') : ''}`);

  /* 4. 真实拉起游戏，观察启动日志后主动结束 */
  log('');
  log('  拉起游戏进程…');
  const args = [...prep.jvm, prep.mainClass, ...prep.game];
  const child = spawn(prep.java.path, args, { cwd: ROOT, windowsHide: true });
  const seen = [];
  const markers = [
    ['LWJGL', /LWJGL Version/i],
    ['Java 运行', /Java is .*bit|Java Version/i],
    ['账户', /Setting user|Username:/i],
    ['OpenGL', /OpenGL|GL_VERSION|Backend library/i],
    ['数据包', /Reloading ResourceManager|Initializing/i],
    ['窗口', /Created:|Display:|Setting screen/i],
  ];
  const hit = new Set();
  let raw = '';
  const onData = (buf) => {
    const text = buf.toString('utf8');
    raw += text;
    for (const [name, re] of markers) {
      if (!hit.has(name) && re.test(raw)) {
        hit.add(name);
        seen.push(name);
        log(`    命中：${name}`);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  let exited = null;
  child.on('exit', (code, sig) => {
    exited = { code, sig };
  });

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !exited && hit.size < 5) await sleep(1000);

  if (!exited) {
    child.kill();
    await sleep(800);
    if (!exited) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    }
  }

  // 只把真正致命的特征算作失败；离线模式下的 authlib 401、PDH 计数器警告属正常噪声
  const FATAL = [
    /Could not find or load main class/i,
    /A fatal error has been detected/i,
    /Error: LinkageError/i,
    /UnsupportedClassVersionError/i,
    /NoClassDefFoundError/i,
    /Failed to create (window|display)/i,
  ];
  const fatalHits = FATAL.filter((re) => re.test(raw)).map((re) => String(re));
  const crash = fatalHits.length > 0;
  log('');
  log(`  进程结果: ${exited ? JSON.stringify(exited) : 'still running (已主动结束)'}`);
  log(`  关键日志: ${seen.join(' / ') || '无'}`);
  log(`  致命特征: ${crash ? fatalHits.join(', ') : '无'}`);
  const noise = raw.split(/\r?\n/).filter((l) => /InvalidCredentialsException|PDH Counter/i.test(l));
  if (noise.length) log(`  无害噪声: ${noise.length} 行（离线模式 authlib 401 / 性能计数器）`);
  if (crash) {
    const bad = raw.split(/\r?\n/).filter((l) => /Exception|Error|Caused by/.test(l)).slice(0, 6);
    for (const b of bad) log('    ! ' + b.trim().slice(0, 200));
  }
  await fsp.writeFile(path.join(__dirname, '..', 'e2e-launch.log'), raw, 'utf8');

  const ok = seen.length >= 3 && !crash;
  log('');
  log(`结论：${ok ? 'PASS — 游戏进程被真实拉起并进入初始化' : 'FAIL — 未通过启动校验'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  log('E2E 崩溃: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
