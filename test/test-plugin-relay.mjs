// End-to-end test of the RemoteDSH controller plugin against the real agent
// binary: a stub webServer hosts the plugin's relay seat, the agent dials in over
// a genuine WebSocket upgrade, and the `remote` tool drives it.
//
//   node test/test-plugin-relay.mjs
//
// This is the ground truth for the reverse-connect path: real WebSocket framing
// (both ends implement RFC 6455 independently), real HMAC attach auth, real
// signed RPC over the tunnel.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = process.argv[2] ?? join(here, "..", "03-bin", "win-x64", "rdsh.exe");
if (!existsSync(exe)) {
  console.error(`agent binary not found: ${exe}`);
  process.exit(2);
}

const results = [];
function check(name, okPass, detail = "") {
  results.push({ name, ok: okPass });
  console.log(`${okPass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── build a stub context that quacks like the harness ──────────────────────
function makeContext() {
  const exact = new Map();
  const prefixes = [];
  const upgrades = new Map();
  const guards = [];
  const disposeHandlers = [];
  const logs = [];

  const webServer = {
    register(route) {
      if (route.kind === "exact") exact.set(route.path, route.handler);
      else prefixes.push(route);
      return () => (route.kind === "exact" ? exact.delete(route.path) : prefixes.splice(prefixes.indexOf(route), 1));
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route.handler);
      return () => upgrades.delete(route.path);
    },
    // The real webServer is patched with this hook, and the plugin uses it to
    // claim its own paths before web-auth's guard can deny them.
    registerGuard(guard) {
      guards.push(guard);
      return () => guards.splice(guards.indexOf(guard), 1);
    },
    registerFallback() {
      return () => {};
    },
  };

  const registeredTools = [];
  const ctx = {
    webServer,
    tools: {
      register(def) {
        registeredTools.push(def);
        return () => {};
      },
    },
    logger: {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
    },
    on(event, handler) {
      if (event === "dispose") disposeHandlers.push(handler);
    },
    // test-only handles
    _exact: exact,
    _prefixes: prefixes,
    _upgrades: upgrades,
    _guards: guards,
    _tools: registeredTools,
    _logs: logs,
    _dispose: () => disposeHandlers.forEach((h) => h()),
  };
  return ctx;
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "rdsh-plugin-"));
  const stateFile = join(home, "devices.json");
  const agentHome = join(home, "agenthome");

  // ── start the HTTP server that owns the socket ───────────────────────────
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const handler = ctx._exact.get(url.pathname);
    if (handler) return void handler(req, res);
    const match = ctx._prefixes
      .filter((p) => url.pathname.startsWith(p.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (match) return void match.handler(req, res);
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"ok":false,"code":"not_found"}');
  });

  const ctx = makeContext();

  // ── load the plugin with the stub context ────────────────────────────────
  const mod = await import(pathToFileURL(join(here, "..", "02-plugin", "index.js")).href);
  check("plugin module loads", typeof mod.apply === "function" && mod.name === "dsh-remote", `name=${mod.name}`);
  check("plugin declares its seams", Array.isArray(mod.inject) && mod.inject.includes("webServer") && mod.inject.includes("tools"), mod.inject?.join(","));

  mod.apply(ctx, { stateFile, attachPath: "/remote/attach", panelPath: "/remote/" });

  check("relay upgrade seat registered", ctx._upgrades.has("/remote/attach"));
  check("liveness probe registered", ctx._exact.has("/remote/ping"));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const handler = ctx._upgrades.get(url.pathname);
    if (!handler) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    handler(req, socket, head);
  });

  // ── the tool registration is async (dynamic import) ──────────────────────
  for (let i = 0; i < 100 && ctx._tools.length === 0; i++) await sleep(100);
  if (ctx._tools.length === 0) {
    console.log("plugin log:");
    for (const [level, msg] of ctx._logs) console.log(`  [${level}] ${msg}`);
  }
  check("remote tool registered", ctx._tools.length === 1, `tools=${ctx._tools.length}`);
  const tool = ctx._tools[0];
  if (!tool) {
    console.log("\nCannot continue without the tool; aborting.");
    server.close();
    process.exit(1);
  }

  // ── ping endpoint answers (this is what agent-side discovery probes) ─────
  {
    const res = await fetch(`${base}/remote/ping`);
    const body = await res.json();
    check("GET /remote/ping identifies the service", res.ok && body.service === "dsh-remote", JSON.stringify(body));
  }

  // ── agent side: start the binary, read its pairing string ───────────────
  const agent = spawn(exe, ["--relay", base, "--no-discover", "--listen", "127.0.0.1", "--port", "0"], {
    env: { ...process.env, RDSH_HOME: agentHome },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let agentOut = "";
  agent.stdout.on("data", (d) => (agentOut += d.toString()));
  agent.stderr.on("data", (d) => (agentOut += d.toString()));

  let pairString = null;
  for (let i = 0; i < 100 && !pairString; i++) {
    const m = agentOut.match(/DshAgent:[A-Za-z0-9_-]+/);
    if (m) pairString = m[0];
    else await sleep(100);
  }
  check("agent prints a pairing string", !!pairString, pairString ? pairString.slice(0, 34) + "..." : "not found");

  // ── pair through the tool ────────────────────────────────────────────────
  {
    const res = await tool.execute({ cmd: "pair", text: pairString, description: "pair the target" }, { signal: new AbortController().signal });
    const text = res.content?.[0]?.text ?? "";
    check("pair registers the device", !res.isError && /paired device/.test(text), text.split("\n")[0]);
  }

  // ── wait for the agent's reverse connection to land ─────────────────────
  let online = false;
  for (let i = 0; i < 100 && !online; i++) {
    const devices = await tool.execute({ cmd: "devices" }, { signal: new AbortController().signal });
    online = /ONLINE/.test(devices.content?.[0]?.text ?? "");
    if (!online) await sleep(150);
  }
  check("agent attaches over the reverse relay", online, online ? "device reported ONLINE" : "never came online");

  // ── identity over the tunnel ────────────────────────────────────────────
  {
    const res = await tool.execute({ cmd: "info" }, { signal: new AbortController().signal });
    const text = res.content?.[0]?.text ?? "";
    let info = null;
    try { info = JSON.parse(text); } catch { /* reported below */ }
    check("info round-trips through the relay", !!info?.host, info ? `host=${info.host} os=${info.os} childEncoding=${info.childEncoding} codePage=${info.childCodePage}` : text.slice(0, 120));
  }

  // ── exec over the tunnel ────────────────────────────────────────────────
  {
    const res = await tool.execute({ cmd: "exec", args: { command: "echo relay-hello" }, timeoutMs: 20000 }, { signal: new AbortController().signal });
    const text = res.content?.[0]?.text ?? "";
    check("exec runs through the relay", !res.isError && text.includes("relay-hello") && /exit=0/.test(text), text.split("\n")[0]);
  }

  {
    const res = await tool.execute({ cmd: "exec", args: { command: "exit /b 5" }, timeoutMs: 20000 }, { signal: new AbortController().signal });
    const text = res.content?.[0]?.text ?? "";
    check("exit code is reported through the relay", /exit=5/.test(text), text.split("\n")[0]);
  }

  // Non-ASCII fidelity is verified through a file round-trip, not through the
  // shell's command line: cmd.exe receives argument bytes in the console code
  // page, so echoing a non-ASCII literal tests Windows' argv encoding rather
  // than the agent. Writing and reading the bytes back tests the real thing.
  {
    const target = join(agentHome, "unicode.txt");
    const payload = "中文测试 · 日本語 · emoji 🎯 · ünïcödé";
    await tool.execute({ cmd: "write", args: { path: target, text: payload } }, { signal: new AbortController().signal });
    const back = await tool.execute({ cmd: "read", args: { path: target } }, { signal: new AbortController().signal });
    let parsed = null;
    try { parsed = JSON.parse(back.content?.[0]?.text ?? ""); } catch { /* reported below */ }
    check("non-ASCII content round-trips through the tunnel",
      parsed?.text === payload,
      parsed ? JSON.stringify(String(parsed.text).slice(0, 40)) : (back.content?.[0]?.text ?? "").slice(0, 100));
  }
  // ── files over the tunnel ───────────────────────────────────────────────
  {
    const target = join(agentHome, "relay-file.txt");
    const w = await tool.execute({ cmd: "write", args: { path: target, text: "written through the relay" } }, { signal: new AbortController().signal });
    const r = await tool.execute({ cmd: "read", args: { path: target } }, { signal: new AbortController().signal });
    const rtext = r.content?.[0]?.text ?? "";
    let parsed = null;
    try { parsed = JSON.parse(rtext); } catch { /* reported below */ }
    check("file write+read round-trips through the relay",
      !w.isError && parsed?.text === "written through the relay",
      parsed ? JSON.stringify(parsed.text) : rtext.slice(0, 120));

    const ls = await tool.execute({ cmd: "ls", args: { path: agentHome } }, { signal: new AbortController().signal });
    check("ls lists the target directory", /relay-file\.txt/.test(ls.content?.[0]?.text ?? ""));
  }

  // ── background job over the tunnel ──────────────────────────────────────
  {
    const bg = await tool.execute({ cmd: "exec-bg", args: { command: "timeout /t 3 /nobreak > nul & echo relay-bg-done", label: "relaybg" } }, { signal: new AbortController().signal });
    const bgText = bg.content?.[0]?.text ?? "";
    let runId = null;
    try { runId = JSON.parse(bgText).runId; } catch { /* reported below */ }
    check("exec-bg starts a remote background job", !!runId, bgText.slice(0, 100));

    let finished = null;
    for (let i = 0; i < 40 && !finished; i++) {
      await sleep(400);
      const jobs = await tool.execute({ cmd: "jobs", args: { runId } }, { signal: new AbortController().signal });
      const jtext = jobs.content?.[0]?.text ?? "";
      if (/relay-bg-done/.test(jtext)) finished = jtext;
    }
    check("background job output is collectable", !!finished, finished ? "saw relay-bg-done" : "never completed");
  }

  // ── node on the target, over the tunnel ─────────────────────────────────
  {
    const res = await tool.execute({ cmd: "node", args: { script: "console.log('relay-mjs', 6 * 7)" }, timeoutMs: 30000 }, { signal: new AbortController().signal });
    const text = res.content?.[0]?.text ?? "";
    check("node runs an .mjs on the target through the relay", text.includes("relay-mjs 42"), text.split("\n").slice(0, 2).join(" | "));
  }

  // ── bad attach auth is refused ──────────────────────────────────────────
  {
    const rejected = await new Promise((resolve) => {
      const req = createServer(); // placeholder to keep types obvious
      req.close();
      const net = require("node:net");
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          "GET /remote/attach?id=not-a-device HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      let data = "";
      sock.on("data", (d) => (data += d.toString()));
      sock.on("close", () => resolve(data));
      sock.on("error", () => resolve(data));
      setTimeout(() => { sock.destroy(); resolve(data); }, 3000);
    });
    check("unknown device cannot claim the relay seat", /40[13]/.test(rejected) || rejected === "", rejected.split("\r\n")[0] || "(closed without response)");
  }

  // ── panel renders ───────────────────────────────────────────────────────
  {
    const res = await fetch(`${base}/remote/`);
    const html = await res.text();
    check("panel renders the device table", res.ok && /RemoteDSH/.test(html) && /remote DSH link/.test(html), `bytes=${html.length}`);
    check("panel does not leak secrets", !html.includes("secret") && !/sec=/.test(html));
  }

  // ── teardown ────────────────────────────────────────────────────────────
  ctx._dispose();
  agent.kill();
  server.close();
  await sleep(400);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* windows locks */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("failed: " + failed.map((f) => f.name).join(" | "));
    process.exit(1);
  }
  console.log("PLUGIN-RELAY-OK");
}

// `require` is needed by the raw-socket probe above inside an ESM module.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
