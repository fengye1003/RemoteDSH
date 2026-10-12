// Minimal RemoteDSH attach client: speaks the same handshake the .NET agent does,
// so the relay path can be exercised without a tunnel or a second machine.
//
//   node test/attach-client.mjs --url http://127.0.0.1:18088 --store <devices.json>

import { createHash, createHmac } from "node:crypto";
import { connect } from "node:net";
import { readFileSync, existsSync } from "node:fs";

const argOf = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

const base = (argOf("url", "http://127.0.0.1:18088")).replace(/\/+$/, "");
const storeFile = argOf("store");
const wsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const store = JSON.parse(readFileSync(storeFile, "utf8"));
const device = store.devices[0];
if (!device) {
  console.error("no device in the store; pair one first");
  process.exit(2);
}

const u = new URL(base);
const host = u.hostname;
const port = Number(u.port || 80);
// No relay key: the guard treats /remote/attach as owned and lets it through; the per-device
const bearer = createHmac("sha256", device.secret).update(`attach:${device.id}`, "utf8").digest("base64url");

const path = `/remote/attach?id=${device.id}`;
const key = Buffer.from("0123456789abcdef").toString("base64");
const socket = connect(port, host, () => {
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      `Authorization: Bearer ${bearer}\r\n` +
      `X-RDSH-Agent: rdsh/0.1.0-testclient\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
  );
});

let handshake = "";
let upgraded = false;

socket.on("data", (buf) => {
  if (!upgraded) {
    handshake += buf.toString("latin1");
    const end = handshake.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = handshake.slice(0, end);
    const rest = buf.subarray(Buffer.byteLength(handshake.slice(0, end + 4), "latin1"));
    console.log("handshake:", head.split("\r\n")[0]);
    const expectedAccept = createHash("sha1").update(key + wsGuid).digest("base64");
    const gotAccept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
    console.log(`accept ok: ${gotAccept === expectedAccept}`);
    if (!/^HTTP\/1\.1 101/.test(head)) {
      console.log("ATTACH-REJECTED");
      socket.destroy();
      process.exit(1);
    }
    upgraded = true;
    console.log("ATTACH-ACCEPTED");
    // Announce ourselves like the agent does, then ask it to run something.
    send(JSON.stringify({ t: "hello", data: { id: device.id, host: "testclient", os: "node", arch: "x64", ver: "test" } }));
    send(JSON.stringify({ t: "req", id: "r1", method: "hello", args: {} }));
    if (rest.length) handleFrames(rest);
    return;
  }
  handleFrames(buf);
});

socket.on("error", (err) => {
  console.error("socket error:", err.message);
  process.exit(3);
});
socket.on("close", () => {
  console.log("socket closed");
});

// ---- frame handling (text frames only, which is all this protocol uses) ----

function send(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

let buffer = Buffer.alloc(0);
function handleFrames(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < 2) return;
    const opcode = buffer[0] & 0x0f;
    let len = buffer[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buffer.length < 4) return;
      len = buffer.readUInt16BE(2);
      offset = 4;
    }
    if (buffer.length < offset + len) return;
    const payload = buffer.subarray(offset, offset + len);
    buffer = buffer.subarray(offset + len);

    if (opcode === 0x1) {
      const text = payload.toString("utf8");
      let msg = null;
      try { msg = JSON.parse(text); } catch { /* raw */ }
      const shown = msg ? JSON.stringify(msg.data ?? {}).slice(0, 200) : text.slice(0, 120);
      console.log(`frame <- t=${msg?.t ?? "?"} ${msg?.id ?? ""} ${shown}`);
      if (msg?.t === "res" && msg.id === "r1") {
        const ok = msg.data?.ok === true && !!msg.data?.data?.host;
        console.log(ok ? "ROUND-TRIP-OK" : "ROUND-TRIP-FAILED");
        socket.destroy();
        process.exit(ok ? 0 : 1);
      }
    } else if (opcode === 0x8) {
      console.log("server closed the socket");
      socket.destroy();
      process.exit(1);
    }
  }
}

setTimeout(() => {
  console.log("TIMEOUT waiting for a reply");
  process.exit(4);
}, 15000);
