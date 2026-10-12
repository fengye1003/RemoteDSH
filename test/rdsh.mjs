#!/usr/bin/env node
/**
 * rdsh.mjs —— 本地驱动 RemoteDSH 目标机的小 CLI（走 host-lan.mjs 的回环控制口）
 *
 * 用法:
 *   node test/rdsh.mjs info
 *   node test/rdsh.mjs devices
 *   node test/rdsh.mjs exec "whoami" [--timeout 60000] [--workdir C:\] [--out <file>]
 *   node test/rdsh.mjs ls "C:\Windows"
 *   node test/rdsh.mjs cat "C:\path\to.txt" [--out <file>]
 *   node test/rdsh.mjs get <remotePath> <localPath>
 *   node test/rdsh.mjs put <localPath> <remotePath>
 *   node test/rdsh.mjs raw '<json payload>'
 *
 * 结果一律以 UTF-8 写到 --out（默认 test/_rdsh.txt），stdout 只打 ASCII 摘要，
 * 免得控制台 GBK 码页把中文输出搞花。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const CTL = "http://127.0.0.1:8101/ctl";

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    i++; // 跳过它的值
    continue;
  }
  positional.push(argv[i]);
}

const sub = positional[0];
const outFile = resolve(argOf("out", join(here, "_rdsh.txt")));
const timeoutMs = Number(argOf("timeout", 120_000));

function token() {
  return readFileSync(join(root, "data", "_ctl-token.txt"), "utf8").trim();
}

async function ctl(payload) {
  const res = await fetch(CTL, {
    method: "POST",
    headers: { "x-ctl-token": token(), "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs + 30_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

function report(json, extra = "") {
  const text = typeof json.text === "string" ? json.text : JSON.stringify(json.raw ?? json, null, 2);
  writeFileSync(outFile, text, "utf8");
  console.log(`[${json.ok ? "OK" : "NG"}] chars=${text.length} out=${outFile}${extra}`);
  if (!json.ok) process.exitCode = 1;
}

function build() {
  switch (sub) {
    case "info":
      return { cmd: "info" };
    case "devices":
      return { cmd: "devices" };
    case "exec": {
      const command = positional[1];
      if (!command) throw new Error("exec needs a command");
      const args = { command };
      const wd = argOf("workdir");
      if (wd) args.workdir = wd;
      // 注意：timeoutMs 走顶层，不是塞进 args（插件读的是顶层）
      return { cmd: "exec", args, timeoutMs };
    }
    case "exec-bg": {
      const command = positional[1];
      if (!command) throw new Error("exec-bg needs a command");
      return { cmd: "exec-bg", args: { command, label: argOf("label", "cli") } };
    }
    case "jobs":
      return { cmd: "jobs", args: positional[1] ? { runId: positional[1] } : {} };
    case "ls":
      return { cmd: "ls", args: { path: positional[1] ?? "." } };
    case "cat":
      return { cmd: "read", args: { path: positional[1] } };
    case "get": {
      const [, remote, local] = positional;
      if (!remote || !local) throw new Error("get <remote> <local>");
      return { cmd: "read", args: { path: remote, base64: true }, __save: { remote, local }, __b64: true };
    }
    case "put": {
      const [, local, remote] = positional;
      if (!local || !remote) throw new Error("put <local> <remote>");
      const bytes = readFileSync(resolve(local));
      return { cmd: "write", args: { path: remote, base64: bytes.toString("base64") }, __put: { local, remote, size: bytes.length } };
    }
    case "raw": {
      const raw = positional[1];
      if (!raw) throw new Error("raw '<json>'");
      return JSON.parse(raw);
    }
    default:
      throw new Error(`unknown subcommand: ${sub ?? "(none)"}\n  info|devices|exec|exec-bg|jobs|ls|cat|get|put|raw`);
  }
}

const payload = build();
const save = payload.__save;
const put = payload.__put;
const isB64 = payload.__b64;
delete payload.__save;
delete payload.__b64;
delete payload.__put;

const json = await ctl(payload);

if (save) {
  // read + base64 → 落成本地文件
  let parsed = null;
  try {
    parsed = JSON.parse(json.text);
  } catch {
    /* 原样处理 */
  }
  const b64 = parsed?.base64 ?? parsed?.text;
  if (typeof b64 !== "string") throw new Error(`unexpected read reply: ${String(json.text).slice(0, 200)}`);
  writeFileSync(resolve(save.local), Buffer.from(b64, "base64"));
  console.log(`[OK] got ${basename(save.remote)} -> ${save.local} (${Buffer.from(b64, "base64").length} bytes)`);
} else if (put) {
  console.log(`[${json.ok ? "OK" : "NG"}] put ${put.local} -> ${put.remote} (${put.size} bytes) :: ${String(json.text).replace(/\s+/g, " ").slice(0, 160)}`);
  if (!json.ok) process.exitCode = 1;
} else {
  report(json, isB64 ? " (base64)" : "");
}
