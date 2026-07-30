import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { collectNotices } from "../scripts/notices.mjs";

const webVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const developmentApiTarget = process.env.SKYTRACE_DEV_API_TARGET || "http://127.0.0.1:3000";

// In a build the notices file is written into dist by scripts/notices.mjs; dev never has a dist, so
// the licence panel would 404 on a dev server. Generate the browser package list on request. The
// Docker build merges the linked Go server modules into the deployed notice file.
function developmentNotices() {
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  return {
    name: "skytrace-development-notices",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/third-party-notices.json", (_req, res) => {
        try {
          const packages = collectNotices([
            { root: path.join(repoRoot, "web"), scope: "web" },
          ]);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ packages }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });
    },
  };
}

function deploymentAssets() {
  let outputDirectory;
  return {
    name: "skytrace-deployment-assets",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      const tactical = Object.values(bundle).find((item) => item.type === "chunk" && item.name === "tactical3d");
      const index = Object.values(bundle).find((item) => item.type === "asset" && item.fileName === "index.html");
      if (tactical && index) {
        index.source = String(index.source).replace(
          "</head>",
          `<link rel="modulepreload" href="/${tactical.fileName}" crossorigin /></head>`,
        );
      }
    },
    closeBundle() {
      const pending = [outputDirectory];
      while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of readdirSync(directory)) {
          const filename = path.join(directory, entry);
          if (statSync(filename).isDirectory()) {
            pending.push(filename);
          } else if (/\.(?:html|css|js|json)$/.test(entry)) {
            writeFileSync(`${filename}.gz`, gzipSync(readFileSync(filename), { level: 9 }));
          }
        }
      }
    },
  };
}

export default defineConfig({
  define: {
    __SKYTRACE_WEB_VERSION__: JSON.stringify(webVersion),
  },
  plugins: [vue(), deploymentAssets(), developmentNotices()],
  server: {
    // The frontend can use a source or container backend without depending on any operator's
    // deployment. http-proxy streams responses, so /api/events remains unbuffered.
    proxy: {
      "/api": {
        target: developmentApiTarget,
        changeOrigin: true,
      },
    },
  },
});
