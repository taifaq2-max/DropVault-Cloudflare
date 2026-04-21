import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const PEEK_SUCCESS = {
  totalSize: 1024,
  passwordRequired: false,
  shareType: "text",
  fileCount: 0,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  accessNonce: "test-nonce-abc",
};

const PEEK_SUCCESS_PASSWORD = {
  ...PEEK_SUCCESS,
  passwordRequired: true,
};

const SHARE_DATA_PASSWORD_REQUIRED = {
  passwordRequired: true,
  passwordSalt: "test-salt",
  shareType: "text",
  totalSize: 1024,
};

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useRoute: () => [true, { shareId: "test-share-id" }],
  useLocation: () => ["/share/test-share-id", vi.fn()],
}));

vi.mock("framer-motion", async () => {
  const { forwardRef, createElement, Fragment } = await import("react");

  const strip = ({
    initial: _i,
    animate: _a,
    exit: _e,
    transition: _t,
    whileHover: _wh,
    whileTap: _wt,
    ...rest
  }: Record<string, unknown>) => rest;

  const MotionDiv = forwardRef(
    (props: Record<string, unknown> & { children?: React.ReactNode }, ref: React.Ref<HTMLDivElement>) =>
      createElement("div", { ...strip(props), ref })
  );
  MotionDiv.displayName = "MotionDiv";

  const AnimatePresence = ({ children }: { children?: React.ReactNode }) =>
    createElement(Fragment, null, children);

  return { motion: { div: MotionDiv }, AnimatePresence };
});

vi.mock("@workspace/api-client-react", () => ({
  useDeleteShare: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
}));

vi.mock("@hcaptcha/react-hcaptcha", async () => {
  const { forwardRef, useImperativeHandle, createElement } = await import("react");
  const MockHCaptcha = forwardRef(
    (
      { onVerify }: { onVerify: (token: string) => void; sitekey?: string; theme?: string; onExpire?: () => void; onError?: () => void },
      ref: React.Ref<{ resetCaptcha: () => void }>
    ) => {
      useImperativeHandle(ref, () => ({ resetCaptcha: vi.fn() }));
      return createElement(
        "button",
        { "data-testid": "hcaptcha-widget", onClick: () => onVerify("mock-captcha-token") },
        "Solve Captcha"
      );
    }
  );
  MockHCaptcha.displayName = "MockHCaptcha";
  return { default: MockHCaptcha };
});

vi.mock("@/lib/crypto", () => ({
  importKeyFromBase64Url: vi.fn().mockResolvedValue({} as CryptoKey),
  decryptPayload: vi.fn().mockResolvedValue({ text: "decrypted text", files: [] }),
  decryptKeyWithPassword: vi.fn().mockResolvedValue(new Uint8Array(32)),
  base64ToBlob: vi.fn().mockReturnValue(new Blob(["file-data"])),
}));

vi.mock("@/lib/utils", () => ({
  formatBytes: vi.fn((n: number) => `${n} B`),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    ...props
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
    [key: string]: unknown;
  }) =>
    React.createElement(
      "button",
      { onClick, disabled, "aria-label": ariaLabel },
      children
    ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("jszip");

// ---------------------------------------------------------------------------
// Import component under test (after all mocks are declared)
// ---------------------------------------------------------------------------

const { default: ReceiverPage } = await import("@/pages/ReceiverPage");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReceiverPage — captcha pre-check phase transitions", () => {
  it("pre-check returns 404 not_found → goes to share_expired", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(404, { error: "not_found" })
    );

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getAllByText(/this share has expired/i).length).toBeGreaterThan(0);
    });
  });

  it("pre-check returns 410 already_accessed → goes to share_consumed", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(410, { error: "already_accessed" })
    );

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getByText(/already been accessed|already accessed|one-time|consumed/i)).toBeInTheDocument();
    });
  });

  it("pre-check returns 403 captcha_required → stays on captcha gate", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(403, { error: "captcha_required" })
    );

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getByText(/Human Verification/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/permanently deleted/i)).not.toBeInTheDocument();
  });
});

describe("ReceiverPage — captcha submission flow", () => {
  it("completing captcha and submitting → peek succeeds → shows warning phase", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("captchaToken=")) {
        return Promise.resolve(mockResponse(200, PEEK_SUCCESS));
      }
      return Promise.resolve(mockResponse(403, { error: "captcha_required" }));
    });

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getByTestId("hcaptcha-widget")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("hcaptcha-widget"));
    });

    const continueBtn = await screen.findByRole("button", { name: /continue to access share/i });

    await act(async () => {
      fireEvent.click(continueBtn);
    });

    await waitFor(() => {
      expect(screen.getByText(/permanently deleted after you access it/i)).toBeInTheDocument();
    });
  });

  it("captcha submission with captcha_failed response → stays on captcha with error message", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("captchaToken=")) {
        return Promise.resolve(mockResponse(403, { error: "captcha_failed" }));
      }
      return Promise.resolve(mockResponse(403, { error: "captcha_required" }));
    });

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getByTestId("hcaptcha-widget")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("hcaptcha-widget"));
    });

    const continueBtn = await screen.findByRole("button", { name: /continue to access share/i });

    await act(async () => {
      fireEvent.click(continueBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/verification failed/i);
    });

    expect(screen.getByText(/Human Verification/i)).toBeInTheDocument();
  });

  it("captcha submission returns 404 not_found → transitions to share_expired", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("captchaToken=")) {
        return Promise.resolve(mockResponse(404, { error: "not_found" }));
      }
      return Promise.resolve(mockResponse(403, { error: "captcha_required" }));
    });

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getByTestId("hcaptcha-widget")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("hcaptcha-widget"));
    });

    const continueBtn = await screen.findByRole("button", { name: /continue to access share/i });

    await act(async () => {
      fireEvent.click(continueBtn);
    });

    await waitFor(() => {
      expect(screen.getAllByText(/this share has expired/i).length).toBeGreaterThan(0);
    });
  });

  it("captcha submission returns 410 already_accessed → transitions to share_consumed", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("captchaToken=")) {
        return Promise.resolve(mockResponse(410, { error: "already_accessed" }));
      }
      return Promise.resolve(mockResponse(403, { error: "captcha_required" }));
    });

    render(React.createElement(ReceiverPage));

    await waitFor(() => {
      expect(screen.getByTestId("hcaptcha-widget")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("hcaptcha-widget"));
    });

    const continueBtn = await screen.findByRole("button", { name: /continue to access share/i });

    await act(async () => {
      fireEvent.click(continueBtn);
    });

    await waitFor(() => {
      expect(screen.getByText(/already been accessed|already accessed|one-time|consumed/i)).toBeInTheDocument();
    });
  });
});

describe("ReceiverPage — warning phase → access", () => {
  async function renderToWarning() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("captchaToken=")) {
        return Promise.resolve(mockResponse(200, PEEK_SUCCESS));
      }
      return Promise.resolve(mockResponse(403, { error: "captcha_required" }));
    });

    render(React.createElement(ReceiverPage));

    await waitFor(() => expect(screen.getByTestId("hcaptcha-widget")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("hcaptcha-widget")); });
    const continueBtn = await screen.findByRole("button", { name: /continue to access share/i });
    await act(async () => { fireEvent.click(continueBtn); });
    await waitFor(() => expect(screen.getByRole("button", { name: /access data/i })).toBeInTheDocument());
  }

  it("warning phase shows share metadata", async () => {
    await renderToWarning();

    expect(screen.getByText(/permanently deleted after you access it/i)).toBeInTheDocument();
    expect(screen.getByText(/Password Required/i)).toBeInTheDocument();
    expect(screen.getByText(/Total Size/i)).toBeInTheDocument();
  });

  it("clicking Access Data when passwordRequired → transitions to password phase", async () => {
    await renderToWarning();

    mockFetch.mockResolvedValueOnce(mockResponse(200, SHARE_DATA_PASSWORD_REQUIRED));

    const accessBtn = screen.getByRole("button", { name: /access data/i });
    await act(async () => { fireEvent.click(accessBtn); });

    await waitFor(() => {
      expect(screen.getByText(/Password Required/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /submit password/i })).toBeInTheDocument();
    });
  });

  it("clicking Access Data when fetchShare returns 404 → transitions to share_expired", async () => {
    await renderToWarning();

    mockFetch.mockResolvedValueOnce(mockResponse(404, { error: "not_found" }));

    const accessBtn = screen.getByRole("button", { name: /access data/i });
    await act(async () => { fireEvent.click(accessBtn); });

    await waitFor(() => {
      expect(screen.getAllByText(/this share has expired/i).length).toBeGreaterThan(0);
    });
  });

  it("clicking Access Data when fetchShare returns 410 already_accessed → transitions to share_consumed", async () => {
    await renderToWarning();

    mockFetch.mockResolvedValueOnce(mockResponse(410, { error: "already_accessed" }));

    const accessBtn = screen.getByRole("button", { name: /access data/i });
    await act(async () => { fireEvent.click(accessBtn); });

    await waitFor(() => {
      expect(screen.getByText(/already been accessed|already accessed|one-time|consumed/i)).toBeInTheDocument();
    });
  });

  it("clicking Access Data when nonce is invalid → transitions to nonce_expired phase", async () => {
    await renderToWarning();

    mockFetch.mockResolvedValueOnce(mockResponse(403, { error: "invalid_nonce" }));

    const accessBtn = screen.getByRole("button", { name: /access data/i });
    await act(async () => { fireEvent.click(accessBtn); });

    await waitFor(() => {
      expect(screen.getAllByText(/your session expired/i).length).toBeGreaterThan(0);
    });
  });
});

describe("ReceiverPage — password phase", () => {
  async function renderToPasswordPhase() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("captchaToken=")) {
        return Promise.resolve(mockResponse(200, PEEK_SUCCESS_PASSWORD));
      }
      if (url.includes("/peek")) {
        return Promise.resolve(mockResponse(403, { error: "captcha_required" }));
      }
      return Promise.resolve(mockResponse(200, SHARE_DATA_PASSWORD_REQUIRED));
    });

    render(React.createElement(ReceiverPage));

    await waitFor(() => expect(screen.getByTestId("hcaptcha-widget")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("hcaptcha-widget")); });
    const continueBtn = await screen.findByRole("button", { name: /continue to access share/i });
    await act(async () => { fireEvent.click(continueBtn); });
    await waitFor(() => expect(screen.getByRole("button", { name: /access data/i })).toBeInTheDocument());

    const accessBtn = screen.getByRole("button", { name: /access data/i });
    await act(async () => { fireEvent.click(accessBtn); });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /submit password/i })).toBeInTheDocument();
    });
  }

  it("submitting empty password shows validation error", async () => {
    await renderToPasswordPhase();

    const decryptBtn = screen.getByRole("button", { name: /submit password/i });
    await act(async () => { fireEvent.click(decryptBtn); });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/enter the password/i);
    });
  });

  it("password input is present and accepts input", async () => {
    await renderToPasswordPhase();

    const passwordInput = screen.getByRole("textbox", { name: /share password/i });
    expect(passwordInput).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: "my-secret" } });
    });

    expect(passwordInput).toHaveValue("my-secret");
  });
});
