// host-lan.mjs —— 局域网版 RemoteDSH 中继宿主（跨机实测用）
//
// 为什么需要它：正式部署要把 02-plugin/index.js 挂进 DSH harness，那要重打
// webserver 的 guard 补丁 + 重启 harness。同局域网试跑不需要这么大动干戈 ——
// 这里把「真实的插件」挂到一个桩 webServer 上，绑定 0.0.0.0，让局域网里的
// Windows agent 走反连隧道拨进来；另外在 127.0.0.1 上开一个控制口，让外部
// 驱动（例如 agent 的 shell）能跨进程下发 `remote` 工具命令。
//
//   node test/host-lan.mjs --port 8199 --ctl 8101 [--store <路径>] [--bin <目录>]
//
// 控制口只绑回环 + 要求 X-Ctl-Token 头；token 每次启动随机生成，写到
// <store 所在目录>/_ctl-token.txt 并在启动时打印。
//
// 下载口：GET /dl/<token>/<相对 03-bin 的路径>，token 同上（给目标机取 rdsh.exe 用）。

import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const relayPort = Number(arg("port", 8199));
const ctlPort = Number(arg("ctl", 8101));
const storeFile = resolve(arg("store") ?? join(root, "data", "host-lan-devices.json"));
const binDir = resolve(arg("bin") ?? join(root, "03-bin"));

const token = randomBytes(16).toString("hex");
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// ── 桩 context：镜像插件真正用到的那几个 harness 接口 ──────────────────────
const exact = new Map();
const prefixes = [];
const upgrades = new Map();
const guards = [];
const tools = [];

const ctx = {
  webServer: {
    register: (route) => {
      if (route.kind === "exact") exact.set(route.path, route.handler);
      else prefixes.push(route);
      return () => {};
    },
    registerUpgrade: (route) => {
      upgrades.set(route.path, route.handler);
      return () => {};
    },
    registerFallback: () => () => {},
    registerGuard: (guard) => {
      guards.push(guard);
      return () => {};
    },
  },
  tools: {
    register: (def) => {
      tools.push(def);
      return () => {};
    },
  },
  logger: {
    info: (m) => log(`[plugin] ${m}`),
    warn: (m) => log(`[plugin warn] ${m}`),
  },
  on: () => {},
};

// ── 局域网中继：插件路由 + 文件下载口 ──────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  // 下载口（不属于插件，先于插件路由处理）
  if (url.pathname.startsWith("/dl/")) {
    return void serveDownload(url, res);
  }

  for (const g of guards) {
    if (g.check && g.check(req, res, url.pathname) === false) return;
  }
  const h = exact.get(url.pathname);
  if (h) return void h(req, res);
  const p = prefixes
    .filter((x) => url.pathname.startsWith(x.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (p) return void p.handler(req, res);
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"ok":false,"code":"not_found"}');
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  log(`upgrade ${url.pathname}${url.search} remote=${req.socket.remoteAddress} known=${upgrades.has(url.pathname)}`);
  for (const g of guards) {
    if (g.checkUpgrade && g.checkUpgrade(req, socket, head, url.pathname) === false) return;
  }
  const h = upgrades.get(url.pathname);
  if (!h) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  h(req, socket, head);
});

function serveDownload(url, res) {
  const parts = url.pathname.split("/").filter(Boolean); // dl, <token>, ...rel
  if (parts[1] !== token) {
    res.writeHead(403, { "content-type": "text/plain" });
    return void res.end("bad token");
  }
  const rel = normalize(parts.slice(2).join("/"));
  const full = resolve(binDir, rel);
  if (!full.startsWith(binDir + sep) && full !== binDir) {
    res.writeHead(400, { "content-type": "text/plain" });
    return void res.end("bad path");
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return void res.end("not found");
  }
  const size = statSync(full).size;
  log(`download ${rel} (${(size / 1048576).toFixed(2)} MB) -> ${res.socket?.remoteAddress}`);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(size),
    "content-disposition": `attachment; filename="${basename(full)}"`,
  });
  createReadStream(full).pipe(res);
}

// ── 回环控制口：把 remote 工具的调用暴露成一个很薄的 JSON 接口 ──────────────
const ctlServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  if (req.headers["x-ctl-token"] !== token) return void json(401, { ok: false, error: "bad token" });

  if (req.method === "GET" && url.pathname === "/health") {
    return void json(200, { ok: true, tools: tools.map((t) => t.name), devices: store.devices?.length ?? 0 });
  }
  if (req.method !== "POST" || url.pathname !== "/ctl") return void json(404, { ok: false, error: "not found" });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) {
      req.destroy();
      return void json(413, { ok: false, error: "body too large" });
    }
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return void json(400, { ok: false, error: `bad json: ${e.message}` });
  }
  if (!tool) return void json(503, { ok: false, error: "remote tool not registered yet" });

  try {
    const out = await tool.execute(payload, { signal: new AbortController().signal });
    const text = out?.content?.map((c) => c.text ?? "").join("\n") ?? "";
    return void json(200, { ok: !out?.isError, text, raw: out });
  } catch (e) {
    return void json(500, { ok: false, error: String(e?.stack ?? e) });
  }
});

// ── 启动 ────────────────────────────────────────────────────────────────────
mkdirSync(dirname(storeFile), { recursive: true });
const tokenFile = join(dirname(storeFile), "_ctl-token.txt");
writeFileSync(tokenFile, token, "utf8");

log(`store      : ${storeFile}`);
const mod = await import(pathToFileURL(join(root, "02-plugin", "index.js")).href);
mod.apply(ctx, { stateFile: storeFile });

// 供控制口读设备数（插件把设备存在 store 文件里）
let store = { devices: [] };
const refreshStore = () => {
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8"));
    if (Array.isArray(parsed?.devices)) store = parsed;
  } catch {
    /* 还没写盘 */
  }
};
refreshStore();

await new Promise((r) => server.listen(relayPort, "0.0.0.0", r));
await new Promise((r) => ctlServer.listen(ctlPort, "127.0.0.1", r));

const lanIp =
  arg("ip") ??
  Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ??
  "127.0.0.1";
log(`relay(LAN) : http://${lanIp}:${relayPort}   seat=${[...upgrades.keys()].join(",") || "(none)"}`);
log(`control    : http://127.0.0.1:${ctlPort}/ctl  (X-Ctl-Token)`);
log(`token file : ${tokenFile}`);

for (let i = 0; i < 100 && tools.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
if (tools.length === 0) {
  console.error("remote tool never registered; aborting");
  process.exit(1);
}
const tool = tools[0];
log(`remote tool registered: ${tool.name}`);

// 只是为了把工具定义提早暴露给控制口
setInterval(refreshStore, 2000).unref?.();

process.on("SIGINT", () => {
  server.close();
  ctlServer.close();
  process.exit(0);
});
