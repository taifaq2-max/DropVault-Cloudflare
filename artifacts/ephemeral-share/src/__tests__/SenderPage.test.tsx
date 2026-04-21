import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// XHR mock — response queue controls whether each R2 PUT succeeds or fails.
// Shift a status code off xhrResponseQueue on every send().  If the queue is
// exhausted fall back to 200 (success).
// ---------------------------------------------------------------------------

let xhrResponseQueue: number[] = [];

class MockXHR {
  status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(_method: string, _url: string) {}
  setRequestHeader(_key: string, _value: string) {}

  send(_data: unknown) {
    const responseStatus =
      xhrResponseQueue.length > 0 ? xhrResponseQueue.shift()! : 200;
    const self = this;
    setTimeout(() => {
      self.status = responseStatus;
      self.onload?.();
    }, 0);
  }
}

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import of the component
// ---------------------------------------------------------------------------

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
    (
      props: Record<string, unknown> & { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>
    ) => createElement("div", { ...strip(props), ref })
  );
  MotionDiv.displayName = "MotionDiv";

  const MotionButton = forwardRef(
    (
      props: Record<string, unknown> & { children?: React.ReactNode },
      ref: React.Ref<HTMLButtonElement>
    ) => createElement("button", { ...strip(props), ref })
  );
  MotionButton.displayName = "MotionButton";

  const MotionSpan = forwardRef(
    (
      props: Record<string, unknown> & { children?: React.ReactNode },
      ref: React.Ref<HTMLSpanElement>
    ) => createElement("span", { ...strip(props), ref })
  );
  MotionSpan.displayName = "MotionSpan";

  const AnimatePresence = ({ children }: { children?: React.ReactNode }) =>
    createElement(Fragment, null, children);

  return {
    motion: { div: MotionDiv, button: MotionButton, span: MotionSpan },
    AnimatePresence,
  };
});

vi.mock("@hcaptcha/react-hcaptcha", async () => {
  const { forwardRef, useImperativeHandle, createElement } = await import("react");
  const MockHCaptcha = forwardRef(
    (
      {
        onVerify,
      }: {
        onVerify: (token: string) => void;
        sitekey?: string;
        theme?: string;
        onExpire?: () => void;
        onError?: () => void;
      },
      ref: React.Ref<{ resetCaptcha: () => void }>
    ) => {
      useImperativeHandle(ref, () => ({ resetCaptcha: vi.fn() }));
      return createElement(
        "button",
        {
          "data-testid": "hcaptcha-widget",
          onClick: () => onVerify("mock-captcha-token"),
        },
        "Solve Captcha"
      );
    }
  );
  MockHCaptcha.displayName = "MockHCaptcha";
  return { default: MockHCaptcha };
});

const mockCreateShareUploadUrl = vi.fn();
const mockConfirmShare = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useCreateShare: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestWebhook: () => ({ mutateAsync: vi.fn() }),
  createShareUploadUrl: mockCreateShareUploadUrl,
  confirmShare: mockConfirmShare,
}));

vi.mock("@/lib/crypto", () => ({
  generateEncryptionKey: vi.fn().mockResolvedValue({
    key: {} as CryptoKey,
    rawKey: new Uint8Array(32),
    keyBase64Url: "test-key-base64url",
  }),
  encryptPayload: vi.fn().mockResolvedValue("encrypted-payload-data"),
  encryptKeyWithPassword: vi.fn().mockResolvedValue({
    encryptedKey: "encrypted-key-hash",
    salt: "test-salt",
  }),
  fileToBase64: vi.fn().mockResolvedValue("base64filedata"),
}));

vi.mock("@/lib/utils", () => ({
  formatBytes: vi.fn((n: number) => `${n} B`),
  formatDuration: vi.fn((s: number) => `${s}s`),
  TTL_OPTIONS: [{ label: "1h", value: 3600 }],
  generatePassword: vi.fn().mockReturnValue("SuperSecurePassword123!"),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    type,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
    type?: string;
    [key: string]: unknown;
  }) =>
    React.createElement(
      "button",
      { onClick, disabled, "aria-label": ariaLabel, type: type ?? "button" },
      children
    ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
    React.createElement("textarea", props),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    ...rest
  }: React.LabelHTMLAttributes<HTMLLabelElement> & {
    children?: React.ReactNode;
  }) => React.createElement("label", rest, children),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    id?: string;
  }) =>
    React.createElement("input", {
      type: "checkbox",
      id,
      checked: checked ?? false,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(e.target.checked),
    }),
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}));

// ---------------------------------------------------------------------------
// Import component under test (after all mocks are declared)
// ---------------------------------------------------------------------------

const { default: SenderPage } = await import("@/pages/SenderPage");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  xhrResponseQueue = [500, 200];
  vi.stubGlobal("XMLHttpRequest", MockXHR);

  mockCreateShareUploadUrl.mockResolvedValue({
    shareId: "pending-123",
    uploadUrl: "https://r2.example.com/upload/test",
  });

  mockConfirmShare.mockResolvedValue({
    shareId: "share-abc",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Helper: render SenderPage and bring it to a state where the submit button
// can be clicked (text entered + captcha solved).
// ---------------------------------------------------------------------------

async function renderAndPrepare() {
  render(React.createElement(SenderPage));

  const textarea = screen.getByRole("textbox", { name: /text content to share/i });
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "secret message" } });
  });

  const captcha = screen.getByTestId("hcaptcha-widget");
  await act(async () => {
    fireEvent.click(captcha);
  });

  return { textarea };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SenderPage — R2 upload retry flow", () => {
  it("shows an error message and a Retry Upload button when the R2 PUT returns a non-2xx status", async () => {
    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/R2 upload failed/i);
    expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
  });

  it("completes the share and shows the share URL when Retry Upload succeeds", async () => {
    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole("button", { name: /retry upload/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /^share link$/i })).toBeInTheDocument();
    });

    const shareLinkInput = screen.getByRole("textbox", { name: /^share link$/i }) as HTMLInputElement;
    expect(shareLinkInput.value).toContain("share-abc");
    expect(mockConfirmShare).toHaveBeenCalledWith({ shareId: "pending-123" });
  });

  it("shows an error and keeps the Retry Upload button when confirmShare fails after a successful PUT", async () => {
    // First PUT returns 500 → Retry Upload button appears.
    // Second PUT returns 200 → confirmShare is called and rejects.
    xhrResponseQueue = [500, 200];
    mockConfirmShare.mockRejectedValue(
      new Error("Server unavailable. Please try again.")
    );

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole("button", { name: /retry upload/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/Server unavailable/i);
    expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^share link$/i })).not.toBeInTheDocument();
  });

  it("calls createShareUploadUrl a second time and completes the upload when the presigned URL has expired", async () => {
    // The first PUT fails; before retrying we advance time past the 900 s expiry
    // window (with the built-in 30 s early-expiry buffer) so that handleRetryUpload
    // takes the urlExpired branch and fetches a fresh presigned URL.
    const realDateNow = Date.now();
    // Return a fresh shareId so we can verify the retry used it.
    mockCreateShareUploadUrl
      .mockResolvedValueOnce({
        shareId: "pending-123",
        uploadUrl: "https://r2.example.com/upload/initial",
      })
      .mockResolvedValueOnce({
        shareId: "pending-456",
        uploadUrl: "https://r2.example.com/upload/fresh",
      });

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Wait for the retry button — first PUT returned 500.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    });

    // Advance Date.now() beyond uploadUrlExpiresAt - 30_000 (i.e. > 870 s forward).
    vi.spyOn(Date, "now").mockReturnValue(realDateNow + 871_000);

    // When hCaptcha is configured, the expired-URL gate requires a fresh captcha
    // token before it will request a new presigned URL.  Solve the widget again
    // so the component has a valid token when Retry Upload is clicked.
    const captchaWidget = screen.queryByTestId("hcaptcha-widget");
    if (captchaWidget) {
      await act(async () => {
        fireEvent.click(captchaWidget);
      });
    }

    const retryBtn = screen.getByRole("button", { name: /retry upload/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /^share link$/i })).toBeInTheDocument();
    });

    // createShareUploadUrl should have been called once on submit and once on retry.
    expect(mockCreateShareUploadUrl).toHaveBeenCalledTimes(2);

    // confirmShare should use the fresh shareId returned by the second call.
    expect(mockConfirmShare).toHaveBeenCalledWith({ shareId: "pending-456" });

    const shareLinkInput = screen.getByRole("textbox", { name: /^share link$/i }) as HTMLInputElement;
    expect(shareLinkInput.value).toContain("share-abc");

    vi.restoreAllMocks();
  });

  it("keeps the Retry Upload button available when the retried upload also fails", async () => {
    xhrResponseQueue = [500, 500];

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole("button", { name: /retry upload/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/share link/i)).not.toBeInTheDocument();
  });
});
