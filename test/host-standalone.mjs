// Persistent plugin host for cross-machine testing.
//
// Runs the REAL controller plugin against a stub webServer on a fixed port, so an
// agent on another machine can dial in over a tunnel and be driven for real.
// Prints the pairing string the remote agent generated (given as a file) and stays
// up until interrupted.
//
//   node test/host-standalone.mjs --port 8088 --pair-file <path> [--drive]
//
// With --drive it also runs a short scripted session through the `remote` tool and
// prints the result, so a cross-machine run proves the whole path, not just the
// handshake.

import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const port = Number(arg("port", 8088));
const pairFile = arg("pair-file");
const drive = flag("drive");

// ── stub context that mirrors the real harness surface the plugin uses ──────
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
    info: (m) => console.log(`[plugin] ${m}`),
    warn: (m) => console.log(`[plugin warn] ${m}`),
  },
  on: () => {},
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
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
  console.log(`[host] upgrade ${url.pathname}${url.search} known=${upgrades.has(url.pathname)} guards=${guards.length}`);
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

// A persistent store by default: the agent may hold a long reconnect backoff, so a
// fresh store per host run would leave it permanently unpaired (401) and the host
// would give up before it retried.
const storeFile = arg("store", null) ?? join(here, "..", "data", "host-devices.json");
mkdirSync(dirname(storeFile), { recursive: true });
console.log(`store: ${storeFile}`);
const mod = await import(pathToFileURL(join(here, "..", "02-plugin", "index.js")).href);
mod.apply(ctx, { stateFile: storeFile });

await new Promise((r) => server.listen(port, "127.0.0.1", r));
console.log(`host ready: http://127.0.0.1:${server.address().port}`);
console.log(`relay seat: ${[...upgrades.keys()].join(",") || "(none registered)"}  guards: ${guards.length}`);

for (let i = 0; i < 100 && tools.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
if (tools.length === 0) {
  console.error("the remote tool never registered; aborting");
  process.exit(1);
}
const tool = tools[0];
const call = (args) => tool.execute(args, { signal: new AbortController().signal });
console.log("remote tool registered; waiting for an agent to pair and attach");

if (drive) {
  // ── scripted cross-machine session ────────────────────────────────────────
  // The agent may be started after this host is already listening, so wait for a
  // device to appear before pairing; --pair-file is optional and only needed when
  // the pairing string is not already known here.
  if (pairFile && existsSync(pairFile)) {
    const pair = readFileSync(pairFile, "utf8").trim();
    console.log(`\npair: ${pair.slice(0, 40)}...`);
    console.log((await call({ cmd: "pair", text: pair })).content?.[0]?.text?.split("\n")[0]);
  } else {
    console.log("\nno --pair-file; waiting for an already-paired device to attach");
  }

  let online = false;
  // Generous window: the remote agent may be mid-backoff when this starts.
  for (let i = 0; i < 2400 && !online; i++) {
    online = /ONLINE/.test((await call({ cmd: "devices" })).content?.[0]?.text ?? "");
    if (!online) await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`attached: ${online}`);
  if (!online) {
    console.error("the remote agent never attached");
    process.exit(2);
  }

  const results = [];
  const record = (label, text, ok) => {
    results.push({ label, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${String(text).split("\n").slice(0, 3).join("\n      ")}`);
  };

  const info = await call({ cmd: "info" });
  const infoText = info.content?.[0]?.text ?? "";
  let infoJson = null;
  try { infoJson = JSON.parse(infoText); } catch { /* shown raw */ }
  record(`info: ${infoJson?.host ?? "?"} ${infoJson?.os ?? "?"}/${infoJson?.arch ?? "?"} flavor=${infoJson?.flavor} node=${infoJson?.nodeSource ?? "none"}`, infoText, !!infoJson?.host);

  const uname = await call({ cmd: "exec", args: { command: "uname -a && id -un && echo SHELL-OK" }, timeoutMs: 30000 });
  const unameText = uname.content?.[0]?.text ?? "";
  record("exec: uname/id over the real network", unameText, /SHELL-OK/.test(unameText) && /Linux/.test(unameText));

  const utf = await call({ cmd: "exec", args: { command: "echo '中文 · Ünïcödé · 🎯'" }, timeoutMs: 30000 });
  const utfText = utf.content?.[0]?.text ?? "";
  record("exec: non-ASCII through the real network", utfText, /中文/.test(utfText));

  const file = `/root/rdsh-e2e-${Date.now()}.txt`;
  const payload = "written from the controller over the relay ✅";
  const w = await call({ cmd: "write", args: { path: file, text: payload } });
  const r = await call({ cmd: "read", args: { path: file } });
  let back = null;
  try { back = JSON.parse(r.content?.[0]?.text ?? ""); } catch { /* shown raw */ }
  record("file: write+read round-trip", JSON.stringify(back?.text ?? r.content?.[0]?.text), back?.text === payload);

  const ls = await call({ cmd: "ls", args: { path: "/root" } });
  record("ls: /root lists the file we wrote", (ls.content?.[0]?.text ?? "").slice(0, 120), new RegExp(file.split("/").pop()).test(ls.content?.[0]?.text ?? ""));

  const nodeRun = await call({ cmd: "node", args: { script: "console.log('node-on-linux', process.platform, process.version)" }, timeoutMs: 40000 });
  const nodeText = nodeRun.content?.[0]?.text ?? "";
  record("node: .mjs on the remote host", nodeText, /node-on-linux/.test(nodeText));

  const bg = await call({ cmd: "exec-bg", args: { command: "sleep 3; echo bg-finished", label: "xnet" } });
  let runId = null;
  try { runId = JSON.parse(bg.content?.[0]?.text ?? "").runId; } catch { /* shown raw */ }
  let collected = null;
  for (let i = 0; i < 60 && !collected; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const j = await call({ cmd: "jobs", args: { runId } });
    if (/bg-finished/.test(j.content?.[0]?.text ?? "")) collected = j.content[0].text;
  }
  record("background job collected", collected ?? "never finished", !!collected);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cross-machine checks passed`);
  // Stay alive after the scripted run: this process is a host, and the agent on
  // the other end may still be connected. Print the verdict and keep serving.
  console.log(failed.length ? "CROSS-MACHINE-FAILED" : "CROSS-MACHINE-OK");
  console.log("host still listening; interrupt to stop");
}

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
