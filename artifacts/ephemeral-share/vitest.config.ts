import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  define: {
    "import.meta.env.BASE_URL": JSON.stringify("/"),
    "import.meta.env.VITE_HCAPTCHA_SITE_KEY": JSON.stringify("test-site-key"),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/__tests__/setup.ts"],
    globals: true,
  },
});
