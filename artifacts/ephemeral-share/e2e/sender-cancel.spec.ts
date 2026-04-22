import { test, expect } from "@playwright/test";

/**
 * End-to-end tests for the Cancel button in SenderPage's share-creation flow.
 *
 * All API calls (upload-url, R2 PUT, confirm) are intercepted via page.route()
 * so the tests run without a real API server or R2 bucket.
 *
 * The dev server is started by playwright.config.ts with:
 *   VITE_USE_R2_UPLOADS=true  — enables the XHR-based R2 upload path
 *   VITE_HCAPTCHA_SITE_KEY="" — disables the captcha widget
 *
 * Two route-interception strategies are used:
 *   1. Delay the upload-url fetch — keeps the UI in the "encrypting" phase.
 *      This is the primary flow for Cancel-click tests: delaying a fetch()
 *      (rather than an XHR) lets handleCancel's AbortController signal cleanly
 *      abort the in-flight call, and React's state update fires reliably.
 *   2. Delay the R2 PUT — keeps the UI in the "uploading" phase so we can
 *      verify the Cancel button is reachable at that stage of the pipeline.
 */

const MOCK_PENDING_ID = "test-cancel-pending-123";
const MOCK_UPLOAD_URL = "https://mock.r2.example.com/upload/cancel-test-object";
const MOCK_SHARE_ID = "test-cancel-share-abc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Route the upload-url endpoint to never respond.
 *
 * With the response held in-flight, handleCreateShare awaits
 * createShareUploadUrl() and the UI stays in the "encrypting" phase,
 * keeping the Cancel button visible.  Because this is a fetch() (not XHR),
 * the AbortController signal wired through cancelControllerRef cleanly
 * aborts the call when handleCancel fires, allowing reliable UI-reset
 * assertions in real Chromium.
 */
async function holdUploadUrl(page: import("@playwright/test").Page) {
  await page.route("**/api/shares/upload-url", async () => {
    /* intentionally never fulfilled — holds the encrypting phase open */
    await new Promise<void>(() => undefined);
  });
}

/**
 * Route the upload-url endpoint to respond immediately (so the XHR starts),
 * then hold the R2 PUT in-flight via an async route handler.
 *
 * With the PUT held, the UI is in the "uploading" phase so the Cancel button
 * is visible at that pipeline stage.  This strategy is used only to verify
 * button reachability during the upload phase; the click-and-reset assertions
 * use holdUploadUrl() instead, which is more reliable for state verification
 * in a real browser (see module-level comment).
 */
async function holdR2Put(page: import("@playwright/test").Page) {
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

  await page.route(MOCK_UPLOAD_URL, async () => {
    /* intentionally never fulfilled — holds the uploading phase open */
    await new Promise<void>(() => undefined);
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

// ---------------------------------------------------------------------------
// Tests — Cancel button reachability during upload phase
// ---------------------------------------------------------------------------

test.describe("SenderPage — Cancel button visible during upload phase", () => {
  test("Cancel button appears while the R2 PUT is in-flight", async ({
    page,
  }) => {
    await holdR2Put(page);
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("upload phase cancel visibility test");

    await page.getByRole("button", { name: /create secure share/i }).click();

    // The Cancel button must be visible while the upload is held open.
    await expect(
      page.getByRole("button", { name: /cancel share creation/i })
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Tests — Cancel button reachability and reset during encrypting phase
//
// The upload-url fetch is the step immediately after encryption; delaying it
// keeps the UI in the "encrypting" phase where the Cancel button is shown.
// Using fetch() interception (rather than XHR) allows the AbortController
// signal to reliably abort the in-flight request, so the full cancel-and-reset
// flow can be verified in a real Chromium browser.
// ---------------------------------------------------------------------------

test.describe("SenderPage — Cancel button during encrypting phase", () => {
  test.beforeEach(async ({ page }) => {
    await holdUploadUrl(page);
  });

  test("Cancel button appears while the upload-url fetch is in-flight", async ({
    page,
  }) => {
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("encrypting phase cancel visibility test");

    await page.getByRole("button", { name: /create secure share/i }).click();

    await expect(
      page.getByRole("button", { name: /cancel share creation/i })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("clicking Cancel resets the UI and shows no error banner", async ({
    page,
  }) => {
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("encrypting phase cancel reset test");

    await page.getByRole("button", { name: /create secure share/i }).click();

    const cancelBtn = page.getByRole("button", {
      name: /cancel share creation/i,
    });
    await expect(cancelBtn).toBeVisible({ timeout: 15_000 });

    await cancelBtn.click();

    // Progress section must disappear — uploadPhase reset to null.
    await expect(cancelBtn).not.toBeVisible({ timeout: 5_000 });

    // Cancel is a silent reset — no error banner should appear.
    await expect(page.getByRole("alert")).not.toBeVisible();

    // The primary action button must be available again.
    await expect(
      page.getByRole("button", { name: /create secure share/i })
    ).toBeEnabled({ timeout: 5_000 });
  });

  test("the share URL is never shown after cancellation", async ({ page }) => {
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("encrypting phase cancel no-share-url test");

    await page.getByRole("button", { name: /create secure share/i }).click();

    const cancelBtn = page.getByRole("button", {
      name: /cancel share creation/i,
    });
    await expect(cancelBtn).toBeVisible({ timeout: 15_000 });
    await cancelBtn.click();

    await expect(cancelBtn).not.toBeVisible({ timeout: 5_000 });

    // The share-link input must not appear — the share was never completed.
    await expect(
      page.getByRole("textbox", { name: /^share link$/i })
    ).not.toBeVisible();
  });

  test("a second share can be created normally after cancellation", async ({
    page,
  }) => {
    // First, start and cancel a share.
    await page.goto("/");

    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("first attempt — will cancel");

    await page.getByRole("button", { name: /create secure share/i }).click();

    const cancelBtn = page.getByRole("button", {
      name: /cancel share creation/i,
    });
    await expect(cancelBtn).toBeVisible({ timeout: 15_000 });
    await cancelBtn.click();
    await expect(cancelBtn).not.toBeVisible({ timeout: 5_000 });

    // Now swap the upload-url route for one that resolves immediately so the
    // second attempt can complete successfully.
    await page.unroute("**/api/shares/upload-url");
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

    // Route the R2 PUT and confirm so the full flow can succeed.
    await page.route(MOCK_UPLOAD_URL, (route) => route.fulfill({ status: 200 }));
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

    // The form must still be usable — start a second share attempt.
    await page
      .getByRole("textbox", { name: /text content to share/i })
      .fill("second attempt — should succeed");

    await page.getByRole("button", { name: /create secure share/i }).click();

    // The second attempt must complete and show the share link.
    const shareLink = page.getByRole("textbox", { name: /^share link$/i });
    await expect(shareLink).toBeVisible({ timeout: 15_000 });
    await expect(shareLink).toHaveValue(new RegExp(MOCK_SHARE_ID));
  });
});

// ---------------------------------------------------------------------------
// Helpers — file-share setup
// ---------------------------------------------------------------------------

/**
 * Switch to "files" mode and attach three synthetic 5 MB files to the hidden
 * file input.  Using multiple large files (15 MB total) makes the FileReader
 * reading phase take long enough in headless Chromium that the Cancel button
 * is still visible—and the "Reading…" status label is still shown—before the
 * reading phase completes and the encrypting phase begins.
 */
async function attachLargeFiles(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /^files$/i }).click();

  const buffer = Buffer.alloc(5 * 1024 * 1024, 0x42);
  await page.locator('input[type="file"]').setInputFiles([
    { name: "large-test-file-1.bin", mimeType: "application/octet-stream", buffer },
    { name: "large-test-file-2.bin", mimeType: "application/octet-stream", buffer },
    { name: "large-test-file-3.bin", mimeType: "application/octet-stream", buffer },
  ]);
}

// ---------------------------------------------------------------------------
// Tests — Cancel button reachability and reset during reading phase
//
// The upload-url fetch is held open so the entire reading → encrypting
// pipeline stays alive long enough for assertions.  The reading phase is the
// first phase entered for file shares, so the Cancel button is visible as
// soon as the first FileReader starts.
// ---------------------------------------------------------------------------

test.describe("SenderPage — Cancel button during reading phase (file share)", () => {
  test.beforeEach(async ({ page }) => {
    await holdUploadUrl(page);
  });

  test("Cancel button appears while files are being read", async ({ page }) => {
    await page.goto("/");
    await attachLargeFiles(page);

    await page.getByRole("button", { name: /create secure share/i }).click();

    // The "Reading …" status label is exclusive to uploadPhase === "reading".
    // Wait for it to confirm we are in the reading phase before asserting
    // the Cancel button.
    await expect(page.getByText(/^reading/i)).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /cancel share creation/i })
    ).toBeVisible();
  });

  test("clicking Cancel during reading resets the UI and shows no error banner", async ({
    page,
  }) => {
    await page.goto("/");
    await attachLargeFiles(page);

    await page.getByRole("button", { name: /create secure share/i }).click();

    // Confirm we are in the reading phase before clicking Cancel.
    await expect(page.getByText(/^reading/i)).toBeVisible({ timeout: 15_000 });

    const cancelBtn = page.getByRole("button", {
      name: /cancel share creation/i,
    });
    await expect(cancelBtn).toBeVisible();

    await cancelBtn.click();

    // Progress section must disappear — uploadPhase reset to null.
    await expect(cancelBtn).not.toBeVisible({ timeout: 5_000 });

    // Cancel is a silent reset — no error banner should appear.
    await expect(page.getByRole("alert")).not.toBeVisible();

    // The primary action button must be available again.
    await expect(
      page.getByRole("button", { name: /create secure share/i })
    ).toBeEnabled({ timeout: 5_000 });
  });

  test("the share URL is never shown after cancellation during reading", async ({
    page,
  }) => {
    await page.goto("/");
    await attachLargeFiles(page);

    await page.getByRole("button", { name: /create secure share/i }).click();

    // Confirm we are in the reading phase before clicking Cancel.
    await expect(page.getByText(/^reading/i)).toBeVisible({ timeout: 15_000 });

    const cancelBtn = page.getByRole("button", {
      name: /cancel share creation/i,
    });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    await expect(cancelBtn).not.toBeVisible({ timeout: 5_000 });

    // The share-link input must not appear — the share was never completed.
    await expect(
      page.getByRole("textbox", { name: /^share link$/i })
    ).not.toBeVisible();
  });

  test("a second file share can be created normally after cancellation during reading", async ({
    page,
  }) => {
    // First, start and cancel a file share during the reading phase.
    await page.goto("/");
    await attachLargeFiles(page);

    await page.getByRole("button", { name: /create secure share/i }).click();

    // Confirm we are in the reading phase before clicking Cancel.
    await expect(page.getByText(/^reading/i)).toBeVisible({ timeout: 15_000 });

    const cancelBtn = page.getByRole("button", {
      name: /cancel share creation/i,
    });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(cancelBtn).not.toBeVisible({ timeout: 5_000 });

    // Swap the upload-url route for one that resolves immediately so the
    // second attempt can complete successfully.
    await page.unroute("**/api/shares/upload-url");
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

    // Route the R2 PUT and confirm so the full flow can succeed.
    await page.route(MOCK_UPLOAD_URL, (route) => route.fulfill({ status: 200 }));
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

    // Attach a fresh file and start a second share attempt.
    const buffer = Buffer.alloc(1024, 0x42);
    await page.locator('input[type="file"]').setInputFiles([
      { name: "second-file.bin", mimeType: "application/octet-stream", buffer },
    ]);

    await page.getByRole("button", { name: /create secure share/i }).click();

    // The second attempt must complete and show the share link.
    const shareLink = page.getByRole("textbox", { name: /^share link$/i });
    await expect(shareLink).toBeVisible({ timeout: 15_000 });
    await expect(shareLink).toHaveValue(new RegExp(MOCK_SHARE_ID));
  });
});
