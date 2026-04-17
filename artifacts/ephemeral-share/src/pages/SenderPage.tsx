import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useCreateShare, useTestWebhook } from "@workspace/api-client-react";
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

const MAX_TOTAL_BYTES = 2.5 * 1024 * 1024;
const MAX_FILES = 10;

interface FileItem {
  file: File;
  id: string;
  name: string;
  preview?: string;
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
        setError("Total payload exceeds 2.5 MB limit.");
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

  const handleCreateShare = async () => {
    setError("");
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
      setError("Total payload exceeds 2.5 MB limit.");
      return;
    }

    try {
      // Build payload
      let payload: SharePayload;
      if (mode === "text") {
        payload = { type: "text", text };
      } else {
        const fileData = await Promise.all(
          files.map(async (fi) => ({
            name: fi.name,
            size: fi.file.size,
            type: fi.file.type,
            data: await fileToBase64(fi.file),
          }))
        );
        payload = { type: "files", files: fileData };
      }

      // Encrypt
      const { key, rawKey, keyBase64Url } = await generateEncryptionKey();
      const encryptedData = await encryptPayload(payload, key);

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

      const result = await createShare.mutateAsync({
        data: {
          encryptedData,
          ttl,
          passwordHash,
          passwordSalt,
          webhookUrl: webhookUrl || null,
          webhookMessage: webhookMessage || null,
          fileMetadata: mode === "files"
            ? files.map((fi, i) => ({
                name: fi.name,
                size: fi.file.size,
                type: fi.file.type,
                originalIndex: i,
              }))
            : null,
          shareType,
          totalSize,
          captchaToken: captchaToken || null,
        },
      });

      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");

      // When password is set: put encrypted key in URL (receiver needs password to recover raw key)
      // When no password: put raw key directly in URL
      const keyForUrl = passwordEnabled && passwordHash
        ? encodeURIComponent(passwordHash)
        : keyBase64Url;
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const url = `${window.location.origin}${base}/share/${result.shareId}#key=${keyForUrl}`;
      setShareUrl(url);
      setExpiresAt(result.expiresAt);
      setShareCreated(true);
    } catch (err: unknown) {
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      // Check for rate limit
      const anyErr = err as { response?: { data?: { retryAfterSeconds?: number; message?: string } } };
      if (anyErr?.response?.data?.retryAfterSeconds) {
        setRateLimitSeconds(anyErr.response.data.retryAfterSeconds);
        setError("");
      } else {
        setError(
          anyErr?.response?.data?.message ?? "Failed to create share. Please try again."
        );
      }
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
                    className="border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm font-mono text-destructive"
                    role="alert"
                  >
                    {error}
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

              {/* Submit */}
              <motion.div whileTap={{ scale: 0.99 }}>
                <Button
                  type="button"
                  onClick={handleCreateShare}
                  disabled={
                    createShare.isPending ||
                    rateLimitSeconds > 0 ||
                    (mode === "text" && !text.trim()) ||
                    (mode === "files" && files.length === 0) ||
                    (!!HCAPTCHA_SITE_KEY && !captchaToken)
                  }
                  className="w-full font-mono tracking-widest text-sm py-6"
                  aria-label="Create secure share"
                >
                  {createShare.isPending ? (
                    <span className="flex items-center gap-2">
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                        className="inline-block"
                      >
                        ⟳
                      </motion.span>
                      ENCRYPTING...
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
