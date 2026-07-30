// Third-party licence notices for the browser artifact.
//
// MIT, BSD and ISC all make retaining the copyright notice a CONDITION of redistribution, and Vite's
// minifier strips every legal comment out of the bundle (`/*! */` count in dist: zero). So the notice
// has to be reassembled from the dependency tree and shipped alongside — which is what this writes.
//
// Nothing here lands in git: the output goes into web/dist, which is gitignored. The distributed
// artifact carries the notice; the source repo does not need a copy.
//
// Browser npm dependencies are collected while building web/dist. Linked Go module notices are
// generated separately by scripts/go-notices and merged during the Docker build.
//
//   node scripts/notices.mjs --packages web --scope web --out web/dist/third-party-notices.json
//
// `npm ls` is deliberately not used; the production closure is walked directly.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;
// A licence text far larger than any real one means we picked up a bundled corpus, not a licence.
const MAX_TEXT_BYTES = 64 * 1024;

// `--scope` attaches to the preceding `--packages` root instead of inferring artifact identity
// from the current working directory.
function parseArgs(argv) {
  const roots = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--packages") roots.push({ root: argv[i + 1], scope: null });
    if (argv[i] === "--scope") {
      if (!roots.length) throw new Error("--scope must follow a --packages");
      roots.at(-1).scope = argv[i + 1];
    }
    if (argv[i] === "--out") out = argv[i + 1];
  }
  if (!roots.length || !out || roots.some((entry) => !entry.root || !entry.scope)) {
    throw new Error("usage: notices.mjs --packages <dir> --scope <name> [...] --out <file>");
  }
  return { roots, out };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Node's own resolution order: the nearest node_modules wins, then each parent's. npm installs flat,
// so the first hit is almost always the top-level one — but a version-conflicted nested copy is a
// separate package with its own licence, and this finds that too.
function resolvePackageDir(name, fromDir, stopDir) {
  let dir = path.resolve(fromDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function licenseId(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  // Pre-SPDX manifests used `license: {type}` or a `licenses: []` array.
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const ids = manifest.licenses.map((entry) => entry?.type || entry).filter(Boolean);
    if (ids.length) return ids.join(" OR ");
  }
  return null;
}

// Some packages ship no licence file and put the full text in a README section instead
// (murmurhash-js is one). MIT requires the notice itself, not just the SPDX id, so that section is a
// real licence and has to be picked up: from its heading to the next heading of the same or higher
// level, which is where such a section always ends.
function readmeLicenseText(dir, entries) {
  const readme = entries.find((entry) => entry.isFile() && /^readme(?:\..*)?$/i.test(entry.name));
  if (!readme) return null;
  let text;
  try {
    text = readFileSync(path.join(dir, readme.name), "utf8");
  } catch {
    return null;
  }
  const heading = text.match(/^(#{1,6})\s*licen[cs]e.*$/im);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const rest = text.slice(start);
  const next = rest.match(new RegExp(`^#{1,${heading[1].length}}\\s`, "m"));
  const section = (next ? rest.slice(0, next.index) : rest).trim();
  return section.length > 0 ? section : null;
}

function licenseText(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    // A plain LICENSE outranks LICENSE-MIT / NOTICE when a package carries several.
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  for (const file of files) {
    try {
      const text = readFileSync(path.join(dir, file.name), "utf8");
      if (text.trim() && Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text.trim();
    } catch { /* unreadable: fall through to the next candidate */ }
  }
  return readmeLicenseText(dir, entries);
}

// The production dependency closure, which is what actually ships. devDependencies are excluded at
// the root because they never reach the artifact; transitively, `dependencies` is all npm installs.
function collect(rootDir, scope) {
  const root = path.resolve(rootDir);
  const manifest = readJson(path.join(root, "package.json"));
  if (!manifest) throw new Error(`no package.json in ${root}`);

  const found = new Map();
  const queue = Object.keys(manifest.dependencies || {}).map((name) => ({ name, from: root }));
  const visited = new Set();

  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = resolvePackageDir(name, from, root);
    if (!dir || visited.has(dir)) continue;
    visited.add(dir);

    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg) continue;

    found.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version ?? null,
      license: licenseId(pkg),
      // Some packages ship no licence file at all; the SPDX id plus the manifest is then the whole
      // notice available, and saying so beats an empty panel that looks like a bug.
      text: licenseText(dir),
      homepage: pkg.homepage || pkg.repository?.url || null,
      scopes: [scope],
    });

    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({ name: dep, from: dir });
  }
  return found;
}

function merge(existing, incoming) {
  const packages = new Map();
  for (const entry of existing?.packages || []) packages.set(`${entry.name}@${entry.version}`, entry);
  for (const [key, entry] of incoming) {
    const prior = packages.get(key);
    if (!prior) {
      packages.set(key, entry);
      continue;
    }
    prior.scopes = [...new Set([...(prior.scopes || []), ...entry.scopes])].sort();
    // A stage that could read the licence file wins over one that only saw the manifest.
    if (!prior.text && entry.text) prior.text = entry.text;
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)
    || String(a.version).localeCompare(String(b.version)));
}

/**
 * The merged notices for one or more package roots. Exported so the Vite dev server can serve the
 * same data it would ship, instead of the licence panel 404ing outside a production build.
 *
 * @param {{ root: string, scope: string }[]} roots the tree, and which artifact it ships in
 * @param {{ packages?: object[] }} [seed]
 * @returns {object[]}
 */
export function collectNotices(roots, seed = null) {
  let packages = seed?.packages || [];
  for (const { root, scope } of roots) packages = merge({ packages }, collect(root, scope));
  return packages;
}

function main() {
  const { roots, out } = parseArgs(process.argv.slice(2));
  const outFile = path.resolve(out);
  const existing = existsSync(outFile) ? readJson(outFile) : null;
  const packages = collectNotices(roots, existing);

  mkdirSync(path.dirname(outFile), { recursive: true });
  const json = `${JSON.stringify({ packages }, null, 0)}\n`;
  writeFileSync(outFile, json);
  // Every deployment asset ships with a precompressed twin (verify-precompressed.mjs enforces it),
  // and this file is written after Vite's own gzip pass — so it compresses its own output. It is
  // largely repeated licence text, which gzip takes down by better than 8x.
  writeFileSync(`${outFile}.gz`, gzipSync(Buffer.from(json), { level: 9 }));

  const missing = packages.filter((entry) => !entry.text).map((entry) => entry.name);
  process.stdout.write(`notices: ${packages.length} packages -> ${path.relative(process.cwd(), outFile)}\n`);
  if (missing.length) {
    process.stdout.write(`notices: ${missing.length} without a licence text: ${missing.join(", ")}\n`);
  }
}

// A CLI when run, a module when imported by the dev server. Only the former should write files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
