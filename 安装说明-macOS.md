# 启明 · 在 macOS 上安装与运行

> 本文件随源码一起分发。Windows 无法交叉构建 macOS 的 `.dmg`，所以 Mac 版必须在你自己的 Mac 上打一次包。全程约 3–8 分钟（取决于网速）。

---

## 一、把工程弄到 Mac 上

任选一种，推荐第 1 种。

### 1. 打包成 zip 带走（最简单）

Windows 上已经生成了 `Qiming-Launcher-src.zip`，通过 AirDrop / 微信文件传输 / U 盘 / 网盘拿到 Mac，双击解压到「桌面」，得到 `Qiming-Launcher` 文件夹。

### 2. 用 U 盘 / 移动硬盘

直接拷贝整个 `Qiming-Launcher` 文件夹（**不要**带 `node_modules` 和 `dist`，这两个是 Windows 专用的，带过去反而要重装）。

---

## 二、Mac 上的安装步骤

打开「终端」（Terminal），一次粘贴一段。

### 步骤 0：装 Node.js（如已装可跳过）

先确认：

```bash
node -v
```

如果提示 `command not found`，装一下（有 Homebrew 的话）：

```bash
brew install node
```

没 Homebrew 就去 https://nodejs.org 下 `LTS` 的 `.pkg` 双击安装。要求 Node ≥ 18。

### 步骤 1：进目录

```bash
cd ~/Desktop/Qiming-Launcher
```

> 如果你解压到别处，把路径换成实际路径。可以输入 `cd ` （带空格）后把文件夹直接拖进终端窗口，路径会自动补全。

### 步骤 2：装依赖（国内务必先设镜像，否则 Electron 二进制会卡住）

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install
```

看到 `added xxx packages` 就是成功了。

### 步骤 3（推荐）：先直接跑一下，确认能用

```bash
npm start
```

窗口起来就是可用状态，这一步不产生安装包。确认没问题后 `Cmd + Q` 退出。

### 步骤 4：打成 .dmg 安装包

```bash
npm run dist:mac
```

产物在 `dist/` 里：

- Apple 芯片（M1/M2/M3/M4）→ `Qiming-1.0.0-arm64.dmg`
- Intel 芯片 → `Qiming-1.0.0-x64.dmg`

不确定自己是哪种芯片：

```bash
uname -m
```

`arm64` = Apple 芯片，`x86_64` = Intel。

### 步骤 5：安装并绕过"未签名"拦截

双击对应的 `.dmg`，把 **Qiming** 拖进 `Applications`（应用程序）文件夹。

首次打开会被 Gatekeeper 拦住（提示"无法验证开发者"），二选一放行：

**方式 A（推荐，一劳永逸）：**

```bash
xattr -dr com.apple.quarantine /Applications/Qiming.app
```

然后正常双击打开。

**方式 B（图形界面）：**
右键点 `Qiming.app` → 「打开」→ 弹窗里再点「打开」。

> 之后就能像普通 App 一样双击启动了。这个拦截不是病毒，只是因为我没有 Apple 开发者证书（一年 99 美元）给它做签名和公证。

---

## 三、首次启动会发生什么

| 项目 | 默认行为 |
| --- | --- |
| **Java** | 不需要你自己装。首次启动游戏时，会自动从 Mojang 官方下载 macOS 原生 Java 运行时（约 90MB，存在游戏目录 `runtime/` 下），下完自动使用。如果本机已有可用的 Java 会优先用本机的。 |
| **游戏目录** | 首次启动自动探测 `~/Library/Application Support/minecraft`。如果是全新的 Mac，会创建这个目录。也可以在「设置」里改成你已有的 `.minecraft` 路径。 |
| **玩家名** | 离线模式，随便填，用于生成离线 UUID。 |
| **内存** | 默认值够用，可在「设置」里拖。 |

后续要玩游戏：打开 App → 首页填玩家名 → 在版本下拉里选一个版本 → 「安装」→ 装完点「启动游戏」。

---

## 四、常见问题

**Q：`npm install` 卡在 electron 那一步不动？**
没设镜像。回到步骤 2，先 `export ELECTRON_MIRROR=...` 再 `npm install`。已经卡住的话 `Ctrl + C` 中断，删掉 `node_modules` 重来。

**Q：`npm run dist:mac` 报 `Cannot find module 'dmg-license'`？**
少数情况会缺这个可选依赖，补一句：`npm i -D dmg-license`，再重跑。

**Q：打出来的包打开闪退？**
在终端里跑 `/Applications/Qiming.app/Contents/MacOS/Qiming` 看报错输出。多半是没做 `xattr` 放行，或者 arm64/x64 拿错了。

**Q：只想要个 App，不想要 dmg？**
`npm run dist:mac` 同时也会产出 `dist/mac-arm64/Qiming.app`（或 `mac/`），直接把这个 `.app` 拖进 `Applications` 也一样。

**Q：能连我的微软正版账号吗？**
当前版本只做离线登录。微软 OAuth 登录、Forge/NeoForge、整合包导入还没做，见 `CHANGELOG.md` 的「未实现」一节。

---

## 五、给开发者：自检

想验证这套代码在你 Mac 上跑得通：

```bash
npm test          # 18 项核心逻辑断言，约 20 秒
npm test -- --full   # 额外走一遍真实下载安装（较慢）
```

结果会写到 `selftest-report.txt`。
