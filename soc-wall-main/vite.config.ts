import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

export default defineConfig({
  plugins: [sites()],
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
  },
  server: {
    host: "0.0.0.0",
  },
});
