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
const mockFileToBase64 = vi.fn().mockResolvedValue("base64filedata");

vi.mock("@workspace/api-client-react", () => ({
  useCreateShare: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestWebhook: () => ({ mutateAsync: vi.fn() }),
  createShareUploadUrl: mockCreateShareUploadUrl,
  confirmShare: mockConfirmShare,
}));

const mockEncryptPayload = vi.fn().mockResolvedValue("encrypted-payload-data");

vi.mock("@/lib/crypto", () => ({
  generateEncryptionKey: vi.fn().mockResolvedValue({
    key: {} as CryptoKey,
    rawKey: new Uint8Array(32),
    keyBase64Url: "test-key-base64url",
  }),
  encryptPayload: mockEncryptPayload,
  encryptKeyWithPassword: vi.fn().mockResolvedValue({
    encryptedKey: "encrypted-key-hash",
    salt: "test-salt",
  }),
  fileToBase64: mockFileToBase64,
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

  it("shows the captcha-required warning and keeps Retry Upload visible when clicking Retry before solving the captcha after URL expiry", async () => {
    // First PUT fails; captcha token is cleared by the error handler.
    const realDateNow = Date.now();

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Wait for the Retry Upload button — first PUT returned 500, captcha token cleared.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();
    });

    // Advance time past the presigned URL expiry window (> 870 s forward).
    vi.spyOn(Date, "now").mockReturnValue(realDateNow + 871_000);

    // Do NOT solve the captcha widget — captchaToken remains "".

    // Click Retry Upload without a valid captcha token.
    const retryBtn = screen.getByRole("button", { name: /retry upload/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    // The gate should fire and show the instructional warning.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your upload window has expired. Please complete the verification above, then click Retry Upload."
    );

    // Retry Upload button must still be present so the user can try again after solving captcha.
    expect(screen.getByRole("button", { name: /retry upload/i })).toBeInTheDocument();

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

// ---------------------------------------------------------------------------
// Helper: render SenderPage in file-upload mode with the given file names
// attached via the hidden file input.
// ---------------------------------------------------------------------------

async function renderInFilesMode(
  ...fileNames: string[]
): Promise<{ container: HTMLElement }> {
  const { container } = render(React.createElement(SenderPage));

  const filesTab = screen.getByRole("button", { name: /^files$/i });
  await act(async () => {
    fireEvent.click(filesTab);
  });

  const fileInput = container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement;
  const mockFiles = fileNames.map(
    (name) => new File(["x"], name, { type: "application/octet-stream" })
  );
  Object.defineProperty(fileInput, "files", {
    value: mockFiles,
    configurable: true,
  });
  await act(async () => {
    fireEvent.change(fileInput);
  });

  const captcha = screen.getByTestId("hcaptcha-widget");
  await act(async () => {
    fireEvent.click(captcha);
  });

  return { container };
}

// ---------------------------------------------------------------------------
// Tests: reading phase filename labels
// ---------------------------------------------------------------------------

describe("SenderPage — reading phase filename labels", () => {
  it("shows the filename while a single file is being read", async () => {
    let resolveRead!: (v: string) => void;
    mockFileToBase64.mockImplementationOnce(
      () => new Promise<string>((res) => { resolveRead = res; })
    );

    await renderInFilesMode("secret.pdf");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    expect(screen.getByText("Reading secret.pdf\u2026")).toBeInTheDocument();

    await act(async () => { resolveRead("base64filedata"); });
  });

  it("shows both filenames while two files are being read simultaneously", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const makeDeferred = (_file: File, onProg?: (loaded: number, total: number) => void) => {
      onProg?.(0, 100);
      return new Promise<string>((res) => { resolvers.push(res); });
    };
    mockFileToBase64.mockImplementationOnce(makeDeferred);
    mockFileToBase64.mockImplementationOnce(makeDeferred);

    await renderInFilesMode("alpha.jpg", "beta.mp4");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    expect(
      screen.getByText("Reading: alpha.jpg, beta.mp4\u2026")
    ).toBeInTheDocument();

    await act(async () => { resolvers.forEach((r) => r("base64filedata")); });
  });

  it("decrements the active-file counter as individual files finish reading", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const makeDeferred = (_file: File, onProg?: (loaded: number, total: number) => void) => {
      onProg?.(0, 100);
      return new Promise<string>((res) => { resolvers.push(res); });
    };
    mockFileToBase64.mockImplementationOnce(makeDeferred);
    mockFileToBase64.mockImplementationOnce(makeDeferred);
    mockFileToBase64.mockImplementationOnce(makeDeferred);

    await renderInFilesMode("alpha.jpg", "beta.mp4", "gamma.zip");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    expect(
      screen.getByText("Reading 3 files: alpha.jpg, beta.mp4, +1 more\u2026")
    ).toBeInTheDocument();

    await act(async () => { resolvers[0]("base64filedata"); });

    expect(
      screen.getByText("Reading: beta.mp4, gamma.zip\u2026")
    ).toBeInTheDocument();

    await act(async () => {
      resolvers[1]("base64filedata");
      resolvers[2]("base64filedata");
    });
  });

  it("replaces the reading label with Encrypting once all files have been read", async () => {
    let resolveEncrypt!: (v: string) => void;
    mockEncryptPayload.mockImplementationOnce(
      () => new Promise<string>((res) => { resolveEncrypt = res; })
    );

    await renderInFilesMode("document.txt");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.queryByText(/Reading document\.txt/)).not.toBeInTheDocument();
    });

    expect(screen.getByText("Encrypting\u2026")).toBeInTheDocument();

    await act(async () => { resolveEncrypt("encrypted-payload-data"); });
  });
});

// ---------------------------------------------------------------------------
// Tests: Cancel button during Reading and Encrypting phases
// ---------------------------------------------------------------------------

describe("SenderPage — Cancel button during file processing", () => {
  it("shows the Cancel button while a file is being read", async () => {
    // Keep the reading phase alive indefinitely so we can inspect the UI.
    mockFileToBase64.mockImplementationOnce(
      () => new Promise<string>(() => {})
    );

    await renderInFilesMode("large-file.bin");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    expect(
      screen.getByRole("button", { name: /cancel share creation/i })
    ).toBeInTheDocument();
  });

  it("clicking Cancel during the Reading phase resets the UI to the form state with no error", async () => {
    // Keep the reading phase alive indefinitely.
    mockFileToBase64.mockImplementationOnce(
      () => new Promise<string>(() => {})
    );

    await renderInFilesMode("large-file.bin");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    // Cancel button should be visible while reading.
    const cancelBtn = screen.getByRole("button", { name: /cancel share creation/i });
    await act(async () => { fireEvent.click(cancelBtn); });

    // Progress indicators should be gone.
    expect(screen.queryByText(/Reading/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Encrypting/)).not.toBeInTheDocument();

    // No error message.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Submit button should be available again.
    expect(
      screen.getByRole("button", { name: /create secure share/i })
    ).toBeInTheDocument();
  });

  it("clicking Cancel during the Encrypting phase resets the UI to the form state with no error", async () => {
    // Let reading finish instantly but keep encryption alive indefinitely.
    mockEncryptPayload.mockImplementationOnce(
      () => new Promise<string>(() => {})
    );

    await renderInFilesMode("large-file.bin");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    // Wait for the Encrypting phase to start.
    await waitFor(() => {
      expect(screen.getByText("Encrypting\u2026")).toBeInTheDocument();
    });

    const cancelBtn = screen.getByRole("button", { name: /cancel share creation/i });
    await act(async () => { fireEvent.click(cancelBtn); });

    // Encrypting label should be gone.
    expect(screen.queryByText("Encrypting\u2026")).not.toBeInTheDocument();

    // No error message.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Submit button should be available again.
    expect(
      screen.getByRole("button", { name: /create secure share/i })
    ).toBeInTheDocument();
  });

  it("preserves the attached file list after cancelling", async () => {
    // Keep the reading phase alive indefinitely.
    mockFileToBase64.mockImplementationOnce(
      () => new Promise<string>(() => {})
    );

    await renderInFilesMode("report.pdf");

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    const cancelBtn = screen.getByRole("button", { name: /cancel share creation/i });
    await act(async () => { fireEvent.click(cancelBtn); });

    // The file name should still be visible in the file list.
    expect(screen.getByText("report.pdf")).toBeInTheDocument();

    // And we should be back to the form state (no progress indicators).
    expect(screen.queryByText(/Reading/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Encrypting, Uploading, and Confirming progress labels
// ---------------------------------------------------------------------------

describe("SenderPage — Encrypting, Uploading, and Confirming phase labels", () => {
  it("shows Encrypting… while encryptPayload is in-flight", async () => {
    // Keep encryption pending indefinitely so we can inspect the label.
    mockEncryptPayload.mockImplementationOnce(
      () => new Promise<string>(() => {})
    );

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText("Encrypting\u2026")).toBeInTheDocument();
    });
  });

  it("shows Uploading… while the XHR PUT is in-flight", async () => {
    // Replace XHR with a version whose send() never fires onload so the
    // uploading phase stays visible indefinitely.
    class NeverResolvingXHR {
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
        // Intentionally does not call onload — keeps the upload in-flight.
      }
    }
    vi.stubGlobal("XMLHttpRequest", NeverResolvingXHR);

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText("Uploading\u2026")).toBeInTheDocument();
    });
  });

  it("shows Confirming… while confirmShare is in-flight", async () => {
    // XHR returns 200 immediately; confirmShare never resolves.
    xhrResponseQueue = [200];
    mockConfirmShare.mockImplementationOnce(
      () => new Promise(() => {})
    );

    await renderAndPrepare();

    const submitBtn = screen.getByRole("button", { name: /create secure share/i });
    act(() => { fireEvent.click(submitBtn); });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText("Confirming\u2026")).toBeInTheDocument();
    });
  });
});
