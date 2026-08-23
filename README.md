# DSH Desktop V1

把当前 DSH Web UI 封装成一个真正的 Windows 桌面应用。

双击 `DSH Desktop.exe` → 打开独立窗口 → 显示现有 DSH Web UI。不打开浏览器、不需要 PowerShell、不重新设计 UI、不复制 Web UI。**Desktop 只是现有 DSH Web UI 的 Desktop Host。**

---

## 1. 架构原则

Desktop **不是**新的 DSH Runtime，它只是：

```
Desktop Shell  →  连接 DSH Backend  →  显示现有 Web UI
```

关键事实（本仓库分析结论）：

> **DSH Backend 与 DSH Web UI 是同一个进程 / 同一个服务。**

`dsh web` 这一个 Node 进程同时承担：agent 运行时、`/api` HTTP + WebSocket、以及 serving 编译后的前端 `dist/` 并在 `index.html` 中注入 `window.__DSH_BOOT__`。

因此：

```
                  DSH Backend  (= dsh web 单进程)
                       │
        ┌──────────────┴──────────────┐
        │                             │
     Browser                     Desktop (Tauri)
        │                             │
     加载 http://127.0.0.1:3080/    加载 http://127.0.0.1:3080/
```

Browser 与 Desktop 都是「指向同一个 URL」的客户端，天然共用同一个 Backend，状态一致。

## 2. 启动状态机

```
STARTING
  └─ CHECK_EXISTING_BACKEND   (HTTP GET / → 200 且含 __DSH_BOOT__)
       ├─ 存在 → READY → LOAD_WEB_UI
       └─ 不存在 → START_BACKEND → HEALTH_CHECK → READY → LOAD_WEB_UI
```

- **第一优先级**：复用已存在的 Backend。
- 只有确认 Backend 不存在，才启动一个 Backend（生产：`dsh web --no-open`；开发 checkout：`node $DSH_REPO_PATH\apps\cli\lib\bin.js web --no-open`）。
- 检测是**真实健康检查**（HTTP 200 + `__DSH_BOOT__`），不是猜端口、不是 `sleep 5`。
- 超时（默认 60s）后给出明确错误，不无限等待。

## 3. Backend 生命周期

| 情况 | Desktop 退出时 |
|---|---|
| A. Desktop 启动前 Backend 已存在 | **不关闭**（Browser 可能还在用） |
| B. Desktop 自己启动的 Backend | **V1 保持运行**（最安全） |

Desktop 永不 kill 用户已有的 Backend。

## 4. 安全

- 不向 Web UI 暴露任何 Tauri IPC：`capabilities/default.json` 权限为**空**。
- Backend 启动完全在 Rust 内部完成，Web UI 无法触发、无法传参。
- 启动命令**固定/白名单化**：生产只允许 `dsh web --no-open`（PATH 上的官方命令），开发用 `node <DSH_REPO_PATH>\apps\cli\lib\bin.js web --no-open`，参数来自配置文件 / 环境变量 / 内置默认值，绝不来自运行时输入。
- 远程 DSH Web UI 通过 HTTP/WebSocket 直连 Backend，与浏览器行为一致，不经 Tauri 桥。

## 5. 目录结构

```
dsh-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── installer-hooks.nsh  # NSIS 钩子：卸载时校验「不删 CLI」
│   ├── capabilities/default.json
│   ├── icons/
│   └── src/
│       ├── main.rs          # 窗口 + 状态机线程调度
│       └── backend.rs       # 检测/启动/健康检查状态机
├── dist/
│   └── index.html           # 仅一个「Starting DSH…」加载页（非第二套 UI）
├── scripts/
│   ├── detect-dsh.ps1       # 检测 Backend 是否就绪
│   ├── start-dsh.ps1        # 启动 Backend（web --no-open）
│   ├── health-check.ps1     # 轮询直到就绪/超时
│   └── test-uninstall-regression.ps1  # 卸载 CLI 隔离回归测试
├── dsh-desktop.conf.example.json
├── package.json
└── README.md
```

`dist/index.html` 只是启动过渡页，**不是** DSH Web UI，也没有复制任何 UI 代码。

## 6. 前置条件（重要）

本机当前**未安装** Rust 与 MSVC C++ 构建工具。Tauri 在 Windows 上需要两者：

### 6.1 安装 Rust

1. 下载并运行 [rustup-init.exe](https://win.rustup.rs/)（默认 `stable-x86_64-pc-windows-msvc`）。
2. 或：`winget install Rustlang.Rustup`。

### 6.2 安装 MSVC 构建工具（Visual Studio Build Tools）

Tauri 需要 `cl.exe` / `link.exe`。二选一：

- **Visual Studio 2022 Build Tools**，勾选「使用 C++ 的桌面开发」工作负载：
  ```
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
  ```
- 或安装完整 Visual Studio 2022 Community，勾选「使用 C++ 的桌面开发」。

> WebView2 运行时本机已就绪（Windows 11 自带）。

### 6.3 验证

```powershell
rustc --version   # 应有输出
cargo --version   # 应有输出
```

## 7. 构建与运行

```powershell
# 一键构建（纯 cargo，无需 npm/Node）：校验工具链 + cargo build --release + 报告 exe 路径
.\scripts\build.ps1

# 或手动：
cd src-tauri
cargo build --release
# 产物：src-tauri/target/release/dsh-desktop.exe
```

> 发布构建只需 `cargo build --release`：Rust 外壳编译后会把 `dist/index.html` 与图标内嵌进 exe，无需 npm 依赖。`package.json` 仅用于可选的 `tauri dev`（开发热重载，需要 `pnpm install`）。
>
> `rust-toolchain.toml` 固定了 Rust `stable` + `x86_64-pc-windows-msvc` 目标，`rustup` 会自动采用。

> 图标：`src-tauri/icons/` 已含从官方 DSH `favicon.svg`（鲸鱼 Logo）生成的多尺寸 PNG + ICO；如需重新生成：`npx tauri icon app-icon.svg`。

## 8. 配置（可选）

Backend 地址 / Runtime 路径默认已内置。可通过环境变量覆盖（**优先级最高**）：

| 环境变量 | 说明 |
|---|---|
| `DSH_BACKEND_URL` | 例如 `http://127.0.0.1:8080/` |
| `DSH_REPO_PATH` | 可选（仅开发）：DeepSeek Harness 仓库根目录；设置后用 `node $DSH_REPO_PATH\apps\cli\lib\bin.js` 启动。**默认不设置**（生产直接调用 PATH 上的 `dsh` 命令）|
| `DSH_BACKEND_START_COMMAND` | 默认 `dsh`（生产模式）|
| `DSH_BACKEND_START_ARGS` | JSON 数组，`bin.js` 之后的固定参数，默认 `["web","--no-open"]` |
| `DSH_BACKEND_HEALTH_TIMEOUT_SEC` | 默认 `60` |

或把 `dsh-desktop.conf.example.json` 复制为 `dsh-desktop.conf.json` 放到 exe 同级目录（或用 `DSH_DESKTOP_CONFIG` 指定路径）。优先级：环境变量 > 配置文件 > 内置默认。

**日志**：写入 `%LOCALAPPDATA%\DSH\logs\dsh-desktop.log`（运行时自动创建目录；目录不可用时静默降级、不崩溃）。

## 9. 测试场景

| # | 场景 | 期望 |
|---|---|---|
| 1 | Backend 已运行 + Browser 已开 → 启动 Desktop | 复用现有 Backend，只存在一个 Backend |
| 2 | Desktop 关闭 | Browser 仍正常，Backend 不被杀 |
| 3 | Backend 未运行 → 启动 Desktop | 自动启动 Backend → 就绪 → 显示 UI |
| 4 | Backend 启动失败 | 超时后弹出明确错误，不无限等待 |
| 5 | Backend 已运行 → 启动 Desktop | 不启动第二个 Backend |
| 6 | Browser + Desktop 同时运行 | 两者操作同一 Backend，状态一致 |

可用脚本手动验证（无需 Desktop）：

```powershell
.\scripts\detect-dsh.ps1       # 就绪 → 0
.\scripts\health-check.ps1     # 轮询直到就绪
.\scripts\start-dsh.ps1        # 手动启动（先确认 3080 无服务）
```

## 10. 安装器与 CLI 隔离（重要契约）

DSH Desktop 与全局 `dsh` npm CLI **完全解耦**，二者互相独立安装 / 升级 / 卸载：

- `dsh` CLI 是独立的 npm 全局包，位于 `%APPDATA%\npm`（`dsh.cmd` / `dsh.ps1` / `dsh` + `node_modules`）。
- DSH Desktop 安装器**永不**安装、覆盖或卸载 CLI；卸载器**永不**删除 `%APPDATA%\npm` 或 `dsh` 命令入口。
- Desktop 运行时通过 PATH 发现 `dsh`（生产）或 `$DSH_REPO_PATH`（开发），只「使用」CLI，不「拥有」它。

卸载器唯一会删除的「应用数据」是 `%APPDATA%\com.dsh.desktop` 与 `%LOCALAPPDATA%\com.dsh.desktop`（WebView2 缓存等，且仅当勾选「删除应用数据」时），与 npm 全局目录无关。即使勾选「删除应用数据」，`%APPDATA%\npm` 与 `dsh` 命令也**不受影响**。

### 10.1 构建安装包

```powershell
npm run build          # = tauri build，生成 NSIS 安装包
# 产物：src-tauri/target/release/bundle/nsis/DSH Desktop_0.1.0_x64-setup.exe
```

`tauri.conf.json` 里 `bundle.windows.nsis.installerHooks` 指向 `src-tauri/installer-hooks.nsh`，在卸载前后快照并复检 `%APPDATA%\npm\dsh.cmd`，一旦未来回归导致 CLI 被删，卸载时立即告警。

### 10.2 卸载回归测试

```powershell
.\scripts\test-uninstall-regression.ps1
```

静态断言生成的 `installer.nsi`：`BUNDLEID` 必须是 `com.dsh.desktop`（而非 npm）、任何 `RmDir/RMDir/Delete` 都不得引用 npm 目录、且「删除应用数据」只作用于 `${BUNDLEID}`。

## 11. 后续（暂不做）

自动更新、登录、云同步、托盘高级功能。安装包方向见「未来安装包」一节：

- `DSH-Setup.exe` = `DSH Desktop.exe` + 必要 Runtime + 桌面快捷方式 + 开始菜单 + 可选开机启动。
- 生产模式默认调用 PATH 上的 `dsh` 命令，**Desktop 安装目录与 DSH Runtime 完全分离**。
