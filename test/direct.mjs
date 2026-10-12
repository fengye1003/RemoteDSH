#!/usr/bin/env node
/**
 * direct.mjs —— 用「直连模式」驱动 RemoteDSH agent，完全不依赖中继与 harness。
 *
 * 为什么需要它：agent 的**反连隧道可能死掉**（进程还活着、直连口还在听，但再也不拨中继）。
 * 直连模式是 agent 的另外半条腿，只要目标机在 tailnet 上可达就能用。
 * 本工具复用插件自己的 DirectTransport 与 HMAC 签名实现，只把 listen 地址换成 tailnet 地址。
 *
 * 用法:
 *   node test/direct.mjs info
 *   node test/direct.mjs exec "whoami" [--timeout 120000] [--out f]
 *   node test/direct.mjs exec-bg "..." [--label x]
 *   node test/direct.mjs jobs [runId]
 *   node test/direct.mjs ls "D:\\"
 *   node test/direct.mjs cat "D:\\x.txt"
 *   node test/direct.mjs put <local> <remote>
 *   node test/direct.mjs rpc <method> '<jsonArgs>'
 *
 * 全局开关:
 *   --host <ip>    默认 agent-host.local
 *   --port <n>     默认 4627
 *   --out <file>   默认 test/_direct.txt
 *   --id <device>  多设备时指定
 *
 * 结果写 --out（UTF-8），stdout 只打 ASCII 摘要（绕开控制台 GBK 码页）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const positional = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { i++; continue; }
    positional.push(argv[i]);
  }
}

const host = argOf("host", "agent-host.local");
const port = argOf("port", "4627");
const outFile = resolve(argOf("out", join(here, "_direct.txt")));
const wantedId = argOf("id");
const timeoutMs = Number(argOf("timeout", 120_000));

const plugin = await import(pathToFileURL(join(root, "02-plugin", "index.js")).href);
const store = JSON.parse(readFileSync(join(root, "data", "host-lan-devices.json"), "utf8"));
const list = Array.isArray(store.devices) ? store.devices : [];
const dev = wantedId ? list.find((d) => d.id === wantedId) : list[0];
if (!dev) {
  console.error(`[NG] no device in store (${list.length} known)`);
  process.exit(2);
}

const base = `http://${host}:${port}`;
const transport = new plugin.__internals.DirectTransport({ ...dev, listen: base }, { info() {}, warn() {} });

const write = (text) => {
  writeFileSync(outFile, text, "utf8");
  console.log(`[OK] chars=${text.length} out=${outFile}  device=${dev.id} @ ${base}`);
};

async function runToCompletion(method, args) {
  const started = await transport.call(method, args, { timeoutMs: Math.min(timeoutMs, 30_000) });
  if (started?.ok !== true) return { reply: started, out: "", err: "" };
  const runId = started.data?.runId;
  if (!runId) return { reply: { ok: false, error: "no runId" }, out: "", err: "" };
  const deadline = Date.now() + timeoutMs;
  let out = "", err = "", last = null;
  while (Date.now() < deadline) {
    const poll = await transport.call("poll", { runId, waitMs: 1200 }, { timeoutMs: 12_000 });
    if (poll?.ok !== true) return { reply: poll, out, err };
    out += poll.data?.out ?? "";
    err += poll.data?.err ?? "";
    last = poll.data ?? null;
    if (last?.done) break;
  }
  if (last && !last.done) {
    await transport.call("kill", { runId }, { timeoutMs: 5000 });
    last = { ...last, done: true, killed: true, exitCode: -1 };
  }
  return { reply: { ok: true, data: { runId, ...last } }, out, err };
}

const sub = positional[0];
let text = "";

switch (sub) {
  case "info": {
    const r = await transport.call("hello", {}, { timeoutMs: 20_000 });
    text = JSON.stringify(r, null, 2);
    break;
  }
  case "exec": {
    const command = positional[1];
    if (!command) { console.error("exec needs a command"); process.exit(2); }
    const { reply, out, err } = await runToCompletion("exec", { command, timeoutMs });
    const d = reply?.data ?? {};
    text = `exit=${d.exitCode} elapsed=${d.elapsedMs ?? "?"}ms done=${d.done}\n${out}${err ? "\n--- stderr ---\n" + err : ""}`;
    break;
  }
  case "exec-bg": {
    const command = positional[1];
    const r = await transport.call("exec", { command, detached: true, timeoutMs: 0, label: argOf("label", "direct") }, { timeoutMs: 20_000 });
    text = JSON.stringify(r, null, 2);
    break;
  }
  case "jobs": {
    const runId = positional[1];
    const r = runId
      ? await transport.call("poll", { runId, waitMs: 0 }, { timeoutMs: 20_000 })
      : await transport.call("jobs", {}, { timeoutMs: 20_000 });
    text = JSON.stringify(r, null, 2);
    break;
  }
  case "ls": {
    const r = await transport.call("ls", { path: positional[1] ?? "." }, { timeoutMs: 30_000 });
    text = r?.ok ? JSON.stringify(r.data, null, 2) : JSON.stringify(r, null, 2);
    break;
  }
  case "cat": {
    const r = await transport.call("read", { path: positional[1] }, { timeoutMs: 30_000 });
    text = r?.ok ? (r.data?.text ?? JSON.stringify(r.data)) : JSON.stringify(r, null, 2);
    break;
  }
  case "put": {
    const [, local, remote] = positional;
    if (!local || !remote) { console.error("put <local> <remote>"); process.exit(2); }
    const bytes = readFileSync(resolve(local));
    const r = await transport.call("write", { path: remote, base64: bytes.toString("base64") }, { timeoutMs: 60_000 });
    text = JSON.stringify(r, null, 2);
    break;
  }
  case "rpc": {
    const method = positional[1];
    const args = positional[2] ? JSON.parse(positional[2]) : {};
    const r = await transport.call(method, args, { timeoutMs: 60_000 });
    text = JSON.stringify(r, null, 2);
    break;
  }
  default:
    console.error("usage: direct.mjs <info|exec|exec-bg|jobs|ls|cat|put|rpc> ...");
    process.exit(2);
}

write(text);
