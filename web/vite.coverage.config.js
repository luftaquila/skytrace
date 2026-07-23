import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  cacheDir: "/private/tmp/skytrace-vite-cache",
  plugins: [vue()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:3320" },
    },
  },
});
