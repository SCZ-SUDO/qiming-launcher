'use strict';
/**
 * selftest.js — 纯 Node 自检：不启动 GUI，直接验证核心引擎
 * 用法：node tools/selftest.js [--full]
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ver = require('../src/core/version');
const inst = require('../src/core/installer');
const javac = require('../src/core/java');
const net = require('../src/core/net');
const zip = require('../src/core/zip');
const launcher = require('../src/core/launcher');

const FULL = process.argv.includes('--full');
const ROOT = path.join(os.tmpdir(), 'qiming-selftest');
const RUNTIME = path.join(os.tmpdir(), 'qiming-selftest-runtime');

const TRACE = path.join(__dirname, '..', 'selftest-trace.txt');
const trace = (msg) => {
  try {
    fs.appendFileSync(TRACE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};
fs.writeFileSync(TRACE, '', 'utf8');
process.on('uncaughtException', (e) => {
  trace('UNCAUGHT ' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
process.on('unhandledRejection', (e) => {
  trace('UNHANDLED ' + (e && e.stack ? e.stack : e));
});
process.on('exit', (c) => trace('EXIT ' + c));

let pass = 0;
let fail = 0;
const results = [];
let legacyNatives = [];
const nativeOk = (list) => Array.isArray(list) && list.length > 0;

function check(name, ok, detail = '') {
  trace(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  if (ok) {
    pass++;
    results.push(`  PASS  ${name}${detail ? '  —  ' + detail : ''}`);
  } else {
    fail++;
    results.push(`  FAIL  ${name}${detail ? '  —  ' + detail : ''}`);
  }
  return ok;
}

const t0 = Date.now();

(async () => {
  results.push('启明启动器 · 核心自检');
  results.push(`平台 ${process.platform}/${process.arch} · Node ${process.version} · 工作目录 ${ROOT}`);
  results.push('');

  await net.ensureDir(ROOT);

  /* 1. 版本清单 */
  let manifest = null;
  try {
    manifest = await ver.getManifest(ROOT, { force: true });
    check('拉取 Mojang 版本清单', Array.isArray(manifest.versions) && manifest.versions.length > 500, `${manifest.versions.length} 个版本，最新正式版 ${manifest.latest.release}`);
  } catch (e) {
    check('拉取 Mojang 版本清单', false, e.message);
    return finish();
  }

  /* 2. 版本 JSON */
  const latestId = manifest.latest.release;
  let merged = null;
  try {
    const chain = await ver.resolveChain(ROOT, latestId, manifest);
    merged = ver.mergeChain(chain);
    check('解析版本 JSON', !!merged.mainClass && (merged.libraries || []).length > 10, `${latestId} → mainClass=${merged.mainClass}, ${merged.libraries.length} 个库`);
    check('继承链合并字段', !!merged.assetIndex && !!merged.jarDownloads && !!merged.javaVersion, `assetIndex=${merged.assetIndex && merged.assetIndex.id}, jar=${merged.jar}, Java=${ver.requiredJava(merged)}`);
  } catch (e) {
    check('解析版本 JSON', false, e.message);
    return finish();
  }

  /* 3. 库规则 */
  try {
    const { libs, natives } = ver.collectLibraries(merged);
    const lwjgl = libs.filter((l) => l.path.includes('lwjgl'));
    check('按操作系统过滤依赖库', libs.length > 5 && !libs.some((l) => l.path.includes('natives-windows') && process.platform !== 'win32'), `${libs.length} 个库（其中 LWJGL ${lwjgl.length}）`);
    const modernNatives = libs.filter((l) => /natives-(windows|macos|macos-arm64|linux)/.test(l.path));
    check('现代版本 natives（classpath 方式）', nativeOk(modernNatives), `${modernNatives.length} 个平台 natives 包：${modernNatives.slice(0, 2).map((l) => path.basename(l.path)).join(', ') || '无'}`);
    check('路径推断（maven）', ver.mavenToPath('org.ow2.asm:asm:9.6') === 'org/ow2/asm/asm/9.6/asm-9.6.jar');
  } catch (e) {
    check('按操作系统过滤依赖库', false, e.message);
  }

  /* 3b. 老版本 natives 解包清单（1.16.5，走 classifiers + extract） */
  try {
    const legacyId = '1.16.5';
    if (manifest.versions.some((v) => v.id === legacyId)) {
      const legacy = ver.mergeChain(await ver.resolveChain(ROOT, legacyId, manifest));
      const { natives } = ver.collectLibraries(legacy);
      legacyNatives = natives;
      check('老版本 natives 解析（1.16.5）', natives.length > 0, `${natives.length} 个 natives 包${natives[0] ? '，首个 ' + path.basename(natives[0].path) : ''}`);
      const cmd = ver.buildCommand({
        merged: legacy,
        classpath: [path.join(ROOT, 'versions', legacyId, legacyId + '.jar')],
        nativesDir: path.join(ROOT, 'versions', legacyId, 'natives'),
        gameDir: ROOT,
        assetsDir: path.join(ROOT, 'assets'),
        assetIndexName: legacy.assetIndex && legacy.assetIndex.id,
        auth: { name: 'Tester', uuid: ver.offlineUuid('Tester'), accessToken: '0'.repeat(32) },
        memory: 2048,
      });
      check('老版本参数（minecraftArguments 分支）', cmd.game.includes('--username') && cmd.jvm.includes('-cp'), `jvm ${cmd.jvm.length} 项 / game ${cmd.game.length} 项`);
    } else {
      check('老版本 natives 解析（1.16.5）', true, '清单中无 1.16.5，跳过');
    }
  } catch (e) {
    check('老版本 natives 解析（1.16.5）', false, e.message);
  }

  /* 4. 启动参数 */
  try {
    const { libs } = ver.collectLibraries(merged);
    const classpath = libs.map((l) => path.join(ROOT, 'libraries', l.path));
    classpath.push(path.join(ROOT, 'versions', merged.jar, merged.jar + '.jar'));
    const cmd = ver.buildCommand({
      merged,
      classpath,
      nativesDir: path.join(ROOT, 'versions', latestId, 'natives'),
      gameDir: ROOT,
      assetsDir: path.join(ROOT, 'assets'),
      assetIndexName: merged.assetIndex.id,
      auth: { name: 'Tester', uuid: ver.offlineUuid('Tester'), accessToken: '0'.repeat(32) },
      memory: 4096,
      width: 1280,
      height: 720,
    });
    const flat = cmd.jvm.concat([cmd.mainClass], cmd.game);
    check('拼装 JVM 参数', cmd.jvm.includes('-cp') && cmd.jvm.some((a) => a.startsWith('-Xmx')), `${cmd.jvm.length} 项`);
    check('拼装游戏参数占位符', cmd.game.includes('--username') && cmd.game.includes('Tester') && !flat.some((a) => /\$\{.*\}/.test(a)), `${cmd.game.length} 项`);
    check('离线 UUID 生成', /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ver.offlineUuid('Tester')), ver.offlineUuid('Tester'));
  } catch (e) {
    check('拼装启动参数', false, e.message);
  }

  /* 5. 下载 + 校验 */
  try {
    const dest = path.join(ROOT, 'cache', 'manifest-copy.json');
    await net.downloadOne(ver.MANIFEST_URL, dest, {});
    const size1 = (await fsp.stat(dest)).size;
    const again = await net.downloadOne(ver.MANIFEST_URL, dest, {});
    check('HTTP 下载 + 跳过已存在文件', size1 > 10000 && again.skipped === true, `${(size1 / 1024).toFixed(0)} KB`);
    const sha = await net.sha1File(dest);
    check('SHA1 校验', /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 12) + '…');
  } catch (e) {
    check('HTTP 下载', false, e.message);
  }

  /* 6. ZIP 解包（真实 natives jar） */
  try {
    const natives = legacyNatives;
    if (natives.length) {
      const n = natives.find((x) => x.size < 8 * 1024 * 1024) || natives[0];
      const jar = path.join(ROOT, 'cache', 'natives-test.jar');
      await net.downloadOne(n.url, jar, { sha1: n.sha1, size: n.size });
      const out = path.join(ROOT, 'cache', 'natives-out');
      await fsp.rm(out, { recursive: true, force: true });
      const count = await zip.extractFile(jar, out, { exclude: ['META-INF/'] });
      const files = await fsp.readdir(out);
      check('ZIP 解包 natives', count > 0 && files.length > 0, `${path.basename(n.path)} → ${count} 个文件：${files.slice(0, 3).join(', ')}`);
    } else {
      check('ZIP 解包 natives', true, '该版本无独立 natives（跳过）');
    }
  } catch (e) {
    check('ZIP 解包 natives', false, e.message);
  }

  /* 7. Java */
  try {
    const list = await javac.detect({ runtimeRoots: [RUNTIME] });
    check('Java 探测', true, list.length ? list.map((j) => `Java ${j.major}@${j.path.slice(-28)}`).join(' | ') : '本机未安装 Java（启动时将自动下载 Temurin）');
    if (list.length) {
      const need = ver.requiredJava(merged);
      const picked = await javac.pick({ required: need, runtimeRoots: [RUNTIME] });
      check(`匹配 Java ${need}`, !!picked, picked ? `${picked.version}（${picked.source}）` : '无匹配版本，将自动下载');
    }
  } catch (e) {
    check('Java 探测', false, e.message);
  }

  /* 8. 本地版本扫描 */
  try {
    const list = await inst.listInstalled(ROOT);
    check('扫描本地版本目录', Array.isArray(list), `${list.length} 个`);
  } catch (e) {
    check('扫描本地版本目录', false, e.message);
  }

  /* 9. Fabric 元数据（不下载游戏） */
  try {
    const list = await net.fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(latestId)}`, {});
    check('Fabric 加载器元数据', Array.isArray(list) && list.length > 0, `${list.length} 个 loader，最新 ${list[0].loader.version}`);
  } catch (e) {
    check('Fabric 加载器元数据', false, e.message);
  }

  /* 10. Adoptium 运行时源 */
  try {
    const info = await net.fetchJson('https://api.adoptium.net/v3/info/available_releases', {});
    check('Adoptium Java 源', Array.isArray(info.available_releases) && info.available_releases.length > 5, `可下载 Java ${info.available_releases.slice(-3).join('/')}`);
  } catch (e) {
    check('Adoptium Java 源', false, e.message);
  }

  if (FULL) {
    /* 完整安装测试（把 latest 正式版真正装下来，约 300–600 MB） */
    results.push('');
    results.push('  ---- 完整安装测试（--full）----');
    let lastPhase = '';
    let lastTick = 0;
    try {
      const r = await inst.installVersion({
        root: ROOT,
        versionId: latestId,
        manifest,
        emit: (p) => {
          if (p.phase !== lastPhase || Date.now() - lastTick > 2000) {
            lastPhase = p.phase;
            lastTick = Date.now();
            results.push(`        [${p.phase}] ${p.label} ${p.percent ? Math.round(p.percent * 100) + '%' : ''}`);
          }
        },
      });
      check('完整安装版本', r.libraries > 0, `${r.id} · ${r.libraries} 库 / ${r.natives} natives`);
      const prepared = await launcher.prepare({
        root: ROOT,
        versionId: latestId,
        manifest,
        config: { gameDir: ROOT, username: 'Tester', memoryMB: 2048, width: 1280, height: 720, runtimeRoot: RUNTIME },
        onLog: () => {},
      });
      check('启动前装配（classpath + Java）', prepared.classpath.length > 5 && !!prepared.java, `${prepared.classpath.length} 项 classpath · ${prepared.java.version}`);
    } catch (e) {
      check('完整安装版本', false, e.message);
    }
  }

  finish();

  function finish() {    const cost = ((Date.now() - t0) / 1000).toFixed(1);
    results.push('');
    results.push(`结果：${pass} PASS / ${fail} FAIL · 耗时 ${cost}s`);
    const text = results.join('\n');
    console.log(text);
    fs.writeFileSync(path.join(__dirname, '..', 'selftest-report.txt'), text + '\n', 'utf8');
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => {
  console.error('自检崩溃：', e);
  process.exit(2);
});
