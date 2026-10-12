// RemoteDSH controller plugin for the DeepSeek Harness web profile.
//
// Responsibilities:
//   1. Relay seat: `/remote/attach` accepts a WebSocket from a paired target
//      machine's `rdsh` agent, authenticated by an HMAC bearer derived from that
//      device's secret. Requests flow controller -> agent -> controller over it,
//      so the target needs no inbound port at all.
//   2. Direct seat: devices that expose a reachable HTTP listener are driven
//      with the same signed-request scheme, without any relay.
//   3. A `remote` tool the model calls to pair devices and then run commands,
//      move files, or run `.mjs` on them.
//   4. A small device panel behind the existing web-auth guard.
//
// Zero runtime dependencies: only node: builtins. The WebSocket framing needed
// for the relay seat is implemented here rather than pulling in `ws`, which is
// only a transitive dependency of the harness and would not exist for someone
// who installs this plugin on its own.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "dsh-remote";
export const inject = ["webServer", "tools"];

const STATE_VERSION = 1;
const DEFAULT_ATTACH_PATH = "/remote/attach";
const DEFAULT_PANEL_PATH = "/remote/";
const DEVICE_TIMEOUT_MS = 120_000;
const MAX_WS_MESSAGE = 32 * 1024 * 1024;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// ─────────────────────────── base32 / crypto helpers ───────────────────────────

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP, matching the agent's implementation. */
function totp(secretBase32, unixSeconds, period = 30, digits = 6) {
  const counter = Math.floor(unixSeconds / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(secretBase32);
  const hash = createHmac("sha1", key).update(msg).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

function verifyTotp(secret, code, window = 1) {
  const target = String(code ?? "").trim();
  if (!target) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let step = -window; step <= window; step++) {
    const candidate = totp(secret, now + step * 30);
    if (constantTimeEqual(candidate, target)) return true;
  }
  return false;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function hmacB64Url(secret, message) {
  return createHmac("sha256", secret).update(message, "utf8").digest("base64url");
}

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function b64UrlDecode(input) {
  const t = String(input).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(t.padEnd(Math.ceil(t.length / 4) * 4, "="), "base64").toString("utf8");
}

function b64UrlEncode(input) {
  return Buffer.from(input, "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The exact canonical string both ends sign. */
function canonical(method, path, ts, nonce, bodyHash) {
  return [String(method).toUpperCase(), path, String(ts), nonce, bodyHash].join("\n");
}

function signRequest(secret, method, path, body) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString("hex");
  const bodyHash = sha256Hex(body);
  return { ts, nonce, sig: hmacB64Url(secret, canonical(method, path, ts, nonce, bodyHash)) };
}

// ─────────────────────────── pairing strings ───────────────────────────

export function parsePairString(raw) {
  const text = String(raw ?? "").trim();
  const match = text.match(/DshAgent:([A-Za-z0-9_-]+)/);
  if (!match) return { error: "no DshAgent: pairing string found in the input" };
  let payload;
  try {
    payload = JSON.parse(b64UrlDecode(match[1]));
  } catch (err) {
    return { error: `pairing string is not decodable: ${err.message}` };
  }
  if (!payload?.id || !payload?.sec) return { error: "pairing string is missing id or secret" };
  return {
    device: {
      id: String(payload.id),
      secret: String(payload.sec),
      relay: payload.url ? String(payload.url) : null,
      listen: payload.listen ? String(payload.listen) : null,
      host: payload.host ?? null,
      os: payload.os ?? null,
      arch: payload.arch ?? null,
      version: payload.ver ?? null,
    },
  };
}

// ─────────────────────────── minimal RFC 6455 server ───────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "", "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * One upgraded WebSocket connection. Frames arrive through `onMessage`; the
 * caller owns the socket lifecycle. Only the subset this protocol uses is
 * implemented: text frames, close, ping/pong, and unmasked client payloads as
 * required by RFC 6455.
 */
class WsConnection {
  constructor(socket, { onMessage, onClose, label }) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.label = label;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;

    socket.on("data", (chunk) => this.#feed(chunk));
    socket.on("close", () => this.#finish("socket closed"));
    socket.on("error", () => this.#finish("socket error"));
  }

  #finish(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.onClose?.(reason);
    } catch {
      /* the controller owns error policy */
    }
  }

  #feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.#takeFrame();
      if (!frame) return;
      this.#dispatch(frame);
    }
  }

  #takeFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_WS_MESSAGE)) {
        this.close(1009, "message too large");
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    if (masked) {
      if (buf.length < offset + 4) return null;
      offset += 4; // mask key; client frames are always masked
    }
    if (buf.length < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const key = buf.subarray(offset - 4, offset);
      const copy = Buffer.from(payload);
      for (let i = 0; i < copy.length; i++) copy[i] ^= key[i & 3];
      payload = copy;
    } else {
      payload = Buffer.from(payload);
    }

    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  #dispatch({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.onMessage?.(whole.toString("utf8"));
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (!fin) {
          this.fragments = [payload];
          this.fragmentOpcode = opcode;
          return;
        }
        this.onMessage?.(payload.toString("utf8"));
        return;
      case 0x8: // close
        this.close(1000, "");
        return;
      case 0x9: // ping
        this.#raw(encodeFrame(0xa, payload));
        return;
      case 0xa: // pong
        return;
      default:
        return;
    }
  }

  #raw(buf) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(buf);
    } catch {
      this.#finish("write failed");
    }
  }

  send(text) {
    this.#raw(encodeFrame(0x1, text));
  }

  /** Send one JSON frame; the relay protocol is line-free JSON messages. */
  sendJson(value) {
    this.send(JSON.stringify(value));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#raw(encodeFrame(0x8, payload));
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    this.#finish(`closed ${code}`);
  }
}

/** Complete the HTTP upgrade handshake. Returns false when the request is not a usable upgrade. */
function completeUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return false;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  if (head?.length) socket.unshift(head);
  socket.setNoDelay?.(true);
  return true;
}

// ─────────────────────────── device store ───────────────────────────

class DeviceStore {
  constructor(file) {
    this.file = file;
    this.devices = new Map();
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw?.version !== STATE_VERSION) return;
      for (const entry of raw.devices ?? []) {
        if (entry?.id && entry?.secret) this.devices.set(entry.id, { ...entry, online: false });
      }
    } catch {
      // A corrupt store must not stop the plugin from loading; pairing recreates it.
    }
  }

  save() {
    const payload = {
      version: STATE_VERSION,
      devices: [...this.devices.values()].map(({ online, ...rest }) => rest),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch {
      // Persisting is best effort; the device stays usable for this session.
    }
  }

  put(device) {
    const existing = this.devices.get(device.id) ?? {};
    const merged = {
      ...existing,
      ...device,
      secret: device.secret ?? existing.secret,
      pairedAt: existing.pairedAt ?? new Date().toISOString(),
    };
    this.devices.set(device.id, merged);
    this.save();
    return merged;
  }

  get(id) {
    return this.devices.get(id);
  }

  list() {
    return [...this.devices.values()];
  }

  update(id, patch) {
    const device = this.devices.get(id);
    if (!device) return null;
    Object.assign(device, patch);
    this.save();
    return device;
  }

  remove(id) {
    const existed = this.devices.delete(id);
    if (existed) this.save();
    return existed;
  }
}

// ─────────────────────────── transports ───────────────────────────

/**
 * Reverse transport: the agent dialled us and is sitting on the other end of a
 * WebSocket. Requests are correlated by id; a request that never settles is
 * reported as a timeout rather than left hanging.
 */
class RelayTransport {
  constructor(device, connection, logger) {
    this.kind = "relay";
    this.device = device;
    this.connection = connection;
    this.logger = logger;
    this.pending = new Map();
    this.counter = 0;

    connection.onMessage = (text) => this.onFrame(text);
    connection.onClose = (reason) => this.failAll(reason);
  }

  onFrame(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore malformed frames rather than tearing the link down
    }
    if (msg?.t === "hello") {
      this.hello = msg.data ?? null;
      return;
    }
    if (msg?.t === "pong") return;
    if (msg?.t !== "res" || !msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    pending.resolve(msg.data ?? { ok: false, code: "empty", error: "agent returned no payload" });
  }

  failAll(reason) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "link_down", error: `relay link closed: ${reason}` });
    }
    this.pending.clear();
  }

  call(method, args, { timeoutMs = DEVICE_TIMEOUT_MS } = {}) {
    if (this.connection.closed) {
      return Promise.resolve({ ok: false, code: "link_down", error: "relay link is closed" });
    }
    const id = `r${++this.counter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: "timeout", error: `agent did not answer ${method} within ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.connection.sendJson({ t: "req", id, method, args });
    });
  }

  close() {
    this.connection.close(1000, "controller disconnected");
  }
}

/**
 * Direct transport: the agent exposes an HTTP listener we can reach. Every call
 * is signed exactly like the relay path, so both transports share one contract.
 */
class DirectTransport {
  constructor(device, logger) {
    this.kind = "direct";
    this.device = device;
    this.logger = logger;
  }

  async call(method, args, { timeoutMs = DEVICE_TIMEOUT_MS } = {}) {
    const base = String(this.device.listen ?? "").replace(/\/+$/, "");
    if (!base) return { ok: false, code: "no_address", error: "device has no listen address" };

    const path = `/v1/rpc/${method}`;
    const body = JSON.stringify(args ?? {});
    const { ts, nonce, sig } = signRequest(this.device.secret, "POST", path, body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rdsh-ts": String(ts),
          "x-rdsh-nonce": nonce,
          "x-rdsh-sig": sig,
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 200);
        try {
          detail = JSON.parse(text).error ?? detail;
        } catch {
          /* keep the raw snippet */
        }
        return { ok: false, code: `http_${res.status}`, error: detail };
      }
      return JSON.parse(text);
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "timeout" : "unreachable",
        error: aborted ? `no answer within ${timeoutMs} ms` : `cannot reach ${base}: ${err?.message ?? err}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    /* nothing to tear down: direct calls are stateless */
  }
}

// ─────────────────────────── tool result helpers ───────────────────────────
//
// Contract of this harness (checked against @deepseek-ai/dsh-tools 0.1.5-rc.3):
// whatever execute() returns is validated against the declared `output.schema` and
// then handed to `output.render`. The older `{content:[...]}` envelope is rejected
// outright ("missing required property value.ok" / "content is not a declared
// property"), which silently made every call to this tool fail. So `ok()` returns a
// plain value and `fail()` throws -- throwing is how this harness models a tool error.

function ok(text) {
  return { text: String(text ?? "") };
}

function fail(text) {
  const error = new Error(String(text ?? ""));
  error.rdshUserFacing = true;
  throw error;
}

function renderReply(reply, { maxChars = 12000 } = {}) {
  if (!reply) return fail("no reply from device");
  if (reply.ok !== true) {
    return fail(`[${reply.code ?? "error"}] ${reply.error ?? "device reported a failure"}`);
  }
  const text = JSON.stringify(reply.data ?? {}, null, 2);
  return ok(text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated; ${text.length} chars total]` : text);
}

// ─────────────────────────── plugin ───────────────────────────

export function apply(ctx, config = {}) {
  const attachPath = config.attachPath ?? DEFAULT_ATTACH_PATH;
  const panelPath = (config.panelPath ?? DEFAULT_PANEL_PATH).replace(/\/+$/, "") || "/remote";
  // DSH_HOME when the harness sets it; otherwise the usual per-user location.
  // HOME is empty on Windows, so USERPROFILE is checked too — falling back to "."
  // would otherwise scatter a .dsh directory into the working directory.
  const dshHome =
    process.env.DSH_HOME ??
    process.env.HOME ??
    process.env.USERPROFILE ??
    ".";
  const stateFile = config.stateFile ?? join(dshHome, ".dsh", "remote", "devices.json");
  const logger = ctx.logger ?? console;

  // The relay's own access key. The web-auth plugin owns the request guard and
  // denies everything it does not recognise, so the agent-facing endpoints have
  // to be claimed before that guard runs. A guard cannot un-deny a request, so
  // this plugin registers its own guard FIRST and recognises its endpoints by
  // this key; anything else falls through to web-auth untouched.
  const relayKey = (() => {
    const fromConfig = config.relayKey ? String(config.relayKey) : "";
    if (fromConfig) return fromConfig;
    const keyFile = config.relayKeyFile ?? join(dirname(stateFile), "relay.key");
    try {
      if (existsSync(keyFile)) {
        const existing = readFileSync(keyFile, "utf8").trim();
        if (existing) return existing;
      }
    } catch {
      /* fall through to generating a new key */
    }
    const generated = randomBytes(24).toString("hex");
    try {
      mkdirSync(dirname(keyFile), { recursive: true });
      writeFileSync(keyFile, generated, "utf8");
    } catch {
      // Without persistence the key rotates on restart, which only forces agents
      // to re-read their config; the relay keeps working within this process.
    }
    return generated;
  })();

  const store = new DeviceStore(stateFile);
  /** deviceId -> live RelayTransport */
  const links = new Map();

  /** Paths this plugin answers on the shared web server. */
  // Only the liveness probe is claimed here. /remote/attach must NOT be claimed:
  // it authenticates each socket with a per-device HMAC bearer inside its own
  // handler, and demanding a relay key as well would make the key mandatory for
  // every agent (it is not distributed at pairing time).
  const ownsPath = (rawPath) => rawPath === "/remote/ping";
  const hasRelayKey = (req) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      return constantTimeEqual(url.searchParams.get("k") ?? "", relayKey);
    } catch {
      return false;
    }
  };

  // Register the guard before any other plugin's guard can deny our endpoints.
  const disposeGuard =
    typeof ctx.webServer.registerGuard === "function"
      ? ctx.webServer.registerGuard({
          name: "dsh-remote",
          check: (req, res, rawPath) => {
            if (!ownsPath(rawPath)) return true; // not ours: leave the decision to others
            if (hasRelayKey(req)) return true;
            res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
            res.end('{"ok":false,"code":"unauthorized","error":"missing relay key"}');
            return false;
          },
          checkUpgrade: (req, socket, head, rawPath) => {
            if (!ownsPath(rawPath)) return true;
            if (hasRelayKey(req)) return true;
            try {
              socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            } catch {
              /* socket already gone */
            }
            socket.destroy();
            return false;
          },
        })
      : undefined;

  if (!disposeGuard) {
    logger.warn?.(
      "dsh-remote: ctx.webServer.registerGuard is unavailable (the webserver guard patch is missing), " +
        "so the relay endpoints will be refused by another guard or answered with 401. " +
        "Re-run the webserver guard patch to restore relay access."
    );
  }

  logger.info?.(`dsh-remote: relay key active (${relayKey.slice(0, 8)}...), pass it to the agent as ?k=`);

  // ── relay seat ──────────────────────────────────────────────────────────
  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: attachPath,
    handler: (req, socket, head) => {
      const url = new URL(req.url ?? attachPath, "http://relay");
      const deviceId = url.searchParams.get("id") ?? "";
      const device = store.get(deviceId);
      logger.info?.(
        `dsh-remote: attach attempt id=${deviceId || "(none)"} known=${Boolean(device)} auth=${req.headers.authorization ? "yes" : "no"}`
      );

      const deny = (code, why, detail = "") => {
        logger.warn?.(
          `dsh-remote: refused attach for device ${deviceId || "(none)"}: ${why}` +
            (detail ? ` [${detail}]` : "")
        );
        try {
          socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
        } catch {
          /* socket already gone */
        }
        socket.destroy();
      };

      if (!device) return deny(403, "Forbidden", `id=${deviceId || "(missing)"} known=${store.list().length}`);
      const auth = String(req.headers.authorization ?? "");
      const expected = `Bearer ${hmacB64Url(device.secret, `attach:${deviceId}`)}`;
      if (!constantTimeEqual(auth, expected)) return deny(401, "Unauthorized", `sent=${auth ? auth.length + " chars" : "(no Authorization header)"} deviceHasSecret=${Boolean(device.secret)} qs=${url.search}`);
      if (!completeUpgrade(req, socket, head)) return;

      const previous = links.get(deviceId);
      if (previous) {
        // A reconnect replaces the old seat; the stale link is told to stand down.
        previous.close();
        links.delete(deviceId);
      }

      const connection = new WsConnection(socket, { label: deviceId, onMessage: null, onClose: null });
      const transport = new RelayTransport(device, connection, logger);
      links.set(deviceId, transport);
      store.update(deviceId, { online: true, lastSeenAt: new Date().toISOString() });
      logger.info?.(`dsh-remote: device ${deviceId} attached via ${attachPath}`);

      connection.onClose = (reason) => {
        transport.failAll(reason);
        if (links.get(deviceId) === transport) links.delete(deviceId);
        store.update(deviceId, { online: false, lastSeenAt: new Date().toISOString() });
        logger.info?.(`dsh-remote: device ${deviceId} detached (${reason})`);
      };
    },
  });

  // ── liveness probe used by agent-side relay discovery ───────────────────
  const disposePing = ctx.webServer.register({
    kind: "exact",
    path: "/remote/ping",
    handler: (req, res) => {
      const body = JSON.stringify({ service: "dsh-remote", ok: true, devices: store.list().length });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
    },
  });

  // ── panel ───────────────────────────────────────────────────────────────
  const disposePanel = ctx.webServer.register({
    kind: "prefix",
    path: panelPath,
    handler: (req, res) => {
      const devices = store.list().map((d) => ({
        id: d.id,
        name: d.name ?? d.host ?? d.id,
        host: d.host,
        os: d.os,
        arch: d.arch,
        version: d.version,
        relay: d.relay,
        listen: d.listen,
        online: links.has(d.id),
        lastSeenAt: d.lastSeenAt,
        pairedAt: d.pairedAt,
      }));
      const html = renderPanel(devices);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    },
  });

  // ── the model-facing tool ───────────────────────────────────────────────
  const disposers = [];
  import("@deepseek-ai/dsh-tools")
    .then(({ defineTool }) => {
      const tool = buildTool({ store, links, logger });
      disposers.push(ctx.tools.register(defineTool(tool)));
      logger.info?.(`dsh-remote: tool registered; ${store.list().length} device(s) known`);
    })
    .catch((err) => {
      logger.warn?.(`dsh-remote: could not register the remote tool: ${err?.message ?? err}`);
    });

  ctx.on?.("dispose", () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* the registry may already be gone */
      }
    }
    for (const [, transport] of links) transport.close();
    links.clear();
    disposeUpgrade();
    disposePing();
    disposePanel();
    disposeGuard?.();
  });

  logger.info?.(`dsh-remote: relay seat ${attachPath}, panel ${panelPath}/, state ${stateFile}`);
}

// ─────────────────────────── the tool ───────────────────────────

function buildTool({ store, links, logger }) {
  const findTransport = (args) => {
    const id = String(args.id ?? "").trim();
    if (!id) {
      const online = [...links.entries()];
      if (online.length === 1) return { transport: online[0][1], deviceId: online[0][0] };
      if (store.list().length === 0) {
        return { error: "no devices are paired yet — run the pair command with the string the agent printed" };
      }
      if (online.length === 0) {
        return { error: "no device is currently online — start the agent on the target, or pass id" };
      }
      return { error: `several devices are online (${online.map(([k]) => k).join(", ")}) — pass id` };
    }

    const device = store.get(id);
    if (!device) return { error: `unknown device: ${id}` };
    const relay = links.get(id);
    if (relay) return { transport: relay, deviceId: id, device };
    if (device.listen) return { transport: new DirectTransport(device, logger), deviceId: id, device };
    return { error: `device ${id} has no live relay link and no listen address; is the agent running?` };
  };

  /** Start a run and drain it until it settles or the deadline passes. */
  const runToCompletion = async (transport, method, args, { timeoutMs = 60_000, pollMs = 1500 } = {}, exec) => {
    const started = await transport.call(method, args, { timeoutMs: Math.min(timeoutMs, 30_000) });
    if (started?.ok !== true) return { reply: started };
    const runId = started.data?.runId;
    if (!runId) return { reply: { ok: false, code: "no_run_id", error: "agent did not return a runId" } };

    const deadline = Date.now() + timeoutMs;
    let out = "";
    let err = "";
    let last = null;
    while (Date.now() < deadline) {
      if (exec?.signal?.aborted) {
        await transport.call("kill", { runId }, { timeoutMs: 5000 });
        return { reply: { ok: false, code: "aborted", error: "tool call aborted; the remote run was killed" }, out, err };
      }
      const poll = await transport.call("poll", { runId, waitMs: pollMs }, { timeoutMs: pollMs + 10_000 });
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
  };

  const formatRun = ({ reply, out, err }, { maxChars = 12000 } = {}) => {
    if (reply?.ok !== true) return renderReply(reply);
    const data = reply.data ?? {};
    const parts = [];
    parts.push(`exit=${data.exitCode ?? "?"}${data.killed ? " (killed by the deadline)" : ""}${data.timedOut ? " (timed out on the target)" : ""} elapsed=${data.elapsedMs ?? "?"}ms`);
    if (out) parts.push(out.replace(/\s+$/, ""));
    if (err) parts.push(`[stderr]\n${err.replace(/\s+$/, "")}`);
    const text = parts.join("\n");
    return ok(text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]` : text);
  };

  return {
    name: "remote",
    description:
      "Operate a paired target machine through a RemoteDSH agent: run shell commands, move files, manage background jobs, or run .mjs scripts on it. " +
      "Start by calling `pair` with the pairing string the agent printed on the target machine; afterwards pass the device id (or omit it when exactly one device is online). " +
      "`exec` waits for the command to finish and returns its output; use `exec-bg` for long-running work and collect it with `jobs`.",

    parameters: {
      cmd: {
        type: "string",
        required: true,
        enum: ["pair", "devices", "info", "exec", "exec-bg", "jobs", "kill", "read", "write", "ls", "stat", "rm", "node", "disconnect", "forget"],
        description:
          "pair: register a device from a DshAgent pairing string. devices: list paired devices. info: ask a device for its identity and capabilities. " +
          "exec: run a command and wait. exec-bg: start a command in the background. jobs: list or inspect remote background jobs. kill: stop a run. " +
          "read/write/ls/stat/rm: file operations on the target. node: run a .mjs script on the target. disconnect/forget: drop the link or remove the device.",
      },
      id: {
        type: "string",
        description: "Device id. Optional when exactly one device is online or paired.",
      },
      text: {
        type: "string",
        description: "pair: the DshAgent pairing string (or text containing one). write: the text content to write.",
      },
      args: {
        type: "object",
        additionalProperties: true,
        description:
          "Command-specific arguments as a JSON object, e.g. {\"command\":\"dir\"} for exec, {\"path\":\"C:/x\"} for ls/read/stat/rm, " +
          "{\"path\":\"C:/x\",\"text\":\"...\"} for write, {\"script\":\"console.log(1)\"} for node, {\"runId\":\"...\"} for kill.",
      },
      timeoutMs: {
        type: "number",
        description: "How long to wait for the command (default 60000 ms). Use exec-bg for longer work.",
      },
      description: {
        type: "string",
        description: "Clear, concise description of what this call does in active voice, 5-10 words (shown in the UI).",
      },
    },

    output: {
      // Free-form JSON: the tool returns human-readable text, and the harness picks
      // it up through render(). Declaring a stricter object schema here is what
      // broke every call (see the note above ok()/fail()).
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },

    async execute(args, exec) {
      const cmd = String(args.cmd ?? "").trim();
      const extra = args.args && typeof args.args === "object" ? args.args : {};
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1000, args.timeoutMs) : 60_000;

      try {
        switch (cmd) {
          case "pair": {
            const parsed = parsePairString(args.text ?? extra.string ?? extra.text);
            if (parsed.error) return fail(parsed.error);
            const device = parsed.device;
            if (!verifyTotp(device.secret, extra.totp ?? extra.code)) {
              // Not fatal: the agent also proves the secret on its own attach handshake,
              // so a mismatched wall clock must not block pairing.
              logger.warn?.(`dsh-remote: TOTP check did not match for ${device.id} (clock skew or wrong secret); relying on the attach handshake`);
            }
            const stored = store.put(device);
            const lines = [
              `paired device ${stored.id}`,
              `  host    : ${stored.host ?? "(unknown)"}  os=${stored.os ?? "?"} arch=${stored.arch ?? "?"} agent=${stored.version ?? "?"}`,
              `  relay   : ${stored.relay ?? "(none — direct mode only)"}`,
              `  listen  : ${stored.listen ?? "(none)"}`,
              "",
              "If the target agent is running, it is now dialing in; run `devices` to confirm, then `exec`.",
            ];
            return ok(lines.join("\n"));
          }

          case "devices": {
            const all = store.list();
            if (all.length === 0) return ok("No devices paired yet. Run `pair` with the string printed by the agent on the target machine.");
            const lines = all.map((d) => {
              const live = links.has(d.id);
              return `- ${d.id}  ${live ? "ONLINE " : "offline"}  ${d.host ?? "?"} (${d.os ?? "?"}/${d.arch ?? "?"})  ${live ? `via relay ${d.relay ?? "?"}` : d.listen ? `direct ${d.listen}` : "no address"}`;
            });
            return ok(lines.join("\n"));
          }

          case "forget": {
            const id = String(args.id ?? "");
            if (!store.remove(id)) return fail(`unknown device: ${id}`);
            links.get(id)?.close();
            links.delete(id);
            return ok(`forgot device ${id}`);
          }

          case "info": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const reply = await found.transport.call("hello", {}, { timeoutMs: 15_000 });
            return renderReply(reply);
          }

          case "exec":
          case "exec-bg": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const command = String(extra.command ?? extra.cmd ?? "").trim();
            if (!command) return fail("args.command is required");
            const payload = {
              command,
              ...(extra.workdir ? { workdir: String(extra.workdir) } : {}),
              ...(extra.shell ? { shell: String(extra.shell) } : {}),
              ...(extra.label ? { label: String(extra.label) } : {}),
            };
            if (cmd === "exec-bg") {
              const reply = await found.transport.call("exec", { ...payload, detached: true, timeoutMs: 0 }, { timeoutMs: 20_000 });
              return renderReply(reply);
            }
            const outcome = await runToCompletion(
              found.transport,
              "exec",
              { ...payload, timeoutMs },
              { timeoutMs, pollMs: 1200 },
              exec
            );
            return formatRun(outcome);
          }

          case "jobs": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const runId = extra.runId ? String(extra.runId) : null;
            if (!runId) {
              const reply = await found.transport.call("jobs", {}, { timeoutMs: 15_000 });
              return renderReply(reply);
            }
            const reply = await found.transport.call("poll", { runId, waitMs: Number(extra.waitMs) || 0 }, { timeoutMs: 30_000 });
            const outcome = { reply, out: reply?.data?.out ?? "", err: reply?.data?.err ?? "" };
            return formatRun(outcome);
          }

          case "kill": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const runId = String(extra.runId ?? "").trim();
            if (!runId) return fail("args.runId is required");
            return renderReply(await found.transport.call("kill", { runId }, { timeoutMs: 15_000 }));
          }

          case "read": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const path = String(extra.path ?? "").trim();
            if (!path) return fail("args.path is required");
            const reply = await found.transport.call("read", {
              path,
              offset: Number(extra.offset) || 0,
              maxBytes: Number(extra.maxBytes) || 4 * 1024 * 1024,
              base64: Boolean(extra.base64),
            }, { timeoutMs: 60_000 });
            if (reply?.ok !== true) return renderReply(reply);
            return renderReply({ ok: true, data: { ...reply.data, base64: reply.data?.base64 ? `[${reply.data.base64.length} base64 chars]` : undefined } });
          }

          case "write": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const path = String(extra.path ?? "").trim();
            if (!path) return fail("args.path is required");
            const content = extra.base64 ?? extra.text ?? args.text;
            if (content === undefined || content === null) return fail("provide args.text or args.base64");
            const payload = extra.base64
              ? { path, base64: String(extra.base64), append: Boolean(extra.append) }
              : { path, text: String(content), append: Boolean(extra.append) };
            return renderReply(await found.transport.call("write", payload, { timeoutMs: 120_000 }));
          }

          case "ls":
          case "stat":
          case "rm": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const path = String(extra.path ?? "").trim();
            if (!path) return fail("args.path is required");
            const payload = cmd === "rm"
              ? { path, recursive: Boolean(extra.recursive), hard: Boolean(extra.hard) }
              : { path };
            return renderReply(await found.transport.call(cmd, payload, { timeoutMs: 60_000 }));
          }

          case "node": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const script = extra.script ? String(extra.script) : null;
            const scriptPath = extra.path ? String(extra.path) : null;
            if (!script && !scriptPath) return fail("provide args.script (inline) or args.path (a .mjs already on the target)");
            const outcome = await runToCompletion(
              found.transport,
              "node",
              {
                ...(script ? { script } : {}),
                ...(scriptPath ? { path: scriptPath } : {}),
                ...(extra.cwd ? { cwd: String(extra.cwd) } : {}),
                ...(Array.isArray(extra.args) ? { args: extra.args } : {}),
              },
              { timeoutMs, pollMs: 1200 },
              exec
            );
            return formatRun(outcome);
          }

          case "disconnect": {
            const found = findTransport(args);
            if (found.error) return fail(found.error);
            const reply = await found.transport.call("disconnect", {}, { timeoutMs: 10_000 });
            found.transport.close?.();
            return renderReply(reply);
          }

          default:
            return fail(`unknown cmd: ${cmd || "(empty)"}`);
        }
      } catch (err) {
        // fail() throws on purpose; do not wrap a message that is already the answer.
        if (err?.rdshUserFacing) throw err;
        return fail(`remote ${cmd} failed: ${err?.message ?? err}`);
      }
    },

    presentCall: (args) => {
      const label = [args.cmd, args.id].filter(Boolean).join(" ");
      const detail = args.args?.command ?? args.args?.path ?? args.description ?? "";
      return {
        card: "terminal",
        title: label || "remote",
        description: String(detail || "").slice(0, 200),
      };
    },

    presentResult: (_args, result) => {
      const text = typeof result?.text === "string" ? result.text : "";
      if (!text) return undefined;
      return { card: "generic", content: [{ type: "text", text: `\`\`\`\n${text.replace(/\n+$/, "")}\n\`\`\`` }] };
    },
  };
}

// ─────────────────────────── panel markup ───────────────────────────

function renderPanel(devices) {
  const rows = devices.length
    ? devices
        .map(
          (d) => `<tr>
      <td><code>${escapeHtml(d.id)}</code></td>
      <td>${escapeHtml(d.name ?? "")}</td>
      <td class="${d.online ? "on" : "off"}">${d.online ? "online" : "offline"}</td>
      <td>${escapeHtml(d.host ?? "")} ${escapeHtml(d.os ?? "")} ${escapeHtml(d.arch ?? "")}</td>
      <td><code>${escapeHtml(d.listen ?? d.relay ?? "")}</code></td>
      <td>${escapeHtml(d.lastSeenAt ?? "")}</td>
    </tr>`
        )
        .join("\n")
    : `<tr><td colspan="6" class="empty">No devices paired yet. Start the agent on a target machine and give its pairing string to the assistant.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RemoteDSH</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #14161a; color: #e6e8eb;
         font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  p.sub { margin: 0 0 24px; color: #9aa3ad; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #232830;
           border: 1px solid #333a44; color: #cfd6de; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #262c34; }
  th { color: #9aa3ad; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.on { color: #4ade80; } td.off { color: #8b949e; } td.empty { color: #8b949e; text-align: center; padding: 28px; }
  code { background: #1d2128; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
</style>
</head>
<body>
  <h1>RemoteDSH</h1>
  <p class="sub">Target machines running the RemoteDSH agent. <span class="badge">remote DSH link</span></p>
  <table>
    <thead><tr><th>Device</th><th>Name</th><th>State</th><th>Host</th><th>Address</th><th>Last seen</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Exported for tests.
export const __internals = { totp, verifyTotp, signRequest, canonical, WsConnection, encodeFrame, acceptKey, DeviceStore, RelayTransport, DirectTransport, b64UrlEncode };
