import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env["HOWDY_API"] ?? "http://127.0.0.1:4747";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": { target, changeOrigin: true, ws: false },
    },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
});
