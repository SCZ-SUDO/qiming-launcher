# 启明 · Qiming Launcher

跨平台 Minecraft 启动器，自研实现。macOS 原生优先，同时可在 Windows / Linux 运行。

> 说明：启明与 Plain Craft Launcher（PCL）**没有任何代码或资源关系**。PCL 是闭源软件，
> 反编译复刻属于侵权，因此这里是从零实现的独立启动器，只在信息结构与操作习惯上参考了同类产品。

---

## 它做了什么

| 模块 | 能力 |
| --- | --- |
| 版本安装 | 直连 Mojang `piston-meta` 清单，正式版 / 快照 / 远古版本全集（当前 920 个） |
| 依赖装配 | 自动解析 `libraries` 的 os/arch 规则、继承链（`inheritsFrom`）、natives 解包、资源索引与 objects |
| 加载器 | Fabric、Quilt 一键安装（走官方 meta API，生成继承版本） |
| Java | 探测本机 JRE；缺失时下载 **Mojang 官方运行时**（版本精确、macOS ARM 原生），Adoptium 兜底 |
| 启动 | 完整 `arguments` / 旧版 `minecraftArguments` 双分支、离线 UUID（`OfflinePlayer:` MD5）、内存与窗口参数 |
| 界面 | 无边框自绘窗口、侧栏导航、任务进度条、实时运行日志、实时配置写入 |
| 数据 | 配置存本机 `userData/config.json`；首次启动自动识别已有 `.minecraft` |

### 尚未实现（有意留白）

- 微软 / Mojang 正版登录（当前为离线模式）
- Forge / NeoForge（需运行 installer，链路复杂，后续可加）
- 整合包（CurseForge / Modrinth）导入
- 模组下载与管理

---

## 在 macOS 上运行

**完整步骤见 [`安装说明-macOS.md`](安装说明-macOS.md)**（含传文件、装依赖、打包、绕过未签名拦截、首次启动行为、常见问题）。

最短路径：

```bash
cd Qiming-Launcher
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # 国内必设，否则 electron 二进制下不动
npm install
npm start                    # 直接运行
# 或
npm run dist:mac             # 出安装包
```

首次启动会自动探测 `~/Library/Application Support/minecraft`、`~/.minecraft`；
也可以在「设置 → 游戏目录」里指向任意已有的游戏目录（含整合包实例）。

### 打成 dmg

```bash
npm run dist:mac     # 产物：dist/Qiming-1.0.0-arm64.dmg / -x64.dmg（同时出 app 与 zip）
```

> **必须在 macOS 上打包。** electron-builder 无法在 Windows / Linux 上交叉构建 macOS 应用包，
> 因此 Windows 端只交付跨平台源码（`Qiming-Launcher-src.zip`）+ 打包配置，不含 dmg。

产物未做代码签名，首次打开需在「系统设置 → 隐私与安全性」里允许，
或 `xattr -dr com.apple.quarantine /Applications/Qiming.app`。

---

## 自检与实测

```bash
node tools/selftest.js          # 核心引擎 18 项自检（清单/解析/规则/参数/下载/解压/Java/加载器）
node tools/selftest.js --full   # 追加「完整下载安装 + 装配」实测（约数百 MB）
node tools/e2e.js               # 端到端：装配 → 取 Java → 真实拉起游戏 → 校验日志
node tools/makeicon.js          # 重新生成 1024×1024 应用图标
```

---

## 代码结构

```
main.js                Electron 主进程：窗口、菜单、IPC、安装/启动调度
preload.js             contextBridge 暴露的白名单 API
src/core/net.js        HTTP、并发下载、SHA1 校验、断点跳过
src/core/version.js    版本清单 / 继承链合并 / os 规则 / 库解析 / 启动参数拼装
src/core/installer.js  客户端、依赖库、natives、资源文件落盘；Fabric/Quilt 安装
src/core/java.js       Java 探测、版本识别、Mojang 运行时 / Adoptium 下载
src/core/launcher.js   classpath 装配、Java 进程拉起、日志回传
src/core/zip.js        纯 Node ZIP 解包（natives 用）
src/core/store.js      配置读写、游戏目录自动探测
renderer/              界面（原生 HTML/CSS/JS，无框架）
tools/                 自检、端到端实测、图标生成
```

### 几个关键实现细节

- **库解析顺序**：先按 `rules` 过滤 os/arch，再按 `group:artifact:classifier` 判重。
  顺序反了会导致 1.16.5 这类版本的 LWJGL `3.2.1/3.2.2` 互相挤掉、natives 全丢。
- **natives 两种形态**：`≤1.18` 走 `natives` 映射 + `classifiers` 下载后解包到 `versions/<id>/natives`；
  `≥1.19` 的 natives 是独立 artifact，直接进 classpath，由 LWJGL 自行释放。
- **Java 版本**：`javaVersion.majorVersion` + `javaVersion.component` 双字段，直取官方运行时，
  不猜版本、不依赖系统装了什么。
- **离线 UUID**：`MD5("OfflinePlayer:" + name)` 并置版本位，和服务端离线判定一致。

---

## 许可

MIT。仅用于个人使用；Minecraft 相关资源版权归 Mojang / Microsoft 所有。
