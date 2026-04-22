import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  useCreateShare,
  useTestWebhook,
  createShareUploadUrl,
  confirmShare,
} from "@workspace/api-client-react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import {
  generateEncryptionKey,
  encryptPayload,
  encryptKeyWithPassword,
  fileToBase64,
  type SharePayload,
} from "@/lib/crypto";
import {
  formatBytes,
  formatDuration,
  TTL_OPTIONS,
  generatePassword,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useTheme } from "@/components/theme-provider";
import { Switch } from "@/components/ui/switch";

const HCAPTCHA_SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY as string | undefined;

/**
 * When VITE_USE_R2_UPLOADS=true (set in Cloudflare Pages dashboard), the
 * sender uses the presigned R2 direct-upload path for all shares, enabling
 * files up to 420 MB. Falls back to the inline KV path otherwise.
 */
const USE_R2_UPLOADS = import.meta.env.VITE_USE_R2_UPLOADS === "true";

const MAX_TOTAL_BYTES = USE_R2_UPLOADS
  ? 420 * 1024 * 1024   // 420 MB — R2 direct-upload path
  : 2.5 * 1024 * 1024;  // 2.5 MB — inline KV path; matches Express dev server limit
const MAX_FILES = 10;

interface FileItem {
  file: File;
  id: string;
  name: string;
  preview?: string;
}

/**
 * Saved context for retrying a failed R2 PUT without re-encrypting.
 * The large ciphertext is stored in a separate ref (r2EncryptedDataRef)
 * to avoid triggering unnecessary React re-renders.
 */
interface R2RetryContext {
  pendingId: string;
  uploadUrl: string;
  /** Unix ms — presigned PUT URL becomes invalid after this time. */
  uploadUrlExpiresAt: number;
  /** URL fragment key (raw key or encrypted key) for building the share URL. */
  keyForUrl: string;
  /** Params needed to re-request a new presigned URL when the old one expires. */
  shareParams: {
    ttl: number;
    shareType: "text" | "files";
    totalSize: number;
    passwordHash: string | null;
    passwordSalt: string | null;
    webhookUrl: string | null;
    webhookMessage: string | null;
    fileMetadata: Array<{ name: string; size: number; type: string; originalIndex: number }> | null;
  };
}

function TtlPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {TTL_OPTIONS.map((opt) => (
        <motion.button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.97 }}
          className={`px-3 py-2 border text-sm font-mono transition-all ${
            value === opt.value
              ? "bg-primary text-primary-foreground border-primary shadow-[0_0_12px_rgba(0,255,255,0.3)]"
              : "bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
          }`}
        >
          {opt.label}
        </motion.button>
      ))}
    </div>
  );
}

function CountdownDisplay({
  expiresAt,
  shareUrl,
  onCreateNew,
}: {
  expiresAt: string;
  shareUrl: string;
  onCreateNew: () => void;
}) {
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const update = () => {
      const diff = Math.max(
        0,
        Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
      );
      setRemaining(diff);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="border border-primary/30 bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-primary font-mono text-sm">
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="w-2 h-2 rounded-full bg-primary"
          />
          SHARE ACTIVE
        </div>

        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-widest mb-2 block">
            Share Link (copy before closing)
          </Label>
          <div className="flex gap-2">
            <input
              readOnly
              value={shareUrl}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              className="flex-1 bg-muted border border-border font-mono text-xs p-2 text-foreground truncate cursor-text"
              aria-label="Share link"
            />
            <Button
              type="button"
              onClick={handleCopy}
              className="shrink-0 font-mono text-xs"
              aria-label="Copy share link"
            >
              {copied ? "COPIED" : "COPY"}
            </Button>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">
            Expires in
          </div>
          <motion.div
            key={remaining}
            initial={{ opacity: 0.5 }}
            animate={{ opacity: 1 }}
            className="font-mono text-3xl text-primary tabular-nums"
          >
            {formatDuration(remaining)}
          </motion.div>
        </div>

        <div className="text-xs text-muted-foreground border-t border-border pt-3 flex items-start gap-2">
          <span className="text-amber-500">⚠</span>
          The encryption key is embedded in the link. If the server restarts,
          your share is lost. Share the link via a secure channel.
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={onCreateNew}
        className="w-full font-mono"
      >
        Create Another Share
      </Button>
    </motion.div>
  );
}

export default function SenderPage() {
  const [mode, setMode] = useState<"text" | "files">("text");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [ttl, setTtl] = useState(3600);
  const [passwordEnabled, setPasswordEnabled] = useState(true);
  const [password, setPassword] = useState(() => generatePassword());
  const [webhookExpanded, setWebhookExpanded] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookMessage, setWebhookMessage] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [shareCreated, setShareCreated] = useState(false);
  const [error, setError] = useState("");
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0);
  const [pwCopied, setPwCopied] = useState(false);
  const [webhookTested, setWebhookTested] = useState<null | boolean>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [encryptProgress, setEncryptProgress] = useState(0);
  const [readProgress, setReadProgress] = useState(0);
  const [activeReadingFiles, setActiveReadingFiles] = useState<string[]>([]);
  const activeReadingSetRef = useRef<Set<number>>(new Set());
  const [uploadPhase, setUploadPhase] = useState<null | "reading" | "encrypting" | "uploading" | "confirming">(null);
  /** Metadata for retrying a failed R2 PUT without re-encrypting. */
  const [r2RetryContext, setR2RetryContext] = useState<R2RetryContext | null>(null);
  /** Holds the encrypted ciphertext for retry — stored in a ref to avoid heavy re-renders. */
  const r2EncryptedDataRef = useRef<string | null>(null);
  /** AbortController for the active reading/encrypting operation. */
  const cancelControllerRef = useRef<AbortController | null>(null);
  /** Monotonically increasing counter; incremented on each new attempt so stale async tails can self-discard. */
  const attemptIdRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captchaRef = useRef<HCaptcha>(null);

  const { theme } = useTheme();
  const captchaTheme: "dark" | "light" =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : (theme as "dark" | "light");

  const createShare = useCreateShare();
  const testWebhook = useTestWebhook();

  useEffect(() => {
    if (rateLimitSeconds <= 0) return;
    const id = setInterval(() => {
      setRateLimitSeconds((s) => {
        if (s <= 1) { clearInterval(id); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [rateLimitSeconds]);

  // Clear retry context whenever the shareable content changes so that the
  // "Retry Upload" button can never re-upload stale ciphertext.
  useEffect(() => {
    if (r2RetryContext) {
      setR2RetryContext(null);
      r2EncryptedDataRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, files, password, passwordEnabled]);

  const totalSize =
    mode === "text"
      ? new TextEncoder().encode(text).length
      : files.reduce((acc, f) => acc + f.file.size, 0);

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      const fileArray = Array.from(newFiles);
      if (files.length + fileArray.length > MAX_FILES) {
        setError(`Maximum ${MAX_FILES} files per share.`);
        return;
      }
      const newTotal =
        files.reduce((a, f) => a + f.file.size, 0) +
        fileArray.reduce((a, f) => a + f.size, 0);
      if (newTotal > MAX_TOTAL_BYTES) {
        setError(`Total payload exceeds ${formatBytes(MAX_TOTAL_BYTES)} limit.`);
        return;
      }
      setError("");
      const newItems: FileItem[] = fileArray.map((file) => ({
        file,
        id: crypto.randomUUID(),
        name: file.name,
        preview:
          file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : undefined,
      }));
      setFiles((prev) => [...prev, ...newItems]);
    },
    [files]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const f = prev.find((f) => f.id === id);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter((f) => f.id !== id);
    });
  };

  const startRename = (id: string, currentName: string) => {
    setRenaming(id);
    setRenameValue(currentName);
  };

  const commitRename = () => {
    if (renaming) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === renaming ? { ...f, name: renameValue || f.name } : f
        )
      );
      setRenaming(null);
    }
  };

  const handleTestWebhook = async () => {
    if (!webhookUrl) return;
    try {
      const res = await testWebhook.mutateAsync({ data: { webhookUrl } });
      setWebhookTested(res.success);
    } catch {
      setWebhookTested(false);
    }
  };

  const handleCancel = () => {
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setUploadPhase(null);
    setReadProgress(0);
    setEncryptProgress(0);
    setActiveReadingFiles([]);
    activeReadingSetRef.current = new Set();
  };

  const handleCreateShare = async () => {
    setError("");
    // Always start fresh — discard any leftover retry context from a previous attempt.
    setR2RetryContext(null);
    r2EncryptedDataRef.current = null;
    // Create a fresh AbortController for this attempt and stamp a unique ID
    // so that any stale async tail from a previous attempt can self-discard.
    const attemptId = ++attemptIdRef.current;
    const cancelController = new AbortController();
    cancelControllerRef.current = cancelController;
    const signal = cancelController.signal;
    if (mode === "text" && !text.trim()) {
      setError("Please enter some text to share.");
      return;
    }
    if (mode === "files" && files.length === 0) {
      setError("Please add at least one file.");
      return;
    }
    if (passwordEnabled && (password.length < 14 || password.length > 256)) {
      setError("Password must be 14–256 characters.");
      return;
    }
    if (totalSize > MAX_TOTAL_BYTES) {
      setError(`Total payload exceeds ${formatBytes(MAX_TOTAL_BYTES)} limit.`);
      return;
    }

    try {
      // Build payload
      let payload: SharePayload;
      if (mode === "text") {
        payload = { type: "text", text };
      } else {
        // ── Reading phase: track per-file FileReader progress in aggregate ──
        setUploadPhase("reading");
        setReadProgress(0);
        // Pre-populate with the first file so a name is shown immediately for
        // single-file reads and before the first onprogress event fires.
        setActiveReadingFiles(files.length > 0 ? [files[0].name] : []);
        activeReadingSetRef.current = files.length > 0 ? new Set([0]) : new Set();

        const totalFileBytes = files.reduce((a, f) => a + f.file.size, 0);
        // Per-file loaded/total counters updated by FileReader.onprogress callbacks
        const fileLoaded = files.map(() => 0);
        const fileTotal = files.map((f) => f.file.size);

        const updateReadProgress = (activeIdx?: number, markDone?: boolean) => {
          const loaded = fileLoaded.reduce((a, v) => a + v, 0);
          const total = fileTotal.reduce((a, v) => a + v, 0) || totalFileBytes || 1;
          setReadProgress(Math.round((loaded / total) * 100));
          if (activeIdx !== undefined) {
            if (markDone) {
              activeReadingSetRef.current.delete(activeIdx);
            } else {
              activeReadingSetRef.current.add(activeIdx);
            }
            const activeNames = [...activeReadingSetRef.current].map((i) => files[i].name);
            setActiveReadingFiles(activeNames);
          }
        };

        const fileData = await Promise.all(
          files.map(async (fi, idx) => {
            const data = await fileToBase64(fi.file, (loaded, total) => {
              fileLoaded[idx] = loaded;
              fileTotal[idx] = total;
              updateReadProgress(idx);
            }, signal);
            // Mark this file as fully loaded in case onprogress wasn't fired at 100%
            fileLoaded[idx] = fi.file.size;
            updateReadProgress(idx, true);
            return { name: fi.name, size: fi.file.size, type: fi.file.type, data };
          })
        );

        setReadProgress(100);
        payload = { type: "files", files: fileData };
      }

      // ── Encrypting phase: real chunked AES-GCM with accurate progress ──
      setUploadPhase("encrypting");
      setEncryptProgress(0);

      const { key, rawKey, keyBase64Url } = await generateEncryptionKey();
      const encryptedData = await encryptPayload(
        payload,
        key,
        (bytesEncrypted, totalBytes) => {
          setEncryptProgress(Math.round((bytesEncrypted / totalBytes) * 100));
        },
        signal
      );
      setEncryptProgress(100);
      // Brief pause so users can see the completed encryption step
      await new Promise<void>((r) => setTimeout(r, 150));

      let passwordHash: string | null = null;
      let passwordSalt: string | null = null;

      if (passwordEnabled) {
        const { encryptedKey, salt } = await encryptKeyWithPassword(
          rawKey,
          password
        );
        passwordHash = encryptedKey;
        passwordSalt = salt;
      }

      const shareType = mode === "text" ? "text" : "files";
      const fileMeta = mode === "files"
        ? files.map((fi, i) => ({ name: fi.name, size: fi.file.size, type: fi.file.type, originalIndex: i }))
        : null;

      // Compute keyForUrl here (before the R2 block) so it can be saved in the
      // retry context — the retry function needs it to build the share URL on success.
      const keyForUrl = passwordEnabled && passwordHash
        ? encodeURIComponent(passwordHash)
        : keyBase64Url;

      let result: { shareId: string; expiresAt: string };

      if (USE_R2_UPLOADS) {
        // ── R2 direct-upload path ──────────────────────────────────────────
        // 1. Request a presigned PUT URL from the Worker.
        const { shareId: pendingId, uploadUrl } = await createShareUploadUrl({
          ttl,
          shareType,
          totalSize,
          passwordHash,
          passwordSalt,
          webhookUrl: webhookUrl || null,
          webhookMessage: webhookMessage || null,
          fileMetadata: fileMeta,
          captchaToken: captchaToken || undefined,
        });

        // Save retry context immediately after getting the presigned URL.
        // This lets the "Retry Upload" button re-use the same URL (or re-request
        // a new one) without re-encrypting the payload from scratch.
        r2EncryptedDataRef.current = encryptedData;
        setR2RetryContext({
          pendingId,
          uploadUrl,
          // TODO: prefer a server-returned expiry (e.g. `uploadUrlExpiresAt` in the
          // UploadUrlResponse) so this stays in sync if the backend TTL changes.
          uploadUrlExpiresAt: Date.now() + 900_000, // mirrors r2sign.ts expiresIn: 900
          keyForUrl,
          shareParams: {
            ttl, shareType, totalSize, passwordHash, passwordSalt,
            webhookUrl: webhookUrl || null,
            webhookMessage: webhookMessage || null,
            fileMetadata: fileMeta,
          },
        });

        // 2. PUT the encrypted ciphertext directly to R2 via XHR (exposes upload progress).
        // Uses a nested try/catch so that XHR failures surface as a "Retry Upload" button
        // rather than falling through to the outer catch that clears all state.
        setUploadPhase("uploading");
        setUploadProgress(0);
        try {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                setUploadProgress(Math.round((e.loaded / e.total) * 100));
              }
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                setUploadProgress(100);
                resolve();
              } else {
                reject(new Error(`R2 upload failed (status ${xhr.status}). Please try again.`));
              }
            };
            xhr.onerror = () => reject(new Error("R2 upload failed. Please try again."));
            xhr.onabort = () => reject(new Error("Upload was cancelled. Please try again."));
            xhr.ontimeout = () => reject(new Error("Upload timed out. Check your connection and try again."));
            xhr.open("PUT", uploadUrl);
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            xhr.send(encryptedData);
          });
        } catch (r2Err) {
          // XHR PUT failed — keep r2RetryContext so "Retry Upload" button is shown.
          captchaRef.current?.resetCaptcha();
          setCaptchaToken("");
          setUploadPhase(null);
          setError((r2Err as Error).message ?? "Upload failed. Use the Retry Upload button below to try again.");
          return;
        }

        // 3. Confirm the upload — Worker verifies the R2 object exists and activates the share.
        setUploadPhase("confirming");
        result = await confirmShare({ shareId: pendingId });

        // Success — clear retry context and ciphertext ref.
        setR2RetryContext(null);
        r2EncryptedDataRef.current = null;
      } else {
        // ── Inline KV path (dev / legacy) ─────────────────────────────────
        result = await createShare.mutateAsync({
          data: {
            encryptedData,
            ttl,
            passwordHash,
            passwordSalt,
            webhookUrl: webhookUrl || null,
            webhookMessage: webhookMessage || null,
            fileMetadata: fileMeta,
            shareType,
            totalSize,
            captchaToken: captchaToken,
          },
        });
      }

      // Discard if a newer attempt has already started (stale cancel race guard).
      if (attemptIdRef.current !== attemptId) return;
      cancelControllerRef.current = null;
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      setUploadPhase(null);

      // keyForUrl was already computed above before the R2 block; use it directly.
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const url = `${window.location.origin}${base}/share/${result.shareId}#key=${keyForUrl}`;
      setShareUrl(url);
      setExpiresAt(result.expiresAt);
      setShareCreated(true);
    } catch (err: unknown) {
      // Discard this tail if a newer attempt has already started (stale cancel race guard).
      if (attemptIdRef.current !== attemptId) return;

      cancelControllerRef.current = null;
      // AbortError means the user clicked Cancel — reset silently with no error message.
      if ((err as { name?: string }).name === "AbortError") {
        setUploadPhase(null);
        setReadProgress(0);
        setEncryptProgress(0);
        setActiveReadingFiles([]);
        activeReadingSetRef.current = new Set();
        return;
      }
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      setUploadPhase(null);
      // For non-XHR errors (rate limit, createShareUploadUrl failures, etc.),
      // clear the retry context — there's nothing to retry at the PUT level.
      setR2RetryContext(null);
      r2EncryptedDataRef.current = null;
      // ApiError (from generated client) stores the parsed body in .data;
      // legacy raw-fetch errors store it in .response.data.
      type ErrData = { retryAfterSeconds?: number; message?: string };
      const errData: ErrData | undefined =
        (err as { data?: ErrData }).data ??
        (err as { response?: { data?: ErrData } }).response?.data;
      if (errData?.retryAfterSeconds) {
        setRateLimitSeconds(errData.retryAfterSeconds);
        setError("");
      } else {
        setError(errData?.message ?? "Failed to create share. Please try again.");
      }
    }
  };

  // Retries a failed R2 upload using the stored encrypted ciphertext.
  // Re-uses the presigned URL if it hasn't expired; otherwise re-requests one.
  // When the URL has expired AND captcha is configured, a fresh captcha token
  // must be solved first — this function checks for that and returns early with
  // an instructional error so the user can solve the widget and click again.
  const handleRetryUpload = async () => {
    if (!r2RetryContext || !r2EncryptedDataRef.current) return;
    setError("");

    let { pendingId, uploadUrl } = r2RetryContext;
    const { uploadUrlExpiresAt, keyForUrl, shareParams } = r2RetryContext;

    const urlExpired = Date.now() >= uploadUrlExpiresAt - 30_000;

    // Gate: if the presigned URL has expired AND captcha is required, we need a
    // fresh captcha token before we can request a new URL.  Tell the user to
    // solve the widget above and try again — do not clear the retry context.
    if (urlExpired && HCAPTCHA_SITE_KEY && !captchaToken) {
      setError(
        "Your upload window has expired. Please complete the verification above, then click Retry Upload."
      );
      return;
    }

    setUploadPhase("uploading");
    setUploadProgress(0);

    try {
      // If the presigned URL is within 30 s of expiry (or already past), request a fresh one.
      if (urlExpired) {
        const fresh = await createShareUploadUrl({
          ...shareParams,
          captchaToken: captchaToken || undefined,
        });
        // Captcha token is single-use — reset it now that we've consumed it.
        captchaRef.current?.resetCaptcha();
        setCaptchaToken("");
        pendingId = fresh.shareId;
        uploadUrl = fresh.uploadUrl;
        setR2RetryContext({
          ...r2RetryContext,
          pendingId,
          uploadUrl,
          uploadUrlExpiresAt: Date.now() + 900_000, // mirrors r2sign.ts expiresIn: 900
        });
      }

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            resolve();
          } else {
            reject(new Error(`R2 upload failed (status ${xhr.status}). Please try again.`));
          }
        };
        xhr.onerror = () => reject(new Error("R2 upload failed. Please check your connection and try again."));
        xhr.onabort = () => reject(new Error("Upload was cancelled. Please try again."));
        xhr.ontimeout = () => reject(new Error("Upload timed out. Check your connection and try again."));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.send(r2EncryptedDataRef.current!);
      });

      setUploadPhase("confirming");
      const result = await confirmShare({ shareId: pendingId });

      // Success — clear retry context and build share URL.
      setR2RetryContext(null);
      r2EncryptedDataRef.current = null;
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      setUploadPhase(null);

      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const url = `${window.location.origin}${base}/share/${result.shareId}#key=${keyForUrl}`;
      setShareUrl(url);
      setExpiresAt(result.expiresAt);
      setShareCreated(true);
    } catch (err: unknown) {
      // Captcha token is single-use; reset on any failure to force a fresh solve.
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      setUploadPhase(null);
      // Keep r2RetryContext on failure so the button remains available.
      const errData = (err as { data?: { message?: string } }).data;
      setError(errData?.message ?? (err as Error).message ?? "Retry failed. Please try again.");
    }
  };

  const handleCreateNew = () => {
    setShareCreated(false);
    setShareUrl("");
    setExpiresAt("");
    setText("");
    setFiles([]);
    setPassword(generatePassword());
    setError("");
    setCaptchaToken("");
    captchaRef.current?.resetCaptcha();
    setR2RetryContext(null);
    r2EncryptedDataRef.current = null;
  };

  const copyPassword = async () => {
    await navigator.clipboard.writeText(password);
    setPwCopied(true);
    setTimeout(() => setPwCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 border border-primary flex items-center justify-center">
            <div className="w-3 h-3 bg-primary" />
          </div>
          <div>
            <div className="font-mono text-sm font-bold tracking-widest text-foreground">
              VAULTDROP
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              zero-knowledge file sharing
            </div>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        <AnimatePresence mode="wait">
          {shareCreated ? (
            <motion.div
              key="created"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <CountdownDisplay
                expiresAt={expiresAt}
                shareUrl={shareUrl}
                onCreateNew={handleCreateNew}
              />
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-6"
            >
              {/* Restart warning */}
              <div className="border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs font-mono text-amber-400 flex items-start gap-2">
                <span>⚠</span>
                <span>
                  Data is ephemeral — if the server restarts, your share is
                  lost. This is by design.
                </span>
              </div>

              {/* Rate limit */}
              <AnimatePresence>
                {rateLimitSeconds > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="border border-border bg-card p-6 text-center space-y-3"
                  >
                    <div className="font-mono text-muted-foreground text-sm">
                      We're busy right now. Please wait...
                    </div>
                    <motion.div
                      key={rateLimitSeconds}
                      initial={{ scale: 1.1 }}
                      animate={{ scale: 1 }}
                      className="font-mono text-4xl tabular-nums text-primary"
                    >
                      {rateLimitSeconds}s
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Mode tabs */}
              <div className="flex border border-border">
                {(["text", "files"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 py-3 font-mono text-sm uppercase tracking-widest transition-colors ${
                      mode === m
                        ? "bg-primary text-primary-foreground"
                        : "bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              {/* Content area */}
              <AnimatePresence mode="wait">
                {mode === "text" ? (
                  <motion.div
                    key="text"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-2"
                  >
                    <Textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Paste your secret text here..."
                      className="min-h-[200px] font-mono text-sm resize-none bg-card border-border"
                      aria-label="Text content to share"
                    />
                    <div className="text-xs text-muted-foreground text-right font-mono">
                      {text.length.toLocaleString()} chars /{" "}
                      {formatBytes(new TextEncoder().encode(text).length)} /{" "}
                      {formatBytes(MAX_TOTAL_BYTES)} max
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="files"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-4"
                  >
                    {/* Drop zone */}
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
                        dragOver
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                      role="button"
                      tabIndex={0}
                      aria-label="Drop files here or click to browse"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          fileInputRef.current?.click();
                      }}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) =>
                          e.target.files && addFiles(e.target.files)
                        }
                        aria-hidden="true"
                      />
                      <div className="font-mono text-sm text-muted-foreground space-y-1">
                        <div className="text-2xl">↓</div>
                        <div>Drop files here or click to browse</div>
                        <div className="text-xs">
                          Up to {MAX_FILES} files, {formatBytes(MAX_TOTAL_BYTES)} total
                        </div>
                      </div>
                    </div>

                    {/* File list */}
                    <AnimatePresence>
                      {files.map((fi) => (
                        <motion.div
                          key={fi.id}
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="border border-border bg-card p-3 flex items-center gap-3"
                        >
                          {fi.preview ? (
                            <img
                              src={fi.preview}
                              alt={fi.name}
                              className="w-12 h-16 object-cover shrink-0 border border-border"
                            />
                          ) : (
                            <div className="w-12 h-16 border border-border bg-muted flex items-center justify-center text-xs font-mono text-muted-foreground shrink-0 uppercase">
                              {fi.file.name.split(".").pop()?.slice(0, 3) ?? "?"}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            {renaming === fi.id ? (
                              <input
                                autoFocus
                                className="w-full bg-background border border-primary font-mono text-sm px-2 py-1 text-foreground"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={commitRename}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitRename();
                                  if (e.key === "Escape") setRenaming(null);
                                }}
                                aria-label={`Rename file ${fi.name}`}
                              />
                            ) : (
                              <div
                                className="font-mono text-sm truncate cursor-text"
                                onClick={() => startRename(fi.id, fi.name)}
                                title="Click to rename"
                              >
                                {fi.name}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground font-mono">
                              {formatBytes(fi.file.size)} · {fi.file.type || "unknown"}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFile(fi.id)}
                            className="text-muted-foreground hover:text-destructive font-mono text-xs p-2 transition-colors"
                            aria-label={`Remove file ${fi.name}`}
                          >
                            ✕
                          </button>
                        </motion.div>
                      ))}
                    </AnimatePresence>

                    {files.length > 0 && (
                      <div className="text-xs text-muted-foreground font-mono text-right">
                        {files.length} file{files.length !== 1 ? "s" : ""} ·{" "}
                        {formatBytes(totalSize)} / {formatBytes(MAX_TOTAL_BYTES)}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* TTL Picker */}
              <div className="space-y-3">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Time to Live
                </Label>
                <TtlPicker value={ttl} onChange={setTtl} />
              </div>

              {/* Password */}
              <div className="space-y-3 border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <Label className="font-mono text-xs uppercase tracking-widest">
                    Password Protection
                  </Label>
                  <Switch
                    checked={passwordEnabled}
                    onCheckedChange={setPasswordEnabled}
                    aria-label="Toggle password protection"
                  />
                </div>

                <AnimatePresence>
                  {passwordEnabled && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-2"
                    >
                      <div className="flex gap-2">
                        <Input
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="font-mono text-sm bg-background"
                          aria-label="Share password"
                          minLength={14}
                          maxLength={256}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={copyPassword}
                          className="shrink-0 font-mono text-xs"
                          aria-label="Copy password"
                        >
                          {pwCopied ? "✓" : "Copy"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setPassword(generatePassword())}
                          className="shrink-0 font-mono text-xs"
                          aria-label="Generate new password"
                        >
                          ↻
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        {password.length} chars · Share this password separately
                        via a secure channel
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Webhook */}
              <div className="border border-border">
                <button
                  type="button"
                  onClick={() => setWebhookExpanded((v) => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left text-xs font-mono text-muted-foreground hover:text-foreground transition-colors uppercase tracking-widest"
                  aria-expanded={webhookExpanded}
                >
                  <span>Webhook Notification (Optional)</span>
                  <span>{webhookExpanded ? "−" : "+"}</span>
                </button>
                <AnimatePresence>
                  {webhookExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 space-y-3 border-t border-border">
                        <p className="text-xs text-muted-foreground font-mono pt-3">
                          Fire-and-forget POST to your URL when the receiver accesses the share.
                          No retry. No failure notification.
                        </p>
                        <div className="flex gap-2">
                          <Input
                            value={webhookUrl}
                            onChange={(e) => {
                              setWebhookUrl(e.target.value);
                              setWebhookTested(null);
                            }}
                            placeholder="https://hooks.example.com/..."
                            className="font-mono text-sm bg-background"
                            aria-label="Webhook URL"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleTestWebhook}
                            disabled={!webhookUrl || testWebhook.isPending}
                            className="shrink-0 font-mono text-xs"
                            aria-label="Test webhook"
                          >
                            {testWebhook.isPending ? "..." : "Test"}
                          </Button>
                        </div>
                        {webhookTested !== null && (
                          <div
                            className={`text-xs font-mono ${webhookTested ? "text-primary" : "text-destructive"}`}
                          >
                            {webhookTested
                              ? "Webhook responded successfully."
                              : "Webhook test failed. Check the URL."}
                          </div>
                        )}
                        <Input
                          value={webhookMessage}
                          onChange={(e) => setWebhookMessage(e.target.value)}
                          placeholder='Custom message (default: "your submission has been downloaded at [date/time]")'
                          className="font-mono text-sm bg-background"
                          aria-label="Webhook custom message"
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Error */}
              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-2"
                  >
                    <div
                      className="border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm font-mono text-destructive"
                      role="alert"
                    >
                      {error}
                    </div>
                    {r2RetryContext && !uploadPhase && (
                      <button
                        type="button"
                        onClick={handleRetryUpload}
                        className="w-full rounded-md border border-amber-500/60 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-400"
                      >
                        Retry Upload
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* hCaptcha widget */}
              {HCAPTCHA_SITE_KEY && (
                <div className="flex justify-center" aria-label="Human verification">
                  <HCaptcha
                    ref={captchaRef}
                    sitekey={HCAPTCHA_SITE_KEY}
                    theme={captchaTheme}
                    onVerify={(token) => setCaptchaToken(token)}
                    onExpire={() => setCaptchaToken("")}
                    onError={() => setCaptchaToken("")}
                  />
                </div>
              )}

              {/* Progress indicator — shown during reading, encrypting, uploading, and confirming */}
              <AnimatePresence>
                {uploadPhase !== null && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="border border-primary/30 bg-card p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between font-mono text-xs text-muted-foreground uppercase tracking-widest">
                      <span className="truncate mr-2 min-w-0 flex-1">
                        {uploadPhase === "reading"
                          ? activeReadingFiles.length === 0
                            ? "Reading files…"
                            : activeReadingFiles.length === 1
                            ? `Reading ${activeReadingFiles[0]}…`
                            : activeReadingFiles.length === 2
                            ? `Reading: ${activeReadingFiles[0]}, ${activeReadingFiles[1]}…`
                            : `Reading ${activeReadingFiles.length} files: ${activeReadingFiles[0]}, ${activeReadingFiles[1]}, +${activeReadingFiles.length - 2} more…`
                          : uploadPhase === "encrypting"
                          ? "Encrypting…"
                          : uploadPhase === "uploading"
                          ? "Uploading…"
                          : "Confirming…"}
                      </span>
                      <span className="text-primary tabular-nums mr-2">
                        {uploadPhase === "reading"
                          ? `${readProgress}%`
                          : uploadPhase === "encrypting"
                          ? `${encryptProgress}%`
                          : uploadPhase === "uploading"
                          ? `${uploadProgress}%`
                          : ""}
                      </span>
                      {(uploadPhase === "reading" || uploadPhase === "encrypting") && (
                        <button
                          type="button"
                          onClick={handleCancel}
                          className="shrink-0 font-mono text-xs px-2 py-1 border border-border text-muted-foreground hover:border-destructive/60 hover:text-destructive transition-colors"
                          aria-label="Cancel share creation"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1 items-center">
                      {/* Step 1: Read bar — only shown in file mode */}
                      {mode === "files" && (
                        <>
                          <div className="flex-1 h-2 bg-muted overflow-hidden">
                            <motion.div
                              className="h-full bg-primary"
                              initial={{ width: "0%" }}
                              animate={{
                                width:
                                  uploadPhase === "reading"
                                    ? `${readProgress}%`
                                    : "100%",
                              }}
                              transition={{ ease: "linear", duration: 0.1 }}
                            />
                          </div>
                          <div className="w-px h-4 bg-border shrink-0" />
                        </>
                      )}
                      {/* Step 2 (or 1 in text mode): Encrypt bar */}
                      <div className="flex-1 h-2 bg-muted overflow-hidden">
                        <motion.div
                          className="h-full bg-primary"
                          initial={{ width: "0%" }}
                          animate={{
                            width:
                              uploadPhase === "reading"
                                ? "0%"
                                : uploadPhase === "encrypting"
                                ? `${encryptProgress}%`
                                : "100%",
                          }}
                          transition={{ ease: "linear", duration: 0.1 }}
                        />
                      </div>
                      <div className="w-px h-4 bg-border shrink-0" />
                      {/* Step 3 (or 2): Upload bar */}
                      <div className="flex-[2] h-2 bg-muted overflow-hidden">
                        <motion.div
                          className="h-full bg-primary"
                          initial={{ width: "0%" }}
                          animate={{
                            width:
                              uploadPhase === "uploading"
                                ? `${uploadProgress}%`
                                : uploadPhase === "confirming"
                                ? "100%"
                                : "0%",
                          }}
                          transition={{ ease: "linear", duration: 0.15 }}
                        />
                      </div>
                      <div className="w-px h-4 bg-border shrink-0" />
                      {/* Step 4 (or 3): Confirm indicator */}
                      <div className="w-8 h-2 bg-muted overflow-hidden shrink-0">
                        <motion.div
                          className="h-full bg-primary"
                          initial={{ width: "0%" }}
                          animate={{
                            width: uploadPhase === "confirming" ? "100%" : "0%",
                          }}
                          transition={{ ease: "linear", duration: 0.4 }}
                        />
                      </div>
                    </div>
                    <div className="flex font-mono text-xs text-muted-foreground gap-1 flex-wrap">
                      {mode === "files" && (
                        <>
                          <span
                            className={
                              uploadPhase === "reading"
                                ? "text-primary"
                                : "text-foreground"
                            }
                          >
                            1. Read
                          </span>
                          <span className="mx-1">·</span>
                        </>
                      )}
                      <span
                        className={
                          uploadPhase === "encrypting"
                            ? "text-primary"
                            : uploadPhase === "uploading" || uploadPhase === "confirming"
                            ? "text-foreground"
                            : ""
                        }
                      >
                        {mode === "files" ? "2. Encrypt" : "1. Encrypt"}
                      </span>
                      <span className="mx-1">·</span>
                      <span
                        className={
                          uploadPhase === "uploading"
                            ? "text-primary"
                            : uploadPhase === "confirming"
                            ? "text-foreground"
                            : ""
                        }
                      >
                        {mode === "files" ? "3. Upload" : "2. Upload"}
                      </span>
                      <span className="mx-1">·</span>
                      <span
                        className={uploadPhase === "confirming" ? "text-primary" : ""}
                      >
                        {mode === "files" ? "4. Confirm" : "3. Confirm"}
                      </span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.div whileTap={{ scale: 0.99 }}>
                <Button
                  type="button"
                  onClick={handleCreateShare}
                  disabled={
                    createShare.isPending ||
                    uploadPhase !== null ||
                    rateLimitSeconds > 0 ||
                    (mode === "text" && !text.trim()) ||
                    (mode === "files" && files.length === 0) ||
                    (!!HCAPTCHA_SITE_KEY && !captchaToken)
                  }
                  className="w-full font-mono tracking-widest text-sm py-6"
                  aria-label="Create secure share"
                >
                  {createShare.isPending || uploadPhase !== null ? (
                    <span className="flex items-center gap-2">
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                        className="inline-block"
                      >
                        ⟳
                      </motion.span>
                      {uploadPhase === "reading"
                        ? `READING… ${readProgress}%`
                        : uploadPhase === "encrypting"
                        ? `ENCRYPTING… ${encryptProgress}%`
                        : uploadPhase === "uploading"
                        ? `UPLOADING… ${uploadProgress}%`
                        : uploadPhase === "confirming"
                        ? "CONFIRMING…"
                        : "PROCESSING…"}
                    </span>
                  ) : (
                    "CREATE SECURE SHARE"
                  )}
                </Button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
