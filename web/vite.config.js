import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    // Local dev against the live backend (read-only GET/SSE endpoints); http-proxy
    // streams responses, so /api/events (EventSource) works through this unbuffered.
    proxy: {
      "/api": {
        target: "https://sky.luftaquila.io",
        changeOrigin: true,
      },
    },
  },
});
