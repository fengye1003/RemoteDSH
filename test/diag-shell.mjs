// Narrow down which shell constructs the agent's exec path handles, and where it hangs.
import { spawn } from 'node:child_process';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, '..', '03-bin', 'win-x64', 'rdsh.exe');
const home = mkdtempSync(join(tmpdir(), 'rdsh-shell-'));
const port = 27000 + Math.floor(Math.random() * 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, ['--port', String(port), '--no-tunnel', '--no-discover'], {
  env: { ...process.env, RDSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let cfg = null;
for (let i = 0; i < 100; i++) {
  const p = join(home, 'agent.json');
  if (existsSync(p)) { try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch {} if (cfg?.secret) break; }
  await sleep(100);
}
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/v1/ping`)).ok) break; } catch {} await sleep(150); }

function sign(secret, method, path, body, ts, nonce) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return createHmac('sha256', secret).update([method, path, String(ts), nonce, bodyHash].join('\n'), 'utf8').digest('base64url');
}
async function rpc(method, args = {}) {
  const path = `/v1/rpc/${method}`;
  const body = JSON.stringify(args);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rdsh-ts': String(ts), 'x-rdsh-nonce': nonce, 'x-rdsh-sig': sign(cfg.secret, 'POST', path, body, ts, nonce) },
    body,
  });
  return await res.json();
}

const cases = [
  ['plain echo', 'echo A'],
  ['ampersand chain', 'echo A & echo B'],
  ['redirect to nul', 'echo A > nul & echo B'],
  ['ping short', 'ping -n 2 127.0.0.1'],
  ['ping then echo', 'ping -n 2 127.0.0.1 > nul & echo B'],
  ['exit code', 'exit /b 3'],
];

for (const [name, command] of cases) {
  const started = await rpc('exec', { command, timeoutMs: 8000 });
  const runId = started?.data?.runId;
  if (!runId) { console.log(`${name.padEnd(18)} -> exec failed: ${JSON.stringify(started)}`); continue; }
  let out = '', err = '', done = false, exit = null;
  const deadline = Date.now() + 12000;
  while (!done && Date.now() < deadline) {
    const p = await rpc('poll', { runId, waitMs: 400 });
    out += p?.data?.out ?? '';
    err += p?.data?.err ?? '';
    done = p?.data?.done;
    exit = p?.data?.exitCode;
  }
  console.log(`${name.padEnd(18)} -> done=${done} exit=${exit} out=${JSON.stringify(out)}${err ? ' err=' + JSON.stringify(err) : ''}`);
}

child.kill();
await sleep(300);
try { rmSync(home, { recursive: true, force: true }); } catch {}
