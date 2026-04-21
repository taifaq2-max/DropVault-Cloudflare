import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = 5175;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(E2E_PORT),
      BASE_PATH: "/",
      VITE_USE_R2_UPLOADS: "true",
      VITE_HCAPTCHA_SITE_KEY: "",
      NODE_ENV: "test",
    },
  },
});
