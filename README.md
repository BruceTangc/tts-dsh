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
- 只有确认 Backend 不存在，才启动一个 Backend（`node <checkout>/apps/cli/lib/bin.js web --no-open`）。
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
- 启动命令**固定/白名单化**：只允许 `node <固定路径> web --no-open`，参数来自配置文件 / 环境变量 / 内置默认值，绝不来自运行时输入。
- 远程 DSH Web UI 通过 HTTP/WebSocket 直连 Backend，与浏览器行为一致，不经 Tauri 桥。

## 5. 目录结构

```
dsh-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
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
│   └── health-check.ps1     # 轮询直到就绪/超时
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

> 图标：仓库已含 `src-tauri/icons/`；如需重新生成可运行 `scripts/generate-icons.ps1`，或用 `pnpm icons <图片>`。

## 8. 配置（可选）

Backend 地址 / 启动命令默认已写死为当前 checkout。可通过环境变量覆盖（**优先级最高**）：

| 环境变量 | 说明 |
|---|---|
| `DSH_BACKEND_URL` | 例如 `http://127.0.0.1:8080/` |
| `DSH_BACKEND_START_COMMAND` | 默认 `node` |
| `DSH_BACKEND_START_ARGS` | JSON 数组，默认 `["…\\lib\\bin.js","web","--no-open"]` |
| `DSH_BACKEND_HEALTH_TIMEOUT_SEC` | 默认 `60` |

或把 `dsh-desktop.conf.example.json` 复制为 `dsh-desktop.conf.json` 放到 exe 同级目录（或用 `DSH_DESKTOP_CONFIG` 指定路径）。优先级：环境变量 > 配置文件 > 内置默认。

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

## 10. 后续（V1 暂不做）

Windows Installer（NSIS/MSI）、自动更新、登录、云同步、托盘高级功能。安装包方向见「未来安装包」一节：

- `DSH-Setup.exe` = `DSH Desktop.exe` + 必要 Runtime + 桌面快捷方式 + 开始菜单 + 可选开机启动。
- 届时把 `bundle.active` 置为 `true` 并配置 `targets: ["nsis"]`，并把默认 `start_args` 指向安装后的 `dsh` 二进制（而非 checkout 路径）。
