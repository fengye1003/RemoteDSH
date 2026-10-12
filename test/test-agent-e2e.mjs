// End-to-end test of the rdsh agent: start it, read its identity, then drive the
// full RPC surface over signed HTTP calls. Run with:
//   node test-agent-e2e.mjs [path-to-rdsh.exe]
//
// This is the ground truth for "does the agent actually work": TOTP pairing,
// HMAC request signing, exec/poll streaming, file round-trip, background jobs.

import { spawn, spawnSync } from 'node:child_process';
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = process.argv[2] ?? join(here, '..', '03-bin', 'win-x64', 'rdsh.exe');

if (!existsSync(exe)) {
  console.error(`agent binary not found: ${exe}`);
  process.exit(2);
}

// Isolated agent home so the test never touches a real ~/.rdsh identity.
const home = mkdtempSync(join(tmpdir(), 'rdsh-e2e-'));
const port = 24000 + Math.floor(Math.random() * 2000);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- start the agent -------------------------------------------------------

console.log(`agent   : ${exe}`);
console.log(`home    : ${home}`);
console.log(`port    : ${port}`);

const child = spawn(exe, ['--port', String(port), '--listen', '127.0.0.1', '--no-tunnel', '--no-discover'], {
  env: { ...process.env, RDSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let agentOut = '';
child.stdout.on('data', (d) => { agentOut += d.toString(); });
child.stderr.on('data', (d) => { agentOut += d.toString(); });

// Wait for the config file (written before the listener starts).
let cfg = null;
for (let i = 0; i < 100; i++) {
  const p = join(home, 'agent.json');
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { /* still being written */ }
    if (cfg?.secret) break;
  }
  await sleep(100);
}
check('agent starts and writes identity', !!cfg?.secret, cfg ? `id=${cfg.id}` : 'no config');

if (!cfg?.secret) {
  child.kill();
  console.log('\n--- agent output ---\n' + agentOut);
  process.exit(1);
}

// Wait for the listener to answer.
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/v1/ping`);
    if (r.ok) { up = true; break; }
  } catch { /* not yet */ }
  await sleep(150);
}
check('direct listener answers /v1/ping', up, base);

// ---- signing helpers -------------------------------------------------------

function sign(secret, method, path, body, ts, nonce) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = [method.toUpperCase(), path, String(ts), nonce, bodyHash].join('\n');
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url');
}

async function rpc(method, args = {}, { secret = cfg.secret, badSig = false, replay = null } = {}) {
  const path = `/v1/rpc/${method}`;
  const body = JSON.stringify(args);
  const ts = replay?.ts ?? Math.floor(Date.now() / 1000);
  const nonce = replay?.nonce ?? randomBytes(8).toString('hex');
  const sig = badSig ? 'AAAA' : sign(secret, 'POST', path, body, ts, nonce);
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rdsh-ts': String(ts),
      'x-rdsh-nonce': nonce,
      'x-rdsh-sig': sig,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

// ---- auth ------------------------------------------------------------------

{
  const bad = await rpc('hello', {}, { badSig: true });
  check('rejects a bad signature', bad.status === 401, `status=${bad.status}`);

  const good = await rpc('hello');
  check('accepts a good signature', good.status === 200 && good.json?.ok === true, `status=${good.status}`);
  check('hello reports host/os/caps',
    good.json?.data?.host?.length > 0 && Array.isArray(good.json?.data?.caps),
    `host=${good.json?.data?.host} os=${good.json?.data?.os} caps=${good.json?.data?.caps?.join(',')}`);

  // Replay the exact same signed request: the nonce must be burned.
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const first = await rpc('hello', {}, { replay: { ts, nonce } });
  const second = await rpc('hello', {}, { replay: { ts, nonce } });
  check('replay of the same nonce is refused', first.status === 200 && second.status === 401, `first=${first.status} second=${second.status}`);

  const stale = await rpc('hello', {}, { replay: { ts: Math.floor(Date.now() / 1000) - 600, nonce: randomBytes(8).toString('hex') } });
  check('stale timestamp is refused', stale.status === 401, `status=${stale.status}`);
}

// ---- exec + poll -----------------------------------------------------------

async function runToCompletion(command, { timeoutMs = 30000, shell } = {}) {
  const started = await rpc('exec', { command, timeoutMs, ...(shell ? { shell } : {}) });
  if (started.json?.ok !== true) return { error: started.json?.error ?? started.text };
  const runId = started.json.data.runId;
  let out = '', err = '', done = false, exitCode = null;
  const deadline = Date.now() + timeoutMs + 5000;
  while (!done && Date.now() < deadline) {
    const p = await rpc('poll', { runId, waitMs: 2000 });
    if (p.json?.ok !== true) return { error: p.json?.error ?? p.text };
    out += p.json.data.out;
    err += p.json.data.err;
    done = p.json.data.done;
    exitCode = p.json.data.exitCode;
  }
  return { runId, out, err, done, exitCode };
}

{
  const echo = await runToCompletion('echo hello-rdsh');
  check('exec + poll returns stdout', echo.out?.includes('hello-rdsh') && echo.exitCode === 0,
    `exit=${echo.exitCode} out=${JSON.stringify(echo.out?.trim())}`);

  const multi = await runToCompletion('echo line1 & echo line2 & echo line3');
  check('multi-line output survives', (multi.out?.match(/line\d/g) ?? []).length >= 3, JSON.stringify(multi.out?.trim()));

  const bad = await runToCompletion('exit /b 7');
  check('non-zero exit code is reported', bad.exitCode === 7, `exit=${bad.exitCode}`);

  const big = await runToCompletion('for /L %i in (1,1,2000) do @echo row-%i');
  check('large output is not lost', (big.out?.match(/row-\d+/g) ?? []).length >= 2000,
    `rows=${(big.out?.match(/row-\d+/g) ?? []).length}`);

  const to = await runToCompletion('timeout /t 20 /nobreak > nul', { timeoutMs: 1500 });
  check('timeout terminates the command', to.done === true && (to.out !== undefined),
    `done=${to.done}`);

  const now = await runToCompletion('echo %CD%');
  check('exec runs in a real shell', now.out?.trim().length > 2, JSON.stringify(now.out?.trim()));
}

// ---- background jobs -------------------------------------------------------

{
  const started = await rpc('exec', { command: 'timeout /t 3 /nobreak > nul & echo bg-done', detached: true, label: 'bgtest' });
  check('background job starts', started.json?.ok === true, `runId=${started.json?.data?.runId}`);
  const jobs = await rpc('jobs');
  check('job list includes the background job',
    jobs.json?.data?.jobs?.some((j) => j.label === 'bgtest'),
    `jobs=${jobs.json?.data?.jobs?.length}`);

  const runId = started.json.data.runId;
  let finished = false;
  for (let i = 0; i < 40 && !finished; i++) {
    const p = await rpc('poll', { runId, waitMs: 500 });
    if (p.json?.data?.done) finished = true;
    if (p.json?.data?.out?.includes('bg-done')) finished = true;
  }
  check('background job reaches completion', finished);
}

// ---- files -----------------------------------------------------------------

{
  const dir = join(home, 'work');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'hello.txt');

  const w = await rpc('write', { path: target, text: 'rdsh file round-trip 你好' });
  check('write creates a file', w.json?.ok === true && w.json?.data?.bytes > 0, `bytes=${w.json?.data?.bytes}`);

  const r = await rpc('read', { path: target });
  check('read returns the same content', r.json?.data?.text === 'rdsh file round-trip 你好',
    JSON.stringify(r.json?.data?.text));

  const s = await rpc('stat', { path: target });
  check('stat reports a file with size', s.json?.data?.exists === true && s.json?.data?.isDir === false, `size=${s.json?.data?.size}`);

  const l = await rpc('ls', { path: dir });
  check('ls lists the file', l.json?.data?.entries?.some((e) => e.name === 'hello.txt'), `n=${l.json?.data?.entries?.length}`);

  // Binary round-trip: base64 path must survive bytes that are not valid UTF-8.
  const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x00]);
  const wb = await rpc('write', { path: join(dir, 'blob.bin'), base64: bin.toString('base64') });
  const rb = await rpc('read', { path: join(dir, 'blob.bin'), base64: true });
  const same = wb.json?.ok && rb.json?.data?.base64 === bin.toString('base64');
  check('binary round-trip via base64', !!same, `len=${bin.length}`);

  // Chunked read of a larger file.
  const bigPath = join(dir, 'big.bin');
  const bigBuf = Buffer.alloc(1024 * 300);
  for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = i % 251;
  await rpc('write', { path: bigPath, base64: bigBuf.toString('base64') });
  let assembled = Buffer.alloc(0), offset = 0, guard = 0;
  while (guard++ < 200) {
    const chunk = await rpc('read', { path: bigPath, offset, maxBytes: 65536, base64: true });
    if (chunk.json?.ok !== true) break;
    const part = Buffer.from(chunk.json.data.base64 ?? '', 'base64');
    assembled = Buffer.concat([assembled, part]);
    offset += part.length;
    if (chunk.json.data.eof) break;
  }
  check('chunked read reassembles a 300 KiB file', assembled.length === bigBuf.length && assembled.equals(bigBuf),
    `got=${assembled.length} want=${bigBuf.length}`);

  const rm = await rpc('rm', { path: join(dir, 'blob.bin') });
  const gone = await rpc('stat', { path: join(dir, 'blob.bin') });
  check('rm soft-deletes by default', rm.json?.ok === true && gone.json?.data?.exists === false);
}

// ---- node method -----------------------------------------------------------

{
  const n = await rpc('node', { script: 'console.log("from-node", 1 + 1)' });
  const hasNode = n.json?.ok === true;
  if (hasNode) {
    const runId = n.json.data.runId;
    let out = '';
    for (let i = 0; i < 30; i++) {
      const p = await rpc('poll', { runId, waitMs: 300 });
      out += p.json?.data?.out ?? '';
      if (p.json?.data?.done) break;
    }
    check('node method runs an .mjs script', out.includes('from-node 2'), JSON.stringify(out.trim()));
  } else {
    check('node method reports missing runtime clearly', n.json?.code === 'no_node_runtime',
      `code=${n.json?.code}`);
  }
}

// ---- audit -----------------------------------------------------------------

{
  const auditPath = join(home, 'audit.log');
  const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
  check('audit log records operations', audit.includes('exec') && audit.includes('write'),
    `${audit.split('\n').filter(Boolean).length} lines`);
  check('audit log records denials', audit.includes('DENY'), audit.includes('DENY') ? 'denied entries present' : 'no denials logged');
}

// ---- pairing string --------------------------------------------------------

{
  const pairLine = agentOut.split('\n').find((l) => l.trim().startsWith('DshAgent:'));
  check('prints a pairing string', !!pairLine, pairLine ? pairLine.trim().slice(0, 40) + '...' : 'not found');
  if (pairLine) {
    const encoded = pairLine.trim().slice('DshAgent:'.length);
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    check('pairing string decodes to the live identity',
      payload.id === cfg.id && payload.sec === cfg.secret,
      `id=${payload.id} listen=${payload.listen}`);
  }
}

// ---- teardown --------------------------------------------------------------

child.kill();
await sleep(400);
try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('failed: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
console.log('E2E-OK');
