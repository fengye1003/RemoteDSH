// Local receiver for the "send me the pairing string" helper.
//
// WHY: reading a 43-character secret off a photograph is not transcription, it is
// guessing — one wrong glyph silently produces a secret that fails every attach.
// So the target machine POSTs the file it already wrote, and the exact bytes land
// here. The request reaches us as: target machine -> nginx /drop/ -> SSH reverse tunnel
// -> this process, so the secret is never stored on the VPS.
//
//   node relay/drop-receiver.mjs [--port 18093] [--token <t>]
//
// Anything that does not carry the exact token is rejected; bodies are written to
// data/drop/ and should be deleted as soon as they are read.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const port = Number(arg("port", 18093));
const token = arg("token", process.env.DROP_TOKEN ?? "");
const outDir = arg("out", join(here, "..", "data", "drop"));
if (!token) {
  console.error("drop-receiver: a --token (or DROP_TOKEN) is required");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://drop");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (req.method !== "POST" || url.pathname !== `/${token}`) {
    // Deliberately vague: no hint about the expected path.
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    // Sized for a gzipped mysqldump of this machine's databases, not just the
    // pairing string it was originally built for.
    if (size > 16 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    // Optional ?name= lets a caller say what it is sending (e.g. dump.sql.gz.b64);
    // it is sanitised to a bare filename so nobody can write outside outDir.
    const wanted = (url.searchParams.get("name") ?? "").replace(/[^A-Za-z0-9._-]/g, "");
    const body = Buffer.concat(chunks);
    const file = join(outDir, wanted ? `${stamp}-${wanted}` : `pair-${stamp}.txt`);
    writeFileSync(file, body);
    console.log(`[drop] received ${body.length} bytes -> ${file}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`received ${body.length} bytes as ${file.split(/[\\/]/).pop()}\n`);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`drop receiver listening on 127.0.0.1:${port}, writing to ${outDir}`);
  console.log(`expects POST /<token> with the pairing string as the body`);
});
