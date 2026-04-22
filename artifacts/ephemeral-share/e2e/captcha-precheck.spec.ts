import { test, expect } from "@playwright/test";

/**
 * End-to-end tests for the captcha page pre-check loading indicator.
 *
 * This suite runs against the captcha-chromium project which starts a dev server
 * with VITE_HCAPTCHA_SITE_KEY="10000000-ffff-ffff-ffff-000000000001" (hCaptcha's
 * official test site key) so the captcha gate and its pre-check flow are active.
 *
 * All /peek API calls are intercepted via page.route() so no real API server is
 * required.  hcaptcha.com script requests are aborted to keep tests fast and
 * offline-safe — except in the hCaptcha credential suites, where the API script
 * is replaced with a minimal stub that fires onVerify programmatically.
 */

/**
 * Init script injected into the page before any other script runs.
 *
 * @hcaptcha/react-hcaptcha checks window.hcaptcha on componentDidMount: if the
 * object is already present it skips the script-load step and calls render()
 * directly.  Pre-populating window.hcaptcha here means no network request to
 * hcaptcha.com is made at all, keeping tests fast and offline-safe.
 *
 * After render() is called by the component, tests trigger onVerify via:
 *   page.evaluate(() => window.__hcaptchaFireVerify('test-token'))
 *
 * The library's handleSubmit ignores the token argument and calls
 * hcaptcha.getResponse() instead, so we make getResponse() return a fixed
 * test token once render() has been called.
 */
const MOCK_HCAPTCHA_INIT_SCRIPT = `
(function () {
  window.hcaptcha = {
    _lastParams: null,
    _rendered: false,
    render: function (el, params) {
      window.hcaptcha._lastParams = params;
      window.hcaptcha._rendered = true;
      return 'mock-widget-0';
    },
    reset: function (id) {
      window.hcaptcha._lastParams = null;
      window.hcaptcha._rendered = false;
    },
    remove: function (id) {},
    execute: function (id, opts) {},
    close: function (id) {},
    getResponse: function (id) {
      return window.hcaptcha._lastParams ? 'test-captcha-token' : '';
    },
    getRespKey: function (id) { return ''; },
    setData: function (id, data) {},
  };

  window.__hcaptchaFireVerify = function (token) {
    var params = window.hcaptcha._lastParams;
    if (params && typeof params.callback === 'function') {
      params.callback(token || 'test-captcha-token');
    }
  };
})();
`;

const MOCK_SHARE_ID = "test-captcha-e2e-123";
const PEEK_PATTERN = `**/api/shares/${MOCK_SHARE_ID}/peek`;
// Regex variant: matches the peek path with or without a query string.
// Playwright's glob patterns anchor the end so they won't match ?captchaToken=…
const PEEK_REGEX = new RegExp(`/api/shares/${MOCK_SHARE_ID}/peek`);
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

test.describe("ReceiverPage — post-captcha re-check loading state", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: MOCK_HCAPTCHA_INIT_SCRIPT });
    await page.route("**hcaptcha.com**", (route) => route.abort());
  });

  test("shows 'Checking share status' spinner while re-check is in-flight then hides it", async ({
    page,
  }) => {
    let reCheckResolve: (() => void) | null = null;
    const reCheckDeferred = new Promise<void>((resolve) => {
      reCheckResolve = resolve;
    });
    let authenticatedPeekSeen = false;

    await page.route(PEEK_REGEX, async (route) => {
      const url = route.request().url();

      if (url.includes("captchaToken")) {
        // Authenticated peek triggered by the Continue button — return captcha_error
        // so the component sets reCheckLoading=true and fires the tokenless re-check.
        authenticatedPeekSeen = true;
        return route.fulfill({
          status: 402,
          contentType: "application/json",
          body: JSON.stringify({ error: "captcha_error" }),
        });
      }

      if (authenticatedPeekSeen) {
        // This is the tokenless re-check — delay it so the spinner stays visible
        // long enough for the assertion to pass, then resolve with captcha_required
        // so the component stays on the captcha screen (share still exists).
        await reCheckDeferred;
        return route.fulfill({
          status: 402,
          contentType: "application/json",
          body: JSON.stringify({ error: "captcha_required" }),
        });
      }

      // Initial tokenless pre-check — return captcha_required so the captcha
      // gate opens and the widget becomes interactive.
      return route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({ error: "captcha_required" }),
      });
    });

    await page.goto(SHARE_PATH);

    // Wait for the initial pre-check to resolve and the widget to become interactive.
    await expect(page.getByLabel("Checking share validity")).not.toBeVisible({
      timeout: 8_000,
    });

    // Wait for the mock hcaptcha stub to call render() before firing onVerify.
    await page.waitForFunction(
      () =>
        (window as unknown as { hcaptcha: { _rendered: boolean } }).hcaptcha
          ._rendered === true,
      { timeout: 5_000 }
    );

    // Simulate the user completing the captcha challenge.
    await page.evaluate(() =>
      (
        window as unknown as {
          __hcaptchaFireVerify: (t: string) => void;
        }
      ).__hcaptchaFireVerify("10000000-ffff-ffff-ffff-000000000001")
    );

    const continueBtn = page.locator(
      'button[aria-label="Continue to access share"]'
    );
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 });

    // Click Continue — triggers the authenticated peek which returns captcha_error,
    // which in turn starts the tokenless re-check (reCheckLoading=true).
    await continueBtn.click();

    // The 'Checking share status' spinner must be visible while the re-check is
    // held in-flight by the deferred.
    await expect(page.getByLabel("Checking share status")).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.getByText("Checking share status…")
    ).toBeVisible();

    // Release the delayed re-check response.
    reCheckResolve!();

    // After the re-check resolves the spinner must disappear.
    await expect(page.getByLabel("Checking share status")).not.toBeVisible({
      timeout: 5_000,
    });
  });
});

test.describe("ReceiverPage — hCaptcha test-credentials end-to-end", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept window.hcaptchaOnLoad assignment before any page script runs.
    // This lets us install a mock window.hcaptcha and fire the onLoad callback
    // immediately, so the React component proceeds to call render() without
    // needing any network access to hcaptcha.com.
    await page.addInitScript({ content: MOCK_HCAPTCHA_INIT_SCRIPT });
    // Block all hcaptcha.com requests so the real API script cannot override
    // the mock we injected via addInitScript.
    await page.route("**hcaptcha.com**", (route) => route.abort());
  });

  test("Continue button becomes enabled after the captcha widget fires onVerify", async ({
    page,
  }) => {
    // Pre-check returns 402 so the captcha gate becomes interactive.
    // Use PEEK_REGEX so Playwright matches both the plain path and paths with
    // a ?captchaToken query string (glob patterns anchor the end and won't
    // match query strings).
    await page.route(PEEK_REGEX, (route) =>
      route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({ error: "captcha_required" }),
      })
    );

    await page.goto(SHARE_PATH);

    // Wait for the pre-check to finish and the widget to become interactive.
    await expect(page.getByLabel("Checking share validity")).not.toBeVisible({
      timeout: 8_000,
    });

    const continueBtn = page.locator(
      'button[aria-label="Continue to access share"]'
    );
    await expect(continueBtn).toBeDisabled();

    // Wait for the stub's render() to be called before firing verify.
    await page.waitForFunction(
      () => (window as unknown as { hcaptcha: { _rendered: boolean } }).hcaptcha._rendered === true,
      { timeout: 5_000 }
    );

    // Fire the onVerify callback via our stub helper — simulates the user
    // completing the hCaptcha challenge with the official test credentials.
    await page.evaluate(() =>
      (window as unknown as { __hcaptchaFireVerify: (t: string) => void }).__hcaptchaFireVerify(
        "10000000-ffff-ffff-ffff-000000000001"
      )
    );

    await expect(continueBtn).toBeEnabled({ timeout: 5_000 });
  });

  test("shows Verifying... on the Continue button while the authenticated peek is in-flight", async ({
    page,
  }) => {
    // Pre-check returns 402 so the captcha gate opens.
    // PEEK_REGEX matches both the plain path and ?captchaToken=… URLs.
    await page.route(PEEK_REGEX, async (route) => {
      if (route.request().url().includes("captchaToken")) {
        // Authenticated peek — never resolve so the spinner stays visible.
        return;
      }
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({ error: "captcha_required" }),
      });
    });

    await page.goto(SHARE_PATH);

    await expect(page.getByLabel("Checking share validity")).not.toBeVisible({
      timeout: 8_000,
    });

    // Wait for the stub's render() to be called before firing verify.
    await page.waitForFunction(
      () => (window as unknown as { hcaptcha: { _rendered: boolean } }).hcaptcha._rendered === true,
      { timeout: 5_000 }
    );

    // Simulate captcha completion.
    await page.evaluate(() =>
      (window as unknown as { __hcaptchaFireVerify: (t: string) => void }).__hcaptchaFireVerify(
        "10000000-ffff-ffff-ffff-000000000001"
      )
    );

    const continueBtn = page.locator(
      'button[aria-label="Continue to access share"]'
    );
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 });

    await continueBtn.click();

    // While the authenticated peek is in-flight the button should read "Verifying..."
    await expect(continueBtn).toHaveText("Verifying...", { timeout: 5_000 });
    await expect(continueBtn).toBeDisabled();
  });

  test("transitions to the warning phase after captcha resolves successfully", async ({
    page,
  }) => {
    // Pre-check returns 402 so the captcha gate opens.
    // PEEK_REGEX matches both the plain path and ?captchaToken=… URLs.
    await page.route(PEEK_REGEX, async (route) => {
      if (route.request().url().includes("captchaToken")) {
        // Authenticated peek succeeds — return full peek data.
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            totalSize: 1024,
            passwordRequired: false,
            shareType: "text",
            fileCount: 0,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        });
      }
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({ error: "captcha_required" }),
      });
    });

    await page.goto(SHARE_PATH);

    await expect(page.getByLabel("Checking share validity")).not.toBeVisible({
      timeout: 8_000,
    });

    // Wait for the stub's render() to be called before firing verify.
    await page.waitForFunction(
      () => (window as unknown as { hcaptcha: { _rendered: boolean } }).hcaptcha._rendered === true,
      { timeout: 5_000 }
    );

    // Simulate captcha completion with hCaptcha test credentials.
    await page.evaluate(() =>
      (window as unknown as { __hcaptchaFireVerify: (t: string) => void }).__hcaptchaFireVerify(
        "10000000-ffff-ffff-ffff-000000000001"
      )
    );

    const continueBtn = page.locator(
      'button[aria-label="Continue to access share"]'
    );
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 });
    await continueBtn.click();

    // After a successful authenticated peek the page should reach the warning phase.
    await expect(
      page.getByText("This data will be permanently deleted after you access it.", {
        exact: false,
      })
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel("Access data")).toBeVisible();
  });
});
