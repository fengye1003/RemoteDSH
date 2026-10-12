// Pair a remote agent into a device store, then exit.
//
// Used to remove a race in cross-machine testing: the agent may be retrying on a
// long backoff, so pairing must happen BEFORE the host starts listening, and the
// store must persist between the two processes.
//
//   node test/pair-device.mjs --pair-file <path> [--store <path>]

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const pairFile = arg("pair-file");
const storeFile = arg("store") ?? join(here, "..", "data", "host-devices.json");

if (!pairFile || !existsSync(pairFile)) {
  console.error(`pair file not found: ${pairFile}`);
  process.exit(2);
}

const mod = await import(pathToFileURL(join(here, "..", "02-plugin", "index.js")).href);
const parsed = mod.parsePairString(readFileSync(pairFile, "utf8").trim());
if (parsed.error) {
  console.error(`could not parse the pairing string: ${parsed.error}`);
  process.exit(1);
}

mkdirSync(dirname(storeFile), { recursive: true });

// The plugin's own store format: write it directly so the host picks the device
// up on startup without needing a live connection.
let store = { version: 1, devices: [] };
if (existsSync(storeFile)) {
  try {
    const existing = JSON.parse(readFileSync(storeFile, "utf8"));
    if (existing?.version === 1 && Array.isArray(existing.devices)) store = existing;
  } catch {
    /* a corrupt store is replaced below */
  }
}

const device = parsed.device;
const others = store.devices.filter((d) => d?.id !== device.id);
others.push({ ...device, pairedAt: new Date().toISOString() });
store.devices = others;
writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf8");

console.log(`paired ${device.id} (${device.host ?? "?"} ${device.os ?? "?"}/${device.arch ?? "?"})`);
console.log(`store: ${storeFile}  devices: ${store.devices.length}`);
