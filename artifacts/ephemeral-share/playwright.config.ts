import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = 5175;
const CAPTCHA_E2E_PORT = 5176;

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
      testIgnore: ["**/captcha-precheck.spec.ts"],
    },
    {
      name: "captcha-chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${CAPTCHA_E2E_PORT}`,
      },
      testMatch: ["**/captcha-precheck.spec.ts"],
    },
  ],
  webServer: [
    {
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
    {
      command: `pnpm dev`,
      url: `http://localhost:${CAPTCHA_E2E_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: String(CAPTCHA_E2E_PORT),
        BASE_PATH: "/",
        VITE_USE_R2_UPLOADS: "true",
        VITE_HCAPTCHA_SITE_KEY: "test-captcha-key",
        NODE_ENV: "test",
      },
    },
  ],
});
