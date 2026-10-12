// Byte-level probe: what does the agent actually return for a non-ASCII command?
// Explains the "non-ASCII output" assertion in test-plugin-relay.mjs.
//
//   node test/diag-encoding.mjs

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "..", "03-bin", "win-x64", "rdsh.exe");
const home = mkdtempSync(join(tmpdir(), "rdsh-enc-"));
const text = "中文测试";
const utf8 = Buffer.from(text, "utf8");
console.log(`expected utf8  : ${utf8.toString("hex")}  (${utf8.length} bytes)`);

// 1. What does the platform shell itself write to a pipe?
for (const [label, file, args] of [
  ["cmd echo", "cmd.exe", ["/d", "/s", "/c", `echo ${text}`]],
  ["chcp", "chcp.com", []],
]) {
  const r = spawnSync(file, args, { encoding: "buffer", windowsHide: true });
  console.log(`[${label}] stdout hex: ${r.stdout?.toString("hex")}`);
}

// 2. What does the agent return over RPC for the same command?
const port = 21000 + Math.floor(Math.random() * 3000);
const agent = spawn(exe, ["--no-tunnel", "--no-discover", "--listen", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, RDSH_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
agent.stdout.resume();
agent.stderr.resume();

const cfgPath = join(home, "agent.json");
let cfg = null;
for (let i = 0; i < 100 && !cfg; i++) {
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!cfg?.secret) {
  console.error("agent never wrote a usable config");
  agent.kill();
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/v1/ping`)).ok) {
      up = true;
      break;
    }
  } catch {
    /* not listening yet */
  }
  await new Promise((r) => setTimeout(r, 150));
}
if (!up) {
  console.error(`agent listener never came up on ${port}`);
  agent.kill();
  process.exit(1);
}

async function rpc(method, args = {}) {
  const path = `/v1/rpc/${method}`;
  const body = JSON.stringify(args);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString("hex");
  const sig = createHmac("sha256", cfg.secret)
    .update([method.toUpperCase(), path, String(ts), nonce, createHash("sha256").update(body).digest("hex")].join("\n"))
    .digest("base64url");
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rdsh-ts": String(ts),
      "x-rdsh-nonce": nonce,
      "x-rdsh-sig": sig,
    },
    body,
  });
  return res.json();
}

const started = await rpc("exec", { command: `echo ${text}`, timeoutMs: 15000 });
if (started?.ok !== true) {
  console.error("exec failed:", JSON.stringify(started));
  agent.kill();
  process.exit(1);
}

let acc = "";
for (let i = 0; i < 40; i++) {
  const p = await rpc("poll", { runId: started.data.runId, waitMs: 500 });
  acc += p.data?.out ?? "";
  if (p.data?.done) break;
}

console.log(`\n[agent] bytes   : ${Buffer.from(acc, "utf8").toString("hex")}`);
console.log(`[agent] text    : ${JSON.stringify(acc)}`);
console.log(`[agent] matches : ${acc.trim() === text}`);

agent.kill();
await new Promise((r) => setTimeout(r, 300));
try {
  rmSync(home, { recursive: true, force: true });
} catch {
  /* windows file locks */
}
