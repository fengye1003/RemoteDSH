// Windows-side end-to-end driver for the x86 compat agent (04-agent32/rdsh32.exe).
//
// Same shape as host-standalone.mjs: run the REAL controller plugin against a stub
// webServer, let an agent dial in over the relay seat, then drive it through the
// real `remote` tool. The difference is that every check here is Windows-shaped
// (cmd.exe, %TEMP%, CRLF-safe paths), because the agent under test is the native
// x86 build meant for Windows 7.
//
//   node test/drive-win32.mjs --port 18099 --pair-file <path> [--store <file>]

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", 18099));
const pairFile = arg("pair-file");
const storeFile = arg("store") ?? join(here, "..", "data", "win32-devices.json");

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
  for (const g of guards) if (g.check && g.check(req, res, url.pathname) === false) return;
  const h = exact.get(url.pathname);
  if (h) return void h(req, res);
  const p = prefixes.filter((x) => url.pathname.startsWith(x.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (p) return void p.handler(req, res);
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"ok":false,"code":"not_found"}');
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  console.log(`[host] upgrade ${url.pathname}${url.search}`);
  for (const g of guards) if (g.checkUpgrade && g.checkUpgrade(req, socket, head, url.pathname) === false) return;
  const h = upgrades.get(url.pathname);
  if (!h) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  h(req, socket, head);
});

mkdirSync(dirname(storeFile), { recursive: true });
const mod = await import(pathToFileURL(join(here, "..", "02-plugin", "index.js")).href);
mod.apply(ctx, { stateFile: storeFile });

await new Promise((r) => server.listen(port, "127.0.0.1", r));
console.log(`host ready: http://127.0.0.1:${port}`);

for (let i = 0; i < 100 && tools.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
if (tools.length === 0) {
  console.error("the remote tool never registered; aborting");
  process.exit(1);
}
const tool = tools[0];

// ── output-contract guard ────────────────────────────────────────────────────
// The real harness validates whatever execute() returns against the tool's declared
// output.schema BEFORE render(). This stub used to skip that, which is exactly how
// 2026-10-09's "missing required property value.ok" bug shipped: the plugin returned
// the old {content:[...]} envelope and every call failed in production while this
// driver stayed green. A stub that is more permissive than production is a blind
// spot, so mirror the validation here.
const SCALARS = { string: (v) => typeof v === "string", number: (v) => typeof v === "number", boolean: (v) => typeof v === "boolean" };

function validateOutput(value, schema, path = "value", out = []) {
  if (!schema || typeof schema !== "object") return out;
  const type = schema.type;
  if (type === undefined || type === "json") {
    // annotation-only: anything JSON-serializable is fine
    return out;
  }
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      out.push(`${path} must be an object`);
      return out;
    }
    const props = schema.properties ?? {};
    // The harness accepts requiredness either as a top-level array or as a
    // per-property `required: true`; both are checked.
    const required = new Set([...(Array.isArray(schema.required) ? schema.required : [])]);
    for (const [key, spec] of Object.entries(props)) if (spec?.required === true) required.add(key);
    for (const key of required) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`missing required property "${path}.${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) out.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`);
      }
    }
    for (const [key, spec] of Object.entries(props)) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) validateOutput(value[key], spec, `${path}.${key}`, out);
    }
    return out;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      out.push(`${path} must be an array`);
      return out;
    }
    if (schema.items) value.forEach((item, i) => validateOutput(item, schema.items, `${path}[${i}]`, out));
    return out;
  }
  if (SCALARS[type] && !SCALARS[type](value)) out.push(`"${path}" must be a ${type}`);
  return out;
}

let contractViolations = 0;
const call = async (args) => {
  const reply = await tool.execute(args, { signal: new AbortController().signal });
  const violations = validateOutput(reply, tool.output?.schema);
  if (violations.length) {
    contractViolations++;
    console.error(`FAIL  output contract (remote ${args?.cmd}): ${violations.join("; ")}`);
  }
  return reply;
};

// Prove the guard itself works: the old {content:[...]} envelope must trip it, or
// this whole check is decoration.
const guardSelfCheck = validateOutput(
  { content: [{ type: "text", text: "x" }] },
  { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
);
if (guardSelfCheck.length < 2) {
  console.error("output-contract guard self-check failed; it would not catch the old-envelope bug");
  process.exit(1);
}
console.log(`output-contract guard active (self-check found ${guardSelfCheck.length} violations on the old shape)`);

// This harness version has execute() return a plain value ({text}); older builds
// returned {content:[{type:'text'}]}. Accept both so the driver survives either.
const text = (reply) => reply?.content?.[0]?.text ?? (typeof reply?.text === "string" ? reply.text : "");
console.log("remote tool registered; waiting for the x86 agent");

if (pairFile) {
  for (let i = 0; i < 200 && !existsSync(pairFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (existsSync(pairFile)) {
    const pair = readFileSync(pairFile, "utf8").trim();
    console.log(`\npairing ${pair.slice(0, 24)}...`);
    console.log(text(await call({ cmd: "pair", text: pair })).split("\n")[0]);
  } else {
    console.error(`no pairing string at ${pairFile}`);
    process.exit(1);
  }
}

let online = false;
for (let i = 0; i < 300 && !online; i++) {
  online = /ONLINE/.test(text(await call({ cmd: "devices" })));
  if (!online) await new Promise((r) => setTimeout(r, 200));
}
console.log(`attached: ${online}`);
if (!online) {
  console.error("the agent never attached");
  process.exit(2);
}

const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${String(detail).split("\n").slice(0, 4).join("\n      ")}` : ""}`);
};

const info = text(await call({ cmd: "info" }));
let infoJson = null;
try {
  infoJson = JSON.parse(info);
} catch {
  /* shown raw */
}
record(`info: ${infoJson?.host ?? "?"} ${infoJson?.os ?? "?"}/${infoJson?.arch ?? "?"} flavor=${infoJson?.flavor}`, !!infoJson?.host, info);

const echo = text(await call({ cmd: "exec", args: { command: "echo x86-agent-ok && ver" }, timeoutMs: 30000 }));
record("exec: shell round-trip", /x86-agent-ok/.test(echo), echo);

const uni = text(await call({ cmd: "exec", args: { command: "echo 中文测试 · 正常" }, timeoutMs: 30000 }));
record("exec: CJK output survives the code-page bridge", /中文测试/.test(uni) && /正常/.test(uni), uni);

// cmd.exe echoes in the console code page, so anything outside GBK comes back as
// '?' — that is Windows, not the agent. A child that emits UTF-8 itself must pass
// through untouched.
const utf8 = text(
  await call({
    cmd: "exec",
    args: {
      command:
        "powershell -NoProfile -Command \"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; 'Ünïcödé 中文 🎯'\"",
    },
    timeoutMs: 40000,
  }),
);
record("exec: UTF-8 child output passes through", /Ünïcödé/.test(utf8) && /中文/.test(utf8), utf8);

const tmp = process.env.TEMP || "C:\\\\Windows\\\\Temp";
const file = `${tmp}\\\\rdsh32-e2e-${Date.now()}.txt`;
const payload = "written from the controller over the relay";
const w = JSON.parse(text(await call({ cmd: "write", args: { path: file, text: payload } })));
const r = JSON.parse(text(await call({ cmd: "read", args: { path: file } })));
record(`file: write+read round-trip (${w?.bytes ?? "?"} bytes)`, r?.text === payload, JSON.stringify(r).slice(0, 200));

const ls = text(await call({ cmd: "ls", args: { path: tmp } }));
record("ls: %TEMP% lists the file we wrote", ls.includes(file.split("\\\\").pop()), ls.slice(0, 200));

const st = JSON.parse(text(await call({ cmd: "stat", args: { path: file } })));
record(`stat: kind=${st?.kind} size=${st?.size}`, st?.exists === true && st?.kind === "file", JSON.stringify(st));

const bg = JSON.parse(text(await call({ cmd: "exec-bg", args: { command: "ping -n 3 127.0.0.1 >nul & echo bg-finished", label: "bg" } })));
let collected = null;
for (let i = 0; i < 60 && !collected; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const j = text(await call({ cmd: "jobs", args: { runId: bg?.runId } }));
  if (/bg-finished/.test(j)) collected = j;
}
record("background job started and collected", !!collected, collected ? "collected" : text(await call({ cmd: "jobs" })).slice(0, 300));

const rm = JSON.parse(text(await call({ cmd: "rm", args: { path: file } })));
record("rm: soft delete", rm?.ok === true, JSON.stringify(rm));

// ── edge cases that a non-English target machine will actually hit ───────────
// Non-ASCII path with a space: the classic breakage point for a native agent that
// mixes ANSI and wide Win32 calls.
const cjkDir = `${tmp}\\\\rdsh32 中文目录 ${Date.now()}`;
const cjkFile = `${cjkDir}\\\\测试 文件.txt`;
const cjkPayload = "中文内容 round-trip ✓";
const cw = JSON.parse(text(await call({ cmd: "write", args: { path: cjkFile, text: cjkPayload } })));
const cr = JSON.parse(text(await call({ cmd: "read", args: { path: cjkFile } })));
const cls = JSON.parse(text(await call({ cmd: "ls", args: { path: cjkDir } })));
record(
  "file: Chinese path with a space round-trips (write/read/ls)",
  cw?.bytes > 0 && cr?.text === cjkPayload && (cls?.entries ?? []).some((e) => e.name === "测试 文件.txt"),
  JSON.stringify({ wrote: cw?.bytes, read: cr?.text, entries: (cls?.entries ?? []).map((e) => e.name) }),
);
const crm = JSON.parse(text(await call({ cmd: "rm", args: { path: cjkFile } })));
record("rm: Chinese path", crm?.ok === true, JSON.stringify(crm));

// Binary payload via base64. NOTE: the plugin REDIRACTS the payload when it renders
// a result — `read` with base64:true comes back as "[N base64 chars]" on purpose, so
// binary never lands in the model's context. Byte-exactness is therefore proven on
// the target, by hashing the file the agent wrote with the target's own certutil.
const raw = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f, 0x0d, 0x0a, 0x41, 0x00, 0xc3, 0xa9]);
const expectHash = createHash("sha256").update(raw).digest("hex");
const binFile = `${tmp}\\\\rdsh32-bin-${Date.now()}.bin`;
const bw = JSON.parse(text(await call({ cmd: "write", args: { path: binFile, base64: raw.toString("base64") } })));
const br = JSON.parse(text(await call({ cmd: "read", args: { path: binFile, base64: true } })));
const hashOut = text(await call({ cmd: "exec", args: { command: `certutil -hashfile "${binFile}" SHA256` }, timeoutMs: 30000 }));
const gotHash = (hashOut.match(/\b[0-9a-fA-F]{64}\b/) ?? [""])[0].toLowerCase();
record(
  `file: binary write is byte-exact on the target (${bw?.bytes ?? "?"} bytes; read reports ${br?.base64 ?? "?"})`,
  bw?.bytes === raw.length && gotHash === expectHash && br?.base64 === "[16 base64 chars]",
  JSON.stringify({ wrote: bw?.bytes, want: expectHash.slice(0, 16), got: gotHash.slice(0, 16), read: br?.base64 }),
);
await call({ cmd: "rm", args: { path: binFile } });

// Exit codes must survive the shell wrapper.
const exitOk = text(await call({ cmd: "exec", args: { command: "exit /b 7" }, timeoutMs: 20000 }));
record("exec: exit code propagates", /exit=7\b/.test(exitOk), exitOk);

// A long-running command must be killed by the deadline, not left hanging.
const slow = text(await call({ cmd: "exec", args: { command: "ping -n 30 127.0.0.1 >nul" }, timeoutMs: 3000 }));
record("exec: deadline kills a long command", /timed out on the target/.test(slow) && /elapsed=[0-9]+ms/.test(slow), slow);

// Big output. The plugin caps the rendered text at ~12000 chars on purpose, so the
// assertion is "the head arrives, the run succeeds, and the real length is large".
const big = text(
  await call({
    cmd: "exec",
    args: { command: "for /l %i in (1,1,1500) do @echo line-%i" },
    timeoutMs: 60000,
  }),
);
record(
  `exec: ~1500 lines of output (${big.length} chars rendered)`,
  /line-1\b/.test(big) && /exit=0/.test(big) && big.length > 8000,
  big.slice(0, 60).replace(/\n/g, " | ") + "  ...  " + big.slice(-60).replace(/\n/g, " | "),
);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (contractViolations) console.log(`output-contract violations: ${contractViolations}`);
console.log(failed.length || contractViolations ? "WIN32-E2E-FAILED" : "WIN32-E2E-OK");
console.log("host still listening; interrupt to stop");
