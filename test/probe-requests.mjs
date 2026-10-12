// Request-capture probe: logs EVERY http request and websocket upgrade it sees,
// including the raw target and headers. Used to find out whether a remote agent's
// attach request actually arrives through the tunnel, and with what shape.
//
//   node test/probe-requests.mjs --port 18088 --log <file>

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";

const argOf = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const port = Number(argOf("port", 18088));
const logFile = argOf("log");

const line = (text) => {
  const stamped = `${new Date().toISOString()} ${text}`;
  console.log(stamped);
  if (logFile) appendFileSync(logFile, stamped + "\n", "utf8");
};

if (logFile) writeFileSync(logFile, "", "utf8");

const server = createServer((req, res) => {
  line(`HTTP    ${req.method} ${req.url} host=${req.headers.host ?? "-"} auth=${req.headers.authorization ? "yes" : "no"}`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("probe ok\n");
});

server.on("upgrade", (req, socket) => {
  line(`UPGRADE ${req.url}`);
  line(`  headers: ${JSON.stringify(req.headers)}`);
  const key = req.headers["sec-websocket-key"] ?? "";
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.on("data", (d) => line(`  frame ${d.length}B: ${d.subarray(0, 48).toString("hex")}`));
  socket.on("close", () => line("  socket closed"));
});

server.listen(port, "127.0.0.1", () => line(`probe listening on 127.0.0.1:${port}`));
