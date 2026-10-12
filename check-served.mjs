// Quick public-URL check: status, size and sha256 of a served file.
// (node -e kept getting mangled by the shell wrapper, so this lives in a file.)
import { createHash } from "node:crypto";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: node check-served.mjs <url> [url...]");
  process.exit(1);
}

for (const url of urls) {
  let line = `${url} -> FAILED`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const body = Buffer.from(await res.arrayBuffer());
      line = `${url.split("/").pop()} -> ${res.status} ${body.length} bytes sha256=${createHash("sha256").update(body).digest("hex")}`;
      break;
    } catch (err) {
      line = `${url.split("/").pop()} -> FAILED ${err?.message ?? err}`;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  console.log(line);
}
