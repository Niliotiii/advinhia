import { defineConfig } from "vite";

export default defineConfig({
  // Assets in public/ (including the model) are copied verbatim to dist/.
  build: {
    target: "es2020",
    outDir: "dist",
  },
});
