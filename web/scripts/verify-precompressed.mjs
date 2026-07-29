import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const outputDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pending = [outputDirectory];
let verified = 0;
let versionMarkerFound = false;

while (pending.length > 0) {
  const directory = pending.pop();
  for (const entry of fs.readdirSync(directory)) {
    const filename = path.join(directory, entry);
    if (fs.statSync(filename).isDirectory()) {
      pending.push(filename);
      continue;
    }
    if (!/\.(?:html|css|js|json)$/.test(entry)) continue;
    const compressed = `${filename}.gz`;
    if (!fs.existsSync(compressed)) {
      throw new Error(`missing precompressed representation for ${filename}`);
    }
    if (!gunzipSync(fs.readFileSync(compressed)).equals(fs.readFileSync(filename))) {
      throw new Error(`stale precompressed representation for ${filename}`);
    }
    if (entry.endsWith(".js")) {
      const source = fs.readFileSync(filename, "utf8");
      versionMarkerFound ||= source.includes("skytraceVersion") && source.includes(version);
    }
    verified += 1;
  }
}

if (verified === 0) throw new Error("no deployment assets were verified");
if (!versionMarkerFound) throw new Error(`missing Skytrace ${version} cache-busting marker`);
process.stdout.write(`verified ${verified} precompressed deployment assets\n`);
