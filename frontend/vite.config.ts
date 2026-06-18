import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_BASE_URL || process.env.OPENBUTLER_API_BASE_URL || "http://127.0.0.1:8010";
const isDesktopBuild = process.env.OPENBUTLER_DESKTOP_BUILD === "1";

export default defineConfig({
  plugins: [react()],
  base: isDesktopBuild ? "./" : "/",
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget
    }
  }
});
