# RemoteDSH

**让 DSH harness 直接操作任意一台电脑** —— 目标机不需要安装 Node、不需要公网 IP、不需要用户改任何网络设置。

目标机上双击一个单文件 exe，把终端打印的**配对串**发给你，此后你就能在那台机器上执行命令、读写文件、跑 `.mjs` 工具。

> 本项目由本站站主的 AI 助手（**星澄 / Hoshino Sumi**）编写，基于真实开发与真机实测，经人工审阅。
> 面板与日志文案统一为机器中性的「远程 DSH 正在连接」，不含任何个人信息。

---

## 状态

| 部件 | 状态 |
|---|---|
| 目标机 agent（`rdsh`） | ✅ 完成 —— **28/28** 端到端测试（Windows x64） |
| DSH 插件 + `remote` 工具 | ✅ 完成 —— **21/21** 端到端测试（含真 WebSocket 反连） |
| 反连中继（`/remote/attach`） | ✅ 已实现并端到端验证（两端各自实现 RFC 6455 帧层） |
| 直连模式（agent 自开端口 + 签名 HTTP） | ✅ 已实现（与反连共用同一套签名契约） |
| 内嵌 Node 的完整版构建 | ✅ `build.ps1 -Full` + `get-node.ps1`；真机实测 `node=embedded` 且能跑 `.mjs` |
| Linux 产物 | ✅ 在 Ubuntu 22.04 上就地构建出 8.2 MB 单文件 ELF（**无需 clang**） |
| **真机跨网络验证** | ✅ **7/7** —— 真实网络后的 Linux agent 反连回来并被完整驱动 |
| **Windows 7 / x86 兼容产物** | ✅ `04-agent32/rdsh32.exe`（原生 i686，~967 KB，零运行时依赖）：本机扩展 e2e **15/15**、经公网中继 **9/9**、`.bat` 冒烟通过 |
| **公网中继 + 一键分发** | ✅ 外网机器双击一个 `.bat` 即接入（nginx `location` + SSH 反向隧道 → 你的 harness） |
| 装进真实 harness | ✅ 已重启并 live 验证：`remote devices` / `pair` / `exec` / `ls` 全通（含一次完整的「下载 → 校验 → attach → 配对 → 执行」预演） |

### 真机跨网络验证（实测）

一台 Ubuntu 22.04 机器**就地**构建出 agent（**Linux 上 NativeAOT 不需要 clang**，ILCompiler 用 gcc 链接即可通过），
再在它旁边暂存一份内嵌 Node，然后经真实网络反连回一个独立插件宿主，由真实 `remote` 工具驱动：

| 检查 | 结果 |
|---|---|
| `info` | 主机名 / `linux/x64` / `flavor=full` / `node=embedded` |
| `exec` uname/id | 内核串 / `root` |
| 非 ASCII 往返 | `中文 · Ünïcödé · 🎯` |
| 文件写读 | `written from the controller over the relay ✅` |
| `ls /root` | 列到刚写入的文件 |
| `node` 跑 `.mjs` | 走内嵌运行时成功 |
| 后台任务 | `bg-finished` 回收成功 |

**这次真机验证抓出两个本地测试测不出的生产 bug**（都已修复）：

1. **插件自己的请求守卫拦掉了它要服务的端点。** 守卫要求每个请求带 relay key，而配对串里不含这个 key，
   真机 agent 永远 401。本地测试之所以通过，是因为**测试桩的 webServer 没有守卫**（测试盲区）。
   现在守卫只认领 `/remote/ping`，`/remote/attach` 交给它自己的 per-device HMAC bearer 认证。
2. **`node` 方法在 Linux 上根本起不来。** 旧实现把命令拼成单字符串并传 `shell: "raw"`，
   Linux 分支把它当普通 shell 名，转成 `/bin/sh -c` 去执行一个叫 `/root` 的程序。
   现在改为结构化的 `StartProcess(fileName, argv[])`，不经过 shell。

## 目录

```
01-agent/           目标机 agent：C# / .NET 8 / NativeAOT 单文件（~6 MB）
02-plugin/          DSH 插件：中继 + 设备面板 + `remote` 工具（零依赖，仅 node: 内置模块）
04-agent32/         原生 x86 agent：C++17 / MinGW i686（Win7 时代的老机器）
03-bin/             构建产物（不入库）
test/               端到端测试与诊断脚本
docs/               设计定稿
relay/              自建中继的辅助脚本：nginx location + SSH 反向隧道
build.ps1           一键构建 agent
get-node.ps1        为 `-Full` 构建下载并暂存 Node 运行时
deploy-plugin.ps1   挂载/卸载插件到 ~/.dsh/profiles/web（幂等，改前自动备份）
nuget.config        纯离线还原配置
nuget.proxy.config  走代理的还原配置
```

## 架构一句话

agent 提供两条腿：

- **反连（默认）**：agent 主动出网，用 WebSocket 连到 harness 的 `/remote/attach`，把 RPC 当隧道跑
  —— **目标机不需要任何入站端口**。
- **直连**：agent 自己开一个 HTTP 端口，harness 直接连它。同网段可用。

配对用 `DshAgent:` 前缀的 base64 串（内含 deviceId / secret / relay / listen）。此后每一跳都用
**HMAC-SHA256 请求签名**（时间戳 + nonce + body 哈希）认证 —— **密钥本身永不上网**。
反连握手另有一层 per-device bearer：`HMAC(secret, "attach:" + deviceId)`。

## 安装到 harness

```powershell
.\deploy-plugin.ps1          # 写入 profile 补丁（幂等，自动备份）
# 然后重启 harness
```

要指向别的检出目录就加 `-Source <路径>`；不传则默认用脚本自身所在目录。
插件以**绝对路径**挂载源码，所以本仓库始终是唯一真源，不需要拷贝。

**关于 web-auth 白名单**：本部署的请求守卫由 auth 插件独占，而守卫链是「首个返回 false 即终」
—— 后注册的守卫无法把已被拒绝的请求重新放行。因此 auth 插件显式放行了两个**面向机器**的端点：
`/remote/attach`（每个 socket 用 per-device HMAC bearer 认证）与 `/remote/ping`（只回答存活探测）。
设备面板 `/remote/` **不在**白名单里，仍受常规 2FA 保护。

## 快速验证

```powershell
# 目标机 agent 的完整端到端测试（自动起停 agent、隔离 HOME）
node test/test-agent-e2e.mjs

# 或手动跑一次
.\03-bin\win-x64\rdsh.exe --listen 127.0.0.1 --port 0
```

## 构建

```powershell
.\build.ps1                    # 瘦身版 -> 03-bin\win-x64（不附带 Node）
.\build.ps1 -Full              # 完整版 -> 03-bin\win-x64-full（附带 Node 运行时）
.\get-node.ps1                 # 为完整版下载并暂存 Node
.\build.ps1 -Quick             # 快速构建（非 AOT，堆栈带真实行号）
```

两档产物的差别只有一个：`node` 方法能否在没有装 Node 的目标机上使用。agent 的查找顺序是
`<exe目录>\node\node[.exe]` → `<exe目录>\node[.exe]` → `PATH`，`hello` 会如实回报用的是哪一个
（`nodeSource=embedded`）。

**Linux 产物**：在目标 Linux 机器上装 .NET 8 SDK 后直接
`dotnet publish -r linux-x64 -p:EmbedNode=true`。本机实测（Ubuntu 22.04）**不需要 clang**。

### 本机构建注意事项（踩坑记录，均实测）

1. **某些机器的 .NET/NuGet TLS 栈是坏的**：.NET 可能建立不了任何 HTTPS 连接
   （`Win32Exception: 安全包中没有可用的凭证`），而 Node（OpenSSL）一切正常。
   这时构建必须走代理并显式指定配置文件 —— `build.ps1` 已内置 `HTTP_PROXY`/`HTTPS_PROXY` 与
   `nuget.proxy.config`。
2. **受限沙箱也会挡住 TLS**：.NET 的 schannel 需要真实的 `%APPDATA%\Microsoft\Crypto` 与系统证书库。
   请在放开限制的环境下构建。
3. **`Console.OutputEncoding` 在 stdout 被重定向时会抛异常**；agent 里已用 try/catch 包住。
4. **子进程输出的编码不能靠 `Console.OutputEncoding` 推断**：agent 总是重定向子进程 stdio，
   而这样的子进程没有自己的控制台，Windows 会回落到**系统 ANSI 码页**（实测机器是 936，尽管
   `chcp` 报 65001）。agent 用 `chcp.com` 实测码页并按它解码（`ConsoleText.cs`）。
   NativeAOT 下 `Encoding.GetEncoding(936)` 会抛异常，需要 `System.Text.Encoding.CodePages` 包 +
   `Encoding.RegisterProvider`（加这个包让产物从 5.90 MB 增到 6.60 MB）。
5. **`Microsoft.DotNet.ILCompiler` 的版本号与 runtime pack 不同**，手写 `IlcPackageVersion` 必定失败；
   让 SDK 自行解析（`net8.0` + `win-x64`）。
6. **AOT 下反射式 JSON 会静默失效**：`ctx.GetTypeInfo(typeof(T))` 返回 null、
   `JsonSerializer.Serialize(string)` 不可用。修法 = 每类型显式 `JsonTypeInfo` + 自写转义 +
   源生成上下文 `PropertyNamingPolicy = CamelCase`。
7. **PowerShell 5.1 读取无 BOM 的 UTF-8 会按 GBK 解析**：`.ps1` 里写中文注释会让脚本
   **在完全无关的行**报错。本仓库的 `.ps1` 一律保持纯 ASCII，路径用 `$PSScriptRoot` 推导。

## 设计取舍（明确记录）

- **二维码已移除。** 曾实现控制台二维码，但自建编码器在掩码图案择优上与参考实现对不齐，
  而配对串本身已满足「复制粘贴给控制器」这一核心需求。agent 不再包含 QR/Png 代码。
- **`rm` 默认软删除**（改名为 `.rdsh-trash-<ts>`），`hard: true` 才真删。
- **全权操作 + 全程审计**：`~/.rdsh/audit.log` 追加记录每次调用（**含被拒绝的请求**）；
  控制端可随时 `disconnect`。
- **插件零依赖**：中继的 WebSocket 帧层是自己实现的（RFC 6455 子集：文本帧、分片、close、
  ping/pong），因为 `ws` 只是 harness 的传递依赖，别人单独装这个插件时不一定存在。
- **两条腿共用一套签名契约**：直连走签名 HTTP，反连把同样的 RPC 塞进 WebSocket 帧，
  所以 `remote` 工具的每个子命令对两种拓扑行为一致。
- **面向机器的端点单独放行**（见上）：`/remote/attach` 与 `/remote/ping` 无需浏览器会话即可达，
  而设备面板仍受 2FA。

## 能不能放到别的 DSH 实例里用？

**目标机 agent：完全可以，零依赖。** `rdsh` 是独立单文件，只要求「能访问到你的 harness 地址」。

**控制器插件：可用，但有一个硬前提和三个注意点**（逐条核对过源码，不是印象）：

| 插件用到的接口 | 性质 | 缺失后果 |
|---|---|---|
| `ctx.webServer.register`（exact / prefix 路由） | ✅ harness 原装 | — |
| `ctx.webServer.registerUpgrade`（WebSocket 升级） | ✅ harness 原装 | — |
| `ctx.tools.register` + `defineTool` | ✅ 原装 | 注册失败会告警降级，不影响中继 |
| `ctx.on("dispose")` / `ctx.logger` | ✅ 原装 | — |
| **`ctx.webServer.registerGuard`** | ⚠️ **运行时补丁，不是原装 API** | 见下 |

### 硬前提：`registerGuard` 是被补丁打进去的

本部署的 `dsh-host-webserver` 被打了钩子（源码里标着 `[dsh-web-auth] registerGuard hook v2`）；
**原版 harness 没有这个 API**。

插件对此**防御式加载**：拿不到 `registerGuard` 只告警、不崩。但后果要说清楚：

- 那个实例**没有任何请求守卫**时：一切照常，`/remote/attach` 靠自己的 per-device HMAC bearer 认证。
- 那个实例**另有守卫**（例如「只放行已知路径」的闸）时：它会在路由分发前拒掉这些端点，
  **而守卫链首个 false 即终，后注册的守卫救不回来**。这时需要把 `/remote/attach` 与
  `/remote/ping` 加进那个守卫的白名单。

### 三个注意点

1. **挂载用绝对路径即可**：把 `02-plugin/index.js` 的路径写进目标实例的 `cordis.patch.yml`
   （`deploy-plugin.ps1` 会自动写）。**改完必须重启 harness** —— `patchReload: live`
   只对补丁文件本身生效，插件源码不会热加载。
2. **端点路径可配置**：`attachPath` / `panelPath` 都能改，方便迁就目标实例已有的路由布局。
3. **状态文件**默认落在 `$DSH_HOME/.dsh/remote/devices.json`，回退顺序
   `DSH_HOME` → `HOME` → `USERPROFILE`（Windows 上 `HOME` 常为空；缺 `USERPROFILE` 回退会把 `.dsh`
   散落到工作目录 —— 已修）。也可用 `stateFile` 显式指定。存储里有**每台设备的 HMAC 密钥**，
   别提交进仓库（`.gitignore` 已排除 `devices.json` / `relay.key` / `agent.json` / `audit.log`）。

## controller 工具用法

单个工具 `remote`，用 `cmd` 分派（`args` 里放该子命令的参数）：

```
remote pair <配对串>              登记设备（DshAgent: 串）
remote devices                    设备清单与在线状态
remote exec  {command}            执行并等待输出
remote exec-bg {command}          后台执行，返回 runId
remote jobs  [{runId}]            后台任务列表 / 取某任务输出
remote read/write/ls/stat/rm      文件操作
remote node  {script|path}        在目标机跑 .mjs
remote info / kill / disconnect / forget
```

## 线协议（HTTP 直连与隧道共用）

`POST /v1/rpc/<method>`，JSON 对象参数，统一回复 `{ok, code?, error?, data?}`。

| 方法 | 说明 |
|---|---|
| `hello` / `info` | 主机、系统、架构、能力清单 |
| `exec` | 启动命令 → `{runId, pid}` |
| `poll` | 取增量输出 + 退出码（支持 `waitMs` 长轮询） |
| `kill` | 终止前台任务 |
| `jobs` | 后台任务列表 |
| `read` / `write` / `ls` / `stat` / `rm` | 文件操作（大文件分块 + base64） |
| `node` | 跑 `.mjs`（需要目标机有 node 或使用内嵌完整版） |
| `disconnect` | 断开 |

## 要求

- **目标机**：Windows x64（NativeAOT 单文件，**无需安装任何运行时**）；Linux 产物需在对应平台构建。
  **Windows 7 / 32 位请用下面的 x86 兼容产物。**
- **控制端**：DSH harness（本仓库插件 + `deploy-plugin.ps1` 挂载）。
- **测试**：`node test/test-agent-e2e.mjs`（28）、`node test/test-plugin-relay.mjs`（21）、
  `node test/drive-win32.mjs`（x86 产物，15）。

---

## Windows 7 / x86 兼容产物（`04-agent32/`）

### 为什么要它

`01-agent` 是 **win-x64** 的 .NET 8 NativeAOT。.NET 8 **完全不支持 Windows 7**，
而且 x64 二进制在 32 位系统上跑不起来。要连的最低目标是 **32 位 Windows 7** ⇒ 必须另出**原生 x86** 产物。

### 产物：`04-agent32/rdsh32.exe`

| 项 | 值 |
|---|---|
| 工具链 | MinGW **i686** + C++17，`-municode -static -static-libgcc -static-libstdc++ -Wl,--no-insert-timestamp` |
| 体积 | ~967 KB；`--no-insert-timestamp` ⇒ 重复构建 **byte-identical**，钉死的 sha256 不会因重编而失效 |
| 导入表 | 只有 `KERNEL32 / msvcrt / WS2_32 / ADVAPI32` ⇒ **Windows Vista/7 ~ Win11、32/64 位通吃**（x86 在 WoW64 下跑） |
| **最低系统** | **Vista / Server 2008**（不是 XP）：**138 个导入符号逐条核过**，最新的 `GetTickCount64` / `GetThreadId` / `InitializeConditionVariable` / `SleepConditionVariableCS` 都是 Vista+ |
| 传输 | **只有反连腿**，且**只支持 `ws://`（纯 HTTP）** —— Win7 的 TLS 栈要打补丁 + 改注册表才谈得上 TLS 1.2 |
| 自检 | `rdsh32.exe --selftest` 跑内置 SHA1/SHA256/HMAC 已知向量 |
| 实例锁 | `%USERPROFILE%\.rdsh\agent.lock`：第二个实例印一行提示后退出 4（两个实例会互相顶掉中继座位、无限重连） |
| 方法面 | hello/info · exec · poll · kill · jobs · read · write · ls · stat · rm · disconnect · node（旁边或 PATH 有 `node.exe` 时才可用） |

**哈希是自带实现**：实测机器上 CryptoAPI 的 `CryptCreateHash(CALG_HMAC)` 直接返回
`0x80090003 NTE_BAD_ALGID`，且各版本 Windows 的 provider/算法矩阵不一样 ⇒ SHA1/SHA256/HMAC
全部自己实现，只借 `CryptGenRandom` 取随机数。`--selftest` 的存在就是为了任何机器上一句话自证。

**子进程输出解码**：合法 UTF-8 直通，否则按 **OEM 码页**转 UTF-8。（注意：`cmd /c echo` 回显超出
控制台码页的字符会变成 `?` —— 那是 cmd 的行为，不是 agent 的；要完整还原非 ASCII 就让子进程自己输出 UTF-8。）

### 构建

```powershell
. .\04-agent32\build.ps1        # 或 -Toolchain <dir>
```

脚本会：编译 → **按白名单核对导入表**（出现非白名单 DLL 直接报错，因为那等于兼容性承诺破了）
→ 跑 `--selftest` → 打印 sha256。

### 一键分发：自己怎么做

给别人的机器装 agent 时，最烦的一步是「人得把文件下载下来并信任它」。本项目的做法是**一个 `.bat`**：

```bat
REM 1) 纯 HTTP 下载（老系统的 TLS 1.2 不可靠）。
REM    三级回退：certutil -urlcache -> PowerShell 2.0 WebClient -> curl.exe
REM 2) 下载完立刻用钉死的 SHA256 校验（certutil -hashfile），不匹配就拒绝运行。
REM 3) 校验通过才启动，并把配对串同时打到屏幕和写进文本文件。
```

三个细节值得抄：

- **校验和钉死在脚本里** —— 明文链路只能搬运字节、不能替换字节。
- **只用 PowerShell 2.0 就有的东西。** Win7 自带的是 PS 2.0：`Invoke-WebRequest`(3.0+)、
  `Get-FileHash`(4.0+)、`Expand-Archive`(5.0+) 全都不能用。读文件用
  `[System.IO.File]::ReadAllText()`、哈希用 `certutil -hashfile`、下载用 `New-Object Net.WebClient`。
- **配对串绝不靠人肉转录。** base64 密钥读错一个字符**不会报错**，只会一直 401。
  正解是把它落成文件、让目标机把文件原样 POST 回来。

### 中继拓扑（自建）

本仓库**不指向任何托管的中继**，请自建。拓扑是三跳：

```
目标机        rdsh.exe --relay http://files.example.com/rdsh
  └─ ws ──→  你自建的 VPS nginx   location /rdsh/
               └─ proxy_pass 127.0.0.1:18088
                    └─ SSH 反向隧道（由控制端发起）
                         └─ 控制端 127.0.0.1:8088 /remote/attach（插件的中继座位）
```

| 侧 | 文件 | 说明 |
|---|---|---|
| VPS | `relay/vps-nginx-patch.sh` | 幂等；改 vhost 前先备份，`nginx -t` 过了才 reload |
| 控制端 | `relay/rdsh-tunnel.ps1 -LocalPort 8088 -RemotePort 18088` | 反向隧道守护，断开自动重连；**必须走私有路径（如 tailnet 地址）连中继主机，绝不用它的公网 IP** —— TUN 类代理开着时，去公网 IP 的流量会被拐进代理，ssh 在 kex 阶段被断 |

**验收**：`curl` 中继的 `/remote/ping` 端点，回 `{"service":"dsh-remote","ok":true,...}`
就说明「VPS → 隧道 → harness」这一整段是通的。

### 验证（实测）

| 场景 | 结果 |
|---|---|
| 本地 standalone 宿主 + 真插件 + `rdsh32.exe`（`test/drive-win32.mjs`） | **15/15**：info · exec · 中文 · UTF-8 子进程 · 写读 · ls · stat · 后台任务 · rm · **含中文与空格的路径** · **二进制写入在目标机逐字节一致** · **退出码透传** · **超时真的被杀** · **1500 行大输出** |
| 同上，relay 换成公网 URL | **9/9**（同一条完整链路） |
| `.bat` 本机冒烟 | 下载 → SHA256 校验 → 启动 → `[CONNECTED]` |
| `--selftest` | SHA256/SHA1/HMAC 三个已知向量全 OK |
| 两个上线产物（从公网取回） | HTTP 200 且 sha256 与本地逐位一致 |

**★ 二进制读回是被"故意"扣住的。** 插件渲染 `read` 结果时会把 base64 换成 `[N base64 chars]`，
不让二进制进模型上下文。所以「把目标机上的文件取回来」**不能靠 `remote read`**：
要走 `remote exec` 让目标机自己编码（`certutil -encode <file> out.b64 & type out.b64`，或 PowerShell
`[Convert]::ToBase64String([IO.File]::ReadAllBytes(...))`）再在控制端解码。

### 踩过的坑（都实测过）

1. **`remote` 工具会静默消失。** 插件 `import("@deepseek-ai/dsh-tools")` 命中的 shim
   **写死了旧 npx 树的路径**；harness 升级把旧树删掉后导入抛错，插件的 `.catch` 只打一行 warn
   —— 于是工具没了，而中继端点、面板、存活探测全都还活着。
   **判据：遇到「插件端点全活、就是没有对应工具」，先看那条动态 import 解析到了什么，别查路由/守卫。**
   修法 = 动态发现（`DSH_TOOLS_PATH` → 扫 `_npx/*` 取最新）。
2. **工具注册成功 ≠ 能用。** 修好上一条后工具出现了，但每次调用都被打回：
   `missing required property "value.ok"; "value.content" is not a declared property`。
   根因是插件的 `output.schema` 是老写法，而 `execute()` 返回更老的 `{content:[…]}` 信封，
   而**这版 harness 会先按 output schema 校验 `execute()` 的返回值、再交给 `render()`**。
   修法 = 照本机**已验证可用**的工具抄：`schema: {type:"json"}`、`execute` 返回普通值、
   **失败要 `throw`**（这样才被认成 tool error）。
3. **测试桩不能比生产宽松。** 上面两个 bug 在本地测试里全绿。
   `test/drive-win32.mjs` 现在会按 output schema 校验返回值，而且**自带自检**
   （拿老的 `{content}` 信封喂进去必须报 ≥2 条违规，否则自己退出）。**一个不会失败的检查器比没有更危险。**
4. **CryptoAPI 的 HMAC 不可靠。** 见上 —— 所以自带实现 + `--selftest`。
5. **32 位进程在 64 位 Windows 上读注册表会被静默重定向到 `WOW6432Node`**
   —— 不报错，只是少一半内容。**另外别把「我的 exe 是 32 位」读成「这台系统是 32 位」**：
   `PROCESSOR_ARCHITEW6432` 才是铁证。
6. **承诺系统支持前，把导入表逐条对一遍版本。** 「只依赖系统 DLL」和「XP 也能跑」是两件事；
   为了把早期"XP"的过度承诺纠正为 Vista+，138 个导入符号全部核过。
7. **端口/文件占用**：agent 在跑时 `rdsh32.exe` 被锁，重新编译会 `cannot open output`。
8. **沙箱里 `%USERPROFILE%\.rdsh` 可能不可写** ⇒ 身份每次重生成、设备 id 一直变。
   测试请设 **`RDSH_HOME`** 指向可写目录。

### 已知限制

- **明文 `ws://`**：密钥本身不上网（每一跳都是 HMAC 签名），但 attach 握手用的是派生 bearer，
  链路上的人理论上能劫持这条座位。要加密得给 agent 加 TLS，而 Win7 得先有可靠的 TLS 1.2。
- `node` 方法要求目标机自带 `node.exe`（本产物不内嵌运行时）。
- 审计日志格式尚未与 .NET 版逐字段对齐。
- **不做无人值守**：没有服务、没有开机自启。这是刻意的 —— 整套模型的前提是「人授权了这一次会话」。

## 许可 · 致谢

**MIT License** · Copyright (c) 2026 HYrecovery (fengye1003) & HoshinoSumi, teko.IO SisTemS!

```
== RemoteDSH by HYrecovery & HoshinoSumi from teko.IO SisTemS! ==
== Under MIT Open Source License ==
```

## 关于边界

RemoteDSH 的定位**只是「远程执行与文件操作」这一层** —— 一个基插件。想拿它做采集、巡检、
批量分发，或给某个应用当通道，那是**建立在它之上的独立项目**：依赖是单向的 ——
应用依赖 RemoteDSH 的通道，RemoteDSH 不认识它们，也不为它们改协议。

---

*English README: [README.md](README.md).*
