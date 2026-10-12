# RemoteDSH

**Let a DSH harness operate any computer** — no Node.js installed on the target, no public IP,
no network changes on the target side.

The user double-clicks a single-file executable on the target machine and sends you the
**pairing string** it prints. From then on you can run commands, read and write files, and run
`.mjs` tooling on that machine.

> Written and tested by the site owner's AI assistant (Agent) **Hoshino Sumi**, based on real
> development and real-machine verification, with human review. Panel and log text is
> deliberately machine-neutral ("remote DSH is connecting") and contains no personal data.

---

## Status

| Component | State |
|---|---|
| Target agent (`rdsh`) | ✅ Done — **28/28** end-to-end tests (Windows x64) |
| DSH plugin + `remote` tool | ✅ Done — **21/21** end-to-end tests (real WebSocket re-connect included) |
| Relay re-connect (`/remote/attach`) | ✅ Implemented and verified end-to-end (both sides implement their own RFC 6455 frame layer) |
| Direct mode (agent opens a port + signed HTTP) | ✅ Done (shares one signing contract with the relay leg) |
| Full build with an embedded Node | ✅ `build.ps1 -Full` + `get-node.ps1`; verified on a real machine that `node=embedded` and that `.mjs` runs |
| Linux artifact | ✅ 8.2 MB single-file ELF built in place on Ubuntu 22.04 (**no clang needed**) |
| **Cross-network real-machine run** | ✅ **7/7** — a Linux agent behind a real network dialled back in and was fully driven |
| **Windows 7 / x86 artifact** | ✅ `04-agent32/rdsh32.exe` (native i686, ~967 KB, zero runtime deps): local extended e2e **15/15**, over a public relay **9/9**, `.bat` smoke test passed |
| **Public relay + one-click distribution** | ✅ A target machine on an outside network double-clicks one `.bat` and is connected (nginx `location` + SSH reverse tunnel → your harness) |
| Running inside a real harness | ✅ Restarted and verified live: `remote devices` / `pair` / `exec` / `ls` all work (including a full "download → checksum → attach → pair → execute" rehearsal) |

### Cross-network verification (real machine)

A Linux (Ubuntu 22.04) machine built the agent locally — **on Linux, NativeAOT does not need
clang**; ILCompiler links with gcc just fine — staged an embedded Node next to it, and dialled
back through a real network into a standalone plugin host driven by the real `remote` tool:

| Check | Result |
|---|---|
| `info` | host / `linux/x64` / `flavor=full` / `node=embedded` |
| `exec` uname/id | kernel string / `root` |
| Non-ASCII round trip | `中文 · Ünïcödé · 🎯` |
| File write + read | `written from the controller over the relay ✅` |
| `ls /root` | the file just written is listed |
| `node` running a `.mjs` | ran on the embedded runtime |
| Background job | `bg-finished` collected correctly |

**That run exposed two production bugs no local test could see** (both fixed):

1. **The plugin's own request guard was blocking the very endpoint it serves.** The guard required
   every request to carry the relay key, which is not part of the pairing string, so a real agent
   always got 401. Local tests passed because **the test stub's web server had no guard** (a test
   blind spot). The guard now claims only `/remote/ping`; `/remote/attach` authenticates with its
   own per-device HMAC bearer.
2. **The `node` method could not start on Linux at all.** The old code joined the command into a
   single string and passed `shell: "raw"`, which the Linux path turned into `/bin/sh -c` trying to
   execute a program called `/root`. It now uses a structured `StartProcess(fileName, argv[])` and
   never goes through a shell.

## Layout

```
01-agent/           target agent: C# / .NET 8 / NativeAOT single file (~6 MB)
02-plugin/          DSH plugin: relay + device panel + the `remote` tool (zero deps, node: builtins only)
04-agent32/         native x86 agent: C++17 / MinGW i686 (Windows 7 era machines)
03-bin/             build output (not committed)
test/               end-to-end tests and diagnostics
docs/               design notes
relay/              self-hosting helpers: nginx location + SSH reverse tunnel
build.ps1           one-shot agent build
get-node.ps1        fetch and stage a Node runtime for the "-Full" build
deploy-plugin.ps1   mount/unmount the plugin in ~/.dsh/profiles/web (idempotent, backs up first)
nuget.config        fully offline restore config
nuget.proxy.config  restore config that goes through a proxy
```

## Architecture in one line

The agent offers two legs:

- **Relay (default):** the agent dials out and speaks WebSocket to the harness at
  `/remote/attach`, tunnelling RPC over it — **the target needs no inbound port at all**.
- **Direct:** the agent opens an HTTP port and the harness connects to it. Fine on a LAN.

Pairing uses a `DshAgent:` base64 string (deviceId / secret / relay / listen). After that, every
hop is authenticated with an **HMAC-SHA256 request signature** (timestamp + nonce + body hash) —
**the key itself never goes over the wire**. The relay handshake adds one more layer: a per-device
bearer `HMAC(secret, "attach:" + deviceId)`.

## Install into a harness

```powershell
.\deploy-plugin.ps1          # writes the profile patch (idempotent, backs up first)
# then restart the harness
```

Point it at another checkout with `.\deploy-plugin.ps1 -Source <path>`; it defaults to the
directory the script lives in. The plugin mounts the source by **absolute path**, so this repo
stays the single source of truth — nothing is copied.

**About the web-auth allow-list:** in this deployment the request guard is owned by an auth plugin,
and the guard chain is "first `false` wins" — a later guard cannot re-allow a request that an
earlier one rejected. The auth plugin therefore explicitly allow-lists two **machine-facing**
endpoints: `/remote/attach` (each socket authenticates with its own per-device HMAC bearer) and
`/remote/ping` (liveness probing only). The device panel `/remote/` is **not** allow-listed and
stays behind normal 2FA.

## Quick verification

```powershell
# full end-to-end test for the target agent (starts/stops the agent, isolates HOME)
node test/test-agent-e2e.mjs

# or run one manually
.\03-bin\win-x64\rdsh.exe --listen 127.0.0.1 --port 0
```

## Build

```powershell
.\build.ps1                    # slim build -> 03-bin\win-x64 (no Node)
.\build.ps1 -Full              # full build -> 03-bin\win-x64-full (bundles a Node runtime)
.\get-node.ps1                 # download and stage Node next to the full build
.\build.ps1 -Quick             # fast, non-AOT build (stack traces with real line numbers)
```

The only difference between the two flavors is whether the `node` RPC method works on a target
without Node installed. The agent looks for `<exe dir>\node\node[.exe]` → `<exe dir>\node[.exe]` →
`PATH`, and `hello` reports honestly which one it used (`nodeSource=embedded`).

**Linux artifact:** install the .NET 8 SDK on the Linux machine and run
`dotnet publish -r linux-x64 -p:EmbedNode=true`. Verified on Ubuntu 22.04: **no clang needed**.

### Local build notes (all measured)

1. **.NET/NuGet TLS can be broken on a given machine**: .NET may fail to open *any* HTTPS
   connection (`Win32Exception: no credentials are available in the security package`) while Node
   (OpenSSL) is perfectly fine. The build must then go through a proxy with an explicit config
   file — `build.ps1` already sets `HTTP_PROXY`/`HTTPS_PROXY` and passes `nuget.proxy.config`.
2. **A restricted sandbox blocks TLS too**: .NET's schannel needs the real
   `%APPDATA%\Microsoft\Crypto` and the system certificate store. Build in an unrestricted shell.
3. **`Console.OutputEncoding` throws when stdout is redirected**; the agent wraps it in try/catch.
4. **Never infer a child process's encoding from `Console.OutputEncoding`.** The agent always
   redirects a child's stdio, and such a child has no console — Windows falls back to the system
   ANSI code page (936 on the test machine, even though `chcp` reported 65001). The agent measures
   the code page with `chcp.com` and decodes accordingly (`ConsoleText.cs`). Under NativeAOT,
   `Encoding.GetEncoding(936)` throws unless you add `System.Text.Encoding.CodePages` and register
   the provider (that package grew the artifact from 5.90 MB to 6.60 MB).
5. **`Microsoft.DotNet.ILCompiler`'s version differs from the runtime pack**, so a hand-written
   `IlcPackageVersion` fails; let the SDK resolve it (`net8.0` + `win-x64`).
6. **Reflection-based JSON silently fails under AOT**: `ctx.GetTypeInfo(typeof(T))` returns null and
   `JsonSerializer.Serialize(string)` is unavailable. Use an explicit `JsonTypeInfo` per type, hand
   written escaping, and a source-generated context with `PropertyNamingPolicy = CamelCase`.
7. **PowerShell 5.1 reads BOM-less UTF-8 as GBK**: a stray Chinese comment in a `.ps1` makes the
   script fail on a completely unrelated line. Every `.ps1` in this repo stays pure ASCII and
   derives paths from `$PSScriptRoot`.

## Design decisions (explicitly recorded)

- **The QR code was removed.** A console QR generator was implemented, but a hand-rolled encoder
  could not match the reference implementation's mask-pattern selection, and the pairing string
  already covers "copy and paste it into the controller". The agent no longer contains QR/PNG code.
- **`rm` soft-deletes by default** (renames to `.rdsh-trash-<ts>`); `hard: true` really deletes.
- **Full authority + a full audit trail**: `~/.rdsh/audit.log` appends every call (including
  rejected ones); the controller can `disconnect` at any time.
- **The plugin has zero dependencies**: its WebSocket frame layer is hand-written (a subset of
  RFC 6455: text frames, fragmentation, close, ping/pong) because `ws` is only a transitive
  dependency of the harness and may not exist for someone installing the plugin alone.
- **Both legs share one signing contract**, so every `remote` subcommand behaves identically no
  matter which topology is in use.
- **Machine-facing endpoints are allow-listed separately** (see above): `/remote/attach` and
  `/remote/ping` are reachable without a browser session, while the panel keeps 2FA.

## Using it inside a different DSH instance

**The target agent: yes, zero dependencies.** `rdsh` is a standalone single file; it only needs to
reach your harness. Nothing is required on the harness side.

**The controller plugin: yes, with one hard precondition and three notes** (checked against the
source, not from memory):

| Interface used | Nature | If missing |
|---|---|---|
| `ctx.webServer.register` (exact / prefix routes) | ✅ stock harness | — |
| `ctx.webServer.registerUpgrade` (WebSocket upgrade) | ✅ stock harness | — |
| `ctx.tools.register` + `defineTool` | ✅ stock | registration warns and degrades; the relay still works |
| `ctx.on("dispose")` / `ctx.logger` | ✅ stock | — |
| **`ctx.webServer.registerGuard`** | ⚠️ **a runtime patch, not a stock API** | see below |

### Hard precondition: `registerGuard` is patched in

`dsh-host-webserver` in this deployment was patched (the source carries a
`[dsh-web-auth] registerGuard hook v2` marker); **vanilla harness builds do not have this API**.

The plugin loads defensively — no `registerGuard` means a warning, not a crash. But the
consequences matter:

- If that instance has **no request guard at all**, everything works: `/remote/attach`
  authenticates with its own per-device HMAC bearer.
- If that instance **has another guard** (e.g. an auth gate that only allows known paths), it will
  reject these endpoints before routing — and because the guard chain stops at the first `false`,
  a late-registered guard cannot undo it. In that case add `/remote/attach` and `/remote/ping` to
  that guard's allow-list.

### Three notes

1. **Mount by absolute path.** Put the path to `02-plugin/index.js` into the target instance's
   `cordis.patch.yml` (`deploy-plugin.ps1` does this). **Restart the harness afterwards** — plugin
   sources are not hot-reloaded (`patchReload: live` only covers the patch file itself).
2. **Endpoint paths are configurable** (`attachPath` / `panelPath`) so you can fit an existing
   route layout.
3. **The state file** defaults to `$DSH_HOME/.dsh/remote/devices.json`, falling back
   `DSH_HOME` → `HOME` → `USERPROFILE` (on Windows `HOME` is often empty; the old fallback
   scattered `.dsh` into the working directory — fixed). Use `stateFile` to set it explicitly.
   It stores **an HMAC key per device** — never commit it (`.gitignore` excludes `devices.json`,
   `relay.key`, `agent.json` and `audit.log`).

## Controller tool usage

One tool, `remote`, dispatching on `cmd` (arguments go in `args`):

```
remote pair <pairing string>      register a device (DshAgent:…)
remote devices                    device list and online state
remote exec  {command}            run and wait for output
remote exec-bg {command}          run in the background, returns a runId
remote jobs  [{runId}]            list background jobs / fetch one job's output
remote read/write/ls/stat/rm      file operations
remote node  {script|path}        run a .mjs on the target
remote info / kill / disconnect / forget
```

## Wire protocol (shared by direct HTTP and the tunnel)

`POST /v1/rpc/<method>`, JSON object arguments, uniform reply `{ok, code?, error?, data?}`.

| Method | Purpose |
|---|---|
| `hello` / `info` | host, OS, architecture, capability list |
| `exec` | start a command → `{runId, pid}` |
| `poll` | incremental output + exit code (supports `waitMs` long polling) |
| `kill` | terminate a foreground job |
| `jobs` | list background jobs |
| `read` / `write` / `ls` / `stat` / `rm` | file operations (chunked + base64 for large files) |
| `node` | run a `.mjs` (needs Node on the target, or the embedded-Node full build) |
| `disconnect` | tear the link down |

## Requirements

- **Target:** Windows x64 (NativeAOT single file, **no runtime to install**); Linux artifacts are
  built on the matching platform. **For Windows 7 / 32-bit, use the x86 artifact below.**
- **Controller:** a DSH harness (this repo's plugin + `deploy-plugin.ps1`).
- **Tests:** `node test/test-agent-e2e.mjs` (28), `node test/test-plugin-relay.mjs` (21),
  `node test/drive-win32.mjs` (x86 artifact, 15).

---

## Windows 7 / x86 artifact (`04-agent32/`)

### Why it exists

`01-agent` is a **win-x64** .NET 8 NativeAOT binary. .NET 8 does not support Windows 7 at all, and
an x64 binary cannot run on a 32-bit OS. If the oldest machine you must reach is **32-bit Windows
7**, you need a **native x86** artifact.

### Artifact: `04-agent32/rdsh32.exe`

| Item | Value |
|---|---|
| Toolchain | MinGW **i686** + C++17, `-municode -static -static-libgcc -static-libstdc++ -Wl,--no-insert-timestamp` |
| Size | ~967 KB; `--no-insert-timestamp` makes repeat builds **byte-identical**, so a pinned sha256 stays valid after a rebuild |
| Imports | only `KERNEL32 / msvcrt / WS2_32 / ADVAPI32` ⇒ **Windows Vista/7 through Windows 11, 32- and 64-bit** (x86 runs under WoW64) |
| **Minimum OS** | **Vista / Server 2008** (not XP): all **138** imported symbols were checked one by one; the newest are `GetTickCount64`, `GetThreadId`, `InitializeConditionVariable`, `SleepConditionVariableCS` — all Vista+ |
| Transport | **relay leg only**, and **`ws://` (plain HTTP) only** — Windows 7 needs patches plus registry changes before TLS 1.2 is dependable |
| Self-test | `rdsh32.exe --selftest` runs built-in SHA1/SHA256/HMAC known-answer vectors |
| Instance lock | `%USERPROFILE%\.rdsh\agent.lock`: a second instance prints a line and exits 4 (two instances fight over the relay seat and reconnect forever) |
| Methods | hello/info · exec · poll · kill · jobs · read · write · ls · stat · rm · disconnect · node (only when a `node.exe` sits next to it or on `PATH`) |

**The hashes are self-implemented.** On the test machine, CryptoAPI's `CryptCreateHash(CALG_HMAC)`
returned `0x80090003 NTE_BAD_ALGID`, and provider/algorithm matrices differ across Windows
versions — so SHA1/SHA256/HMAC are all implemented locally, borrowing only `CryptGenRandom` for
randomness. `--selftest` exists so any machine can prove this in one command.

**Child output decoding:** valid UTF-8 passes through; anything else is converted from the **OEM
code page**. (Note: `cmd /c echo` turns characters outside the console code page into `?` — that is
cmd's behaviour, not the agent's; if you need full non-ASCII fidelity, have the child emit UTF-8.)

### Build

```powershell
. .\04-agent32\build.ps1        # or -Toolchain <dir>
```

The script compiles, **verifies the import table against an allow-list** (any unexpected DLL is a
hard error, because that would break the compatibility promise), runs `--selftest`, and prints the
sha256.

### One-click distribution: how to build your own

The awkward step when installing an agent on someone else's machine is "a human has to download
this file and trust it". The pattern used here is a single `.bat`:

```bat
REM 1) Download over plain HTTP (old systems cannot be trusted with TLS 1.2).
REM    Three-level fallback: certutil -urlcache -> PowerShell 2.0 WebClient -> curl.exe
REM 2) Immediately verify a PINNED SHA256 (certutil -hashfile); refuse to run on mismatch.
REM 3) Only then start it, printing the pairing string to the screen and to a text file.
```

Three details are worth copying:

- **The checksum is pinned inside the script** — a plaintext link can move bytes but cannot replace
  them.
- **Use only what PowerShell 2.0 has.** On Windows 7 the built-in PowerShell is 2.0:
  `Invoke-WebRequest` (3.0+), `Get-FileHash` (4.0+) and `Expand-Archive` (5.0+) are all
  unavailable. Read files with `[System.IO.File]::ReadAllText()`, hash with `certutil -hashfile`,
  download with `New-Object Net.WebClient`.
- **Never transcribe a pairing string by hand.** A base64 key read wrong by one character does not
  error — it just produces endless 401s. Write it to a file and have the target machine POST the
  file back byte-for-byte.

### Relay topology (self-hosted)

This repo does **not** point at any hosted relay; run your own. The topology is three hops:

```
target machine   rdsh.exe --relay http://files.example.com/rdsh
  └─ ws ──→ your VPS nginx   location /rdsh/
               └─ proxy_pass 127.0.0.1:18088
                    └─ SSH reverse tunnel (initiated by the controller)
                         └─ controller 127.0.0.1:8088 /remote/attach  (the plugin's relay seat)
```

| Side | File | Notes |
|---|---|---|
| VPS | `relay/vps-nginx-patch.sh` | idempotent; backs up the vhost, reloads only after `nginx -t` passes |
| Controller | `relay/rdsh-tunnel.ps1 -LocalPort 8088 -RemotePort 18088` | reverse-tunnel daemon, auto-reconnects; **reach the relay host over a private path (e.g. a tailnet address), never its public IP** — with a TUN-style proxy running, traffic to the public IP gets routed through the proxy and sshd drops the connection during key exchange |

**Verification:** `curl` the relay's `/remote/ping` endpoint; a
`{"service":"dsh-remote","ok":true,...}` reply means the whole "VPS → tunnel → harness" path is up.

### Verification (measured)

| Scenario | Result |
|---|---|
| Local standalone host + real plugin + `rdsh32.exe` (`test/drive-win32.mjs`) | **15/15**: info · exec · Chinese text · UTF-8 child output · write/read · ls · stat · background job · rm · **paths containing Chinese and spaces** · **binary write byte-identical on the target** · **exit code passthrough** · **timeouts really killed** · **1500-line output** |
| Same, with the relay pointed at a public URL | **9/9** (one complete chain) |
| `.bat` smoke test on a local machine | download → SHA256 verify → start → `[CONNECTED]` |
| `--selftest` | SHA256/SHA1/HMAC known-answer vectors all OK |
| Both published artifacts fetched from the internet | HTTP 200 and sha256 identical to the local build |

**★ Reading binaries back is deliberately blocked.** When rendering a `read` result the plugin
replaces base64 with `[N base64 chars]` so that binary never enters the model's context. So
"fetch a file from the target" does **not** go through `remote read`: use `remote exec` and let the
target encode it (`certutil -encode <file> out.b64 & type out.b64`, or PowerShell
`[Convert]::ToBase64String([IO.File]::ReadAllBytes(...))`), then decode on the controller.

### Pitfalls (all measured)

1. **The `remote` tool can vanish silently.** The plugin's `import("@deepseek-ai/dsh-tools")`
   resolved through a shim that **hard-coded an old npx tree path**; after a harness upgrade that
   tree was deleted, the import threw, and the plugin's `.catch` printed one warning — so the tool
   disappeared while the relay endpoints, panel and liveness probe all kept working. **Rule: when
   "every plugin endpoint is alive but the tool is missing", inspect how that dynamic import
   resolves — not the routes or guards.** Fix: discover dynamically (`DSH_TOOLS_PATH`, then scan
   `_npx/*` and take the newest).
2. **A registered tool is not necessarily a usable tool.** After the fix the tool appeared but every
   call was rejected: `missing required property "value.ok"; "value.content" is not a declared
   property`. The plugin's `output.schema` was the old shape while `execute()` returned an even
   older `{content:[…]}` envelope, and this harness validates `execute()`'s return value against
   `output.schema` **before** calling `render()`. Fix: copy a tool that verifiably works on this
   machine — `schema: {type:"json"}`, `execute` returns a plain value, and **failures must
   `throw`** so the harness treats them as tool errors.
3. **A test stub must never be laxer than production.** Both bugs above passed every local test.
   `test/drive-win32.mjs` now validates return values against the output schema, and it **self-checks**
   (feeding it the old envelope must produce at least two violations, otherwise it exits).
   A checker that cannot fail is worse than no checker.
4. **CryptoAPI's HMAC is not dependable.** See above — hence local implementations plus
   `--selftest`.
5. **32-bit processes read a redirected registry view on 64-bit Windows.** A 32-bit exe reading
   `HKLM\SOFTWARE` is silently redirected into `WOW6432Node` — no error, just half the contents.
   And **never read "my exe is 32-bit" as "this OS is 32-bit"**: `PROCESSOR_ARCHITEW6432` is the
   proof.
6. **Check an import table symbol by symbol before promising OS support.** "It only depends on
   system DLLs" and "it runs on XP" are different claims; 138 imports had to be checked to correct
   an early over-promise from XP to Vista+.
7. **Port/file contention:** while the agent is running, `rdsh32.exe` is locked and rebuilding
   fails with `cannot open output`.
8. **`%USERPROFILE%\.rdsh` may be unwritable** in a sandbox ⇒ the identity is regenerated every run
   and the device id keeps changing. Tests should set **`RDSH_HOME`** to a writable directory.

### Known limitations

- **Plaintext `ws://`:** the key itself never travels (every hop is HMAC-signed), but the attach
  handshake uses a derived bearer, so someone on the wire could in principle hijack that seat.
  Encrypting it means adding TLS to the agent — and on Windows 7 that first requires working TLS 1.2.
- The `node` method requires `node.exe` on the target (this artifact does not embed a runtime).
- The audit log format is not yet field-for-field identical to the .NET build's.
- **No unattended persistence**: no service, no autostart. That is deliberate — the whole model
  assumes a human authorized this session.

## License · credits

**MIT License** · Copyright (c) 2026 HYrecovery (fengye1003) & HoshinoSumi, teko.IO SisTemS!

```
== RemoteDSH by HYrecovery & HoshinoSumi from teko.IO SisTemS! ==
== Under MIT Open Source License ==
```

## Scope

RemoteDSH is **only** the "remote execution and file operations" layer — a base plugin. What you
build on top of it (collection, inspection, batch distribution, a channel for some application) is
a **separate project that depends on it**: the dependency is one-way — applications depend on
RemoteDSH's channel, RemoteDSH does not know about them and does not change its protocol for them.

---

*中文说明见 [README.chs.md](README.chs.md)。*
