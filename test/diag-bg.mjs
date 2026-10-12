// Focused diagnosis of the detached/background job path.
import { spawn } from 'node:child_process';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, '..', '03-bin', 'win-x64', 'rdsh.exe');
const home = mkdtempSync(join(tmpdir(), 'rdsh-bg-'));
const port = 26000 + Math.floor(Math.random() * 1000);
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
  return { status: res.status, json: await res.json() };
}

const command = 'ping -n 8 127.0.0.1 > nul & echo bg-done';
console.log('command   :', JSON.stringify(command));

const started = await rpc('exec', { command, detached: true, label: 'bgtest' });
console.log('exec reply:', JSON.stringify(started.json));
const runId = started.json?.data?.runId;

for (let i = 0; i < 12; i++) {
  await sleep(1000);
  const p = await rpc('poll', { runId, waitMs: 0 });
  const j = await rpc('jobs');
  const me = j.json?.data?.jobs?.find((x) => x.id === runId);
  console.log(`t+${i + 1}s poll done=${p.json?.data?.done} exit=${p.json?.data?.exitCode} out=${JSON.stringify(p.json?.data?.out)} | job running=${me?.running} exit=${me?.exitCode} outBytes=${me?.outBytes}`);
  if (me && me.running === false) { console.log('job settled'); break; }
}

// Control: run the same command in the foreground to separate shell semantics from job lifecycle.
const fg = await rpc('exec', { command, timeoutMs: 20000 });
let out = '';
for (let i = 0; i < 40; i++) {
  const p = await rpc('poll', { runId: fg.json?.data?.runId, waitMs: 500 });
  out += p.json?.data?.out ?? '';
  if (p.json?.data?.done) { console.log('foreground control exit=' + p.json.data.exitCode + ' out=' + JSON.stringify(out)); break; }
}

child.kill();
await sleep(300);
try { rmSync(home, { recursive: true, force: true }); } catch {}
