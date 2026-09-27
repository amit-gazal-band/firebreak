import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained index.html: served by `firebreak serve` and embedded by `firebreak export` (SPEC §8.6).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": { target: "http://localhost:5173", ws: true } },
    port: 5174,
  },
});
