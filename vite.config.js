import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(__dirname, "client"),

  // Keep .env in the project root even though the Vite root is /client.
  envDir: __dirname,

  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,

    // Development only: Cloudflare Quick Tunnel hostnames change every run.
    allowedHosts: true,

    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:3001",
        ws: true,
      },
    },
  },

  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
  },
});
