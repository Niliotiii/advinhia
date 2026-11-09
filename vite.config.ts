import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Assets in public/ (including the model) are copied verbatim to dist/.
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: {
      input: {
        // Single-player (home) + multiplayer room pages.
        main: resolve(__dirname, "index.html"),
        room: resolve(__dirname, "room.html"),
      },
    },
  },
});
