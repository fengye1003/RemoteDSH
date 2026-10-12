// Byte-level probe: what does the agent actually return for a non-ASCII command?
//   node test/diag-unicode.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "..", "03-bin", "win-x64", "rdsh.exe");
const home = mkdtempSync(join(tmpdir(), "rdsh-uni-"));
const text = "中文测试";
const expect = Buffer.from(text, "utf8");
console.log(`expected utf8 bytes: ${expect.toString("hex")}  (${expect.length} bytes)`);

// What the shell itself produces when its stdout is a pipe.
for (const spec of [
  ["cmd /d /s /c \"echo 中文测试\"", "cmd.exe", ["/d", "/s", "/c", `echo ${text}`]],
  ["powershell -Command echo 中文测试", "powershell.exe", ["-NoProfile", "-Command", `echo ${text}`]],
  ["chcp", "chcp.com", []],
]) {
  const [label, file, args] = spec;
  const r = spawnSync(file, args, { encoding: "buffer", windowsHide: true });
  console.log(`\n[${label}] status=${r.status}`);
  console.log(`  stdout hex: ${r.stdout?.toString("hex")}`);
  console.log(`  as utf8   : ${JSON.stringify(r.stdout?.toString("utf8"))}`);
  console.log(`  as latin1 : ${JSON.stringify(r.stdout?.toString("latin1"))}`);
}

// What the agent returns over its RPC.
const agent = spawn(exe, ["--no-tunnel", "--no-discover", "--listen", "127.0.0.1", "--port", "0"], {
  env: { ...process.env, RDSH_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let out = "";
agent.stdout.on("data", (d) => (out += d.toString()));
agent.stderr.on("data", (d) => (out += d.toString()));

let cfg = null;
for (let i = 0; i < 100; i++) {
  const p = join(home, "agent.json");
  if (existsSync(p)) {
    try { cfg = JSON.parse(require("node:fs").readFileSync(p, "utf8")); } catch {}
    if (cfg?.secret) break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
const base = `http://127.0.0.1:${cfg.listen.split(":").pop()}`;

const { createHash, createHmac, randomBytes } = await import("node:crypto");
const require = (await import("node:module")).createRequire(import.meta.url);
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
    headers: { "content-type": "application/json", "x-rdsh-ts": String(ts), "x-rdsh-nonce": nonce, "x-rdsh-sig": sig },
    body,
  });
  return res.json();
}

const started = await rpc("exec", { command: `echo ${text}`, timeoutMs: 15000 });
let acc = "";
for (let i = 0; i < 40; i++) {
  const p = await rpc("poll", { runId: started.data.runId, waitMs: 500 });
  acc += p.data.out ?? "";
  if (p.data.done) break;
}
console.log(`\n[agent RPC] returned: ${JSON.stringify(acc)}`);
console.log(`  utf8 hex : ${Buffer.from(acc, "utf8").toString("hex")}`);
console.log(`  matches  : ${acc.trim() === text}`);

agent.kill();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(home, { recursive: true, force: true }); } catch {}
