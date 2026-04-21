import { test, expect } from "@playwright/test";

/**
 * End-to-end tests for the R2 upload retry flow in SenderPage.
 *
 * All API calls (upload-url, R2 PUT, confirm) are intercepted via page.route()
 * so the tests run without a real API server or R2 bucket.
 *
 * The dev server is started by playwright.config.ts with:
 *   VITE_USE_R2_UPLOADS=true  — enables the XHR-based R2 upload path
 *   VITE_HCAPTCHA_SITE_KEY="" — disables the captcha widget
 */

const MOCK_PENDING_ID = "test-pending-e2e-123";
const MOCK_UPLOAD_URL = "https://mock.r2.example.com/upload/test-e2e-object";
const MOCK_SHARE_ID = "test-share-e2e-abc";

async function setupRoutes(
  page: import("@playwright/test").Page,
  xhrBehaviour: "fail-then-succeed" | "always-fail"
) {
  let putCallCount = 0;

  await page.route("**/api/shares/upload-url", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        shareId: MOCK_PENDING_ID,
        uploadUrl: MOCK_UPLOAD_URL,
      }),
    })
  );

  await page.route(MOCK_UPLOAD_URL, (route) => {
    putCallCount++;
    if (xhrBehaviour === "always-fail" || putCallCount === 1) {
      route.fulfill({ status: 500, body: "Internal Server Error" });
    } else {
      route.fulfill({ status: 200 });
    }
  });

  await page.route("**/api/shares/confirm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        shareId: MOCK_SHARE_ID,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
  );
}

test.describe("SenderPage — R2 upload retry flow", () => {
  test("shows an error message and Retry Upload button when the R2 PUT returns a non-2xx status", async ({
    page,
  }) => {
    await setupRoutes(page, "fail-then-succeed");
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("e2e test secret message");

    await page.getByRole("button", { name: /create secure share/i }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/R2 upload failed/i);

    await expect(
      page.getByRole("button", { name: /retry upload/i })
    ).toBeVisible();
  });

  test("completes the share and shows the share URL when Retry Upload succeeds", async ({
    page,
  }) => {
    await setupRoutes(page, "fail-then-succeed");
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("e2e test secret message");

    await page.getByRole("button", { name: /create secure share/i }).click();

    await expect(
      page.getByRole("button", { name: /retry upload/i })
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /retry upload/i }).click();

    const shareLink = page.getByRole("textbox", { name: /^share link$/i });
    await expect(shareLink).toBeVisible({ timeout: 15_000 });
    await expect(shareLink).toHaveValue(new RegExp(MOCK_SHARE_ID));
  });

  test("keeps the Retry Upload button visible when the retried upload also fails", async ({
    page,
  }) => {
    await setupRoutes(page, "always-fail");
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("e2e test secret message");

    await page.getByRole("button", { name: /create secure share/i }).click();

    await expect(
      page.getByRole("button", { name: /retry upload/i })
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /retry upload/i }).click();

    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /retry upload/i })
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /^share link$/i })
    ).not.toBeVisible();
  });
});
