import { test, expect } from "@playwright/test";

/**
 * End-to-end tests for the captcha page pre-check loading indicator.
 *
 * This suite runs against the captcha-chromium project which starts a dev server
 * with VITE_HCAPTCHA_SITE_KEY="test-captcha-key" so the captcha gate and its
 * pre-check flow are active.
 *
 * All /peek API calls are intercepted via page.route() so no real API server is
 * required.  hcaptcha.com script requests are aborted to keep tests fast and
 * offline-safe.
 */

const MOCK_SHARE_ID = "test-captcha-e2e-123";
const PEEK_PATTERN = `**/api/shares/${MOCK_SHARE_ID}/peek`;
const SHARE_PATH = `/share/${MOCK_SHARE_ID}`;

const PEEK_SUCCESS_BODY = JSON.stringify({
  totalSize: 512,
  passwordRequired: false,
  shareType: "text",
  fileCount: 0,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

test.beforeEach(async ({ page }) => {
  await page.route("**hcaptcha.com**", (route) => route.abort());
});

test.describe("ReceiverPage — captcha pre-check loading indicator", () => {
  test("shows the loading indicator immediately when the captcha page loads", async ({
    page,
  }) => {
    await page.route(PEEK_PATTERN, () => {
      /* intentionally never fulfilled — keeps the pre-check in flight */
    });

    await page.goto(SHARE_PATH);

    await expect(page.getByLabel("Checking share validity")).toBeVisible();
    await expect(page.getByText("Checking share...")).toBeVisible();
  });

  test("the captcha widget is non-interactive while the pre-check is in flight", async ({
    page,
  }) => {
    await page.route(PEEK_PATTERN, () => {
      /* intentionally never fulfilled */
    });

    await page.goto(SHARE_PATH);

    await expect(page.getByLabel("Checking share validity")).toBeVisible();

    // The button is inside the aria-hidden wrapper so role-based lookup is
    // excluded from the a11y tree; use the aria-label attribute directly.
    await expect(
      page.locator('button[aria-label="Continue to access share"]')
    ).toBeDisabled();

    const captchaWrapper = page
      .getByLabel("Human verification")
      .locator("xpath=..");
    await expect(captchaWrapper).toHaveAttribute("aria-hidden", "true");
  });

  test("the loading indicator disappears and widget becomes interactive after the pre-check resolves", async ({
    page,
  }) => {
    await page.route(PEEK_PATTERN, (route) =>
      route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({ error: "captcha_required" }),
      })
    );

    await page.goto(SHARE_PATH);

    await expect(page.getByLabel("Checking share validity")).not.toBeVisible({
      timeout: 8_000,
    });

    const captchaWrapper = page
      .getByLabel("Human verification")
      .locator("xpath=..");
    await expect(captchaWrapper).toHaveAttribute("aria-hidden", "false");

    await expect(
      page.getByRole("button", { name: /continue to access share/i })
    ).toBeVisible();
  });

  test("loading indicator clears on a successful pre-check response", async ({
    page,
  }) => {
    await page.route(PEEK_PATTERN, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: PEEK_SUCCESS_BODY,
      })
    );

    await page.goto(SHARE_PATH);

    await expect(page.getByLabel("Checking share validity")).not.toBeVisible({
      timeout: 8_000,
    });

    const captchaWrapper = page
      .getByLabel("Human verification")
      .locator("xpath=..");
    await expect(captchaWrapper).toHaveAttribute("aria-hidden", "false");
  });

  test("transitions to the share-expired screen when the pre-check returns not_found", async ({
    page,
  }) => {
    await page.route(PEEK_PATTERN, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "not_found" }),
      })
    );

    await page.goto(SHARE_PATH);

    await expect(
      page.getByText("This share has expired", { exact: true })
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel("Checking share validity")).not.toBeVisible();
  });

  test("transitions to the share-consumed screen when the pre-check returns already_accessed", async ({
    page,
  }) => {
    await page.route(PEEK_PATTERN, (route) =>
      route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "already_accessed" }),
      })
    );

    await page.goto(SHARE_PATH);

    await expect(
      page.getByText("This share was already accessed")
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel("Checking share validity")).not.toBeVisible();
  });
});
