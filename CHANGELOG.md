# CHANGELOG · 启明启动器

## 未发布构建（2026-11-05）

### 新增：模组页（在线下载 + 本地导入）
- 左侧导航新增「模组」页，**自动对应当前选中版本**的实例目录
  （1.21.4 的版本就装进 `minecraft-1.21.4/mods`，不用手动切）
- **在线搜索**：Modrinth 公开 API，自动按「当前 MC 版本 + Fabric」过滤，只显示兼容的模组；
  点「安装」自动下载，并**递归安装必装前置**（`dependency_type=required`，带防环）
- **本地导入**：多选 `.jar`，读取 `fabric.mod.json` 判断是否适配当前版本，报告不兼容项
- **管理**：已装列表显示名称/版本/文件名/所需 MC 版本/体积；支持**启用·禁用**（重命名 `.jar.disabled`）
  与**删除**（移到废纸篓，可恢复）
- 安装进度与日志会实时打到首页日志区

### 修复
- 判重逻辑：原先用 jar 内的 `id` 去比 Modrinth 的 `project_id`（两者不同），导致每次都当新装。
  改为**按目标文件名判重**，已存在则跳过
- 安装接口在全部失败时（如项目不存在）原先返回 `ok:true`，现在如实返回 `ok:false` + 错误信息

## 未发布构建（2026-10-30）

### 修复
1. **Fabric/Quilt 加载器装不上**：`mavenUrl()` 在库没有 `downloads.artifact` 时忽略 `lib.url`，
   把 fabric 的 8 个库全拼到 `libraries.minecraft.net` → 全部 404。
   改为优先使用库自己声明的 maven 仓库。
2. **多版本共存时启动必崩**：一个游戏目录只有一份 `mods/`，切到别的 MC 版本时
   会把另一套模组装进去，Fabric 直接抛 `Incompatible mods found`。

### 新增
- `src/core/mods.js`：版本隔离核心
  - 沿 `inheritsFrom` 解析真实 MC 版本
  - 直接读 jar 内 `fabric.mod.json`（只解析中央目录，不解压整包）判断 mods 是否适配
  - 支持 `>=`/`<=`/`~`/`^`/精确值/`*` 与多子句范围（兼容 Fabric 的 `1.21.6-` 写法）
- 启动前按版本自动选择游戏目录：`<基础目录>-<MC版本>` 存在则自动使用（如 `minecraft-1.21.4`）
- 模组不兼容时给出**中文提示**（列出模组名与所需版本、当前目录、修复办法），不再让用户看英文堆栈

## v1.0.0 — 首版（自研实现）

从零写一个跨平台 MC 启动器，替代「反编译 PCL 复刻 Mac 版」的方案（那个是侵权的，不做）。

### 交付内容

- **核心引擎**（纯 Node，可独立自检）
  - 版本清单拉取 + 本地缓存（Mojang `piston-meta`，920 个版本）
  - 版本 JSON 继承链合并（`inheritsFrom`，支持 Fabric/Quilt 的父版本叠加）
  - os/arch 规则求值、maven 坐标解析、库去重（先过滤再判重）
  - natives 双形态：`≤1.18` classifiers 解包；`≥1.19` 独立 artifact 直接进 classpath
  - 资源索引 + objects 下载（64 并发）、legacy `virtual` / `map_to_resources` 映射
  - 启动参数双分支：`arguments.game/jvm` 与旧版 `minecraftArguments`
  - 离线 UUID：`MD5("OfflinePlayer:"+name)` + 版本位
- **Java 供给**：本机探测（macOS `/usr/libexec/java_home`、Homebrew、Windows 注册路径表）  
  → 缺失时下载 **Mojang 官方运行时**（按 `javaVersion.component` 精确匹配，macOS ARM 原生）  
  → Adoptium 兜底
- **加载器**：Fabric、Quilt 一键装（官方 meta API 生成继承版本）
- **界面**：无边框自绘窗口（macOS 用 hiddenInset 保留红绿灯，Windows 自绘按钮），  
  侧栏导航 / 快速选版 / 任务进度条 / 实时运行日志 / 实时写配置
- **打包**：electron-builder 配置好 mac dmg+zip（arm64 & x64）、win portable、linux AppImage
- **图标**：`tools/makeicon.js` 纯 Node 生成 1024×1024 PNG（无三方依赖）

### 修掉的三个真 bug（自检抓到的）

1. **JVM 参数没合并**：`buildCommand` 里动态参数数组拼好后忘了并入返回的命令，导致只带 7 个固定参数。
2. **库去重顺序错**：按 `group:artifact` 无条件判重，把 1.16.5 的 LWJGL `3.2.2`（windows/linux natives）  
   挤掉、只剩 mac 专用的 `3.2.1` → natives 全丢。改为「先按 rules 过滤，再判重」。
3. **带 natives 的库没进 classpath**：`natives` 分支直接 `continue`，漏掉了同一个库的 artifact 本体。  
   同时同一坐标存在「classpath 本体 / natives 附加包」两条记录，判重要区分。

### 验证

- `node tools/selftest.js` → **18 PASS / 0 FAIL**
- `node tools/e2e.js` → **PASS**：装配 64 库 → 自动取 Java 17（Mojang 官方，403 文件 87MB）  
  → 真实拉起 1.20.4 → 日志命中 `Setting user` / `LWJGL 3.3.2` / `OpenAL` / `Sound engine` / 纹理图集
- 界面路径实测：点「启动游戏」→ 进程拉起 → 界面切「运行中」，Java 自动识别为 17.0.15

### 已知限制

- 仅离线登录（无微软正版认证流程）
- 未支持 Forge / NeoForge（需运行 installer）、整合包导入、模组市场
- macOS 包未签名，首次打开需手动放行
- **macOS 安装包（dmg）必须在 Mac 上自行打一次**：开发环境为 Windows，electron-builder
  不支持跨平台构建 mac 包。交付物为源码包 `Qiming-Launcher-src.zip` + 完整的
  [`安装说明-macOS.md`](安装说明-macOS.md)。
