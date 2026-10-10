import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/agent-session-viewer/",
  plugins: [react()],
  build: { assetsInlineLimit: 0 },
});
