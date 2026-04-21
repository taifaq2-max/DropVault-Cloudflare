import { useState, useEffect, useCallback, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { useDeleteShare } from "@workspace/api-client-react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import {
  importKeyFromBase64Url,
  decryptPayload,
  decryptKeyWithPassword,
  base64ToBlob,
  type SharePayload,
} from "@/lib/crypto";
import { formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import JSZip from "jszip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useTheme } from "@/components/theme-provider";

const HCAPTCHA_SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY as string | undefined;

type Phase =
  | "captcha"
  | "loading"
  | "warning"
  | "password"
  | "decrypting"
  | "content"
  | "done"
  | "nonce_expired"
  | "share_expired"
  | "share_consumed"
  | "error";

interface FileDownloadState {
  name: string;
  size: number;
  type: string;
  data: string;
  downloaded: boolean;
  progress: number;
}

interface GetShareData {
  /**
   * Base64-encoded ciphertext — present for inline KV shares (≤ 2.5 MB).
   * Null/missing for R2-backed shares; use `dataUrl` instead.
   */
  encryptedData?: string | null;
  /**
   * Presigned R2 GET URL — present for large R2-backed shares (> 2.5 MB).
   * The browser fetches the ciphertext text directly from this URL.
   */
  dataUrl?: string | null;
  fileMetadata?: Array<{ name: string; size: number; type: string; originalIndex: number }> | null;
  passwordRequired: boolean;
  passwordSalt?: string | null;
  shareType: "text" | "files" | "mixed";
  totalSize: number;
  webhookUrl?: string | null;
  webhookMessage?: string | null;
}

const HUMOR = [
  { title: "We can't find what you're looking for", subtitle: "Like smoke in the wind, it's gone." },
  { title: "No droids here", subtitle: "These aren't the files you're looking for." },
  { title: "There is no cake", subtitle: "The promise was real. The data was not." },
  { title: "This share has evaporated", subtitle: "Poof. Into the digital ether." },
  { title: "Signal lost", subtitle: "This message, if it ever existed, has self-destructed." },
];

function pickHumor() {
  return HUMOR[Math.floor(Math.random() * HUMOR.length)];
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 bg-muted w-full overflow-hidden" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <motion.div
        className="h-full bg-primary"
        initial={{ width: 0 }}
        animate={{ width: `${value}%` }}
        transition={{ ease: "linear", duration: 0.1 }}
      />
    </div>
  );
}

function Checkmark() {
  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", damping: 12, stiffness: 200 }}
      className="w-5 h-5 border border-primary flex items-center justify-center text-primary text-xs font-mono"
      aria-label="Complete"
    >
      ✓
    </motion.div>
  );
}

export default function ReceiverPage() {
  const [, params] = useRoute("/share/:shareId");
  const [, navigate] = useLocation();
  const shareId = params?.shareId ?? "";
  const { theme } = useTheme();

  const [phase, setPhase] = useState<Phase>(HCAPTCHA_SITE_KEY ? "captcha" : "loading");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [fileStates, setFileStates] = useState<FileDownloadState[]>([]);
  const [textCopied, setTextCopied] = useState(false);
  const [humor] = useState(pickHumor);
  const [errorMessage, setErrorMessage] = useState("");
  const [zipProgress, setZipProgress] = useState(0);
  const [zipping, setZipping] = useState(false);

  // hCaptcha state
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaGateError, setCaptchaGateError] = useState("");
  const captchaRef = useRef<HCaptcha>(null);
  const captchaTheme: "dark" | "light" = theme === "dark" ? "dark" : "light";

  // Nonce issued by the peek endpoint — required by the access endpoint
  const [accessNonce, setAccessNonce] = useState("");

  // Persisted share data across phases
  const [shareData, setShareData] = useState<GetShareData | null>(null);
  const [peekData, setPeekData] = useState<{ totalSize: number; passwordRequired: boolean; shareType: string; fileCount: number; expiresAt: string } | null>(null);

  const deleteShareMutation = useDeleteShare();

  const fetchPeek = useCallback(async (token?: string) => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = new URL(`${window.location.origin}${base}/api/shares/${shareId}/peek`);
    if (token) url.searchParams.set("captchaToken", token);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string; humorousMessage?: string; message?: string };
      throw { status: res.status, data };
    }
    return res.json() as Promise<{ totalSize: number; passwordRequired: boolean; shareType: string; fileCount: number; expiresAt: string; accessNonce?: string }>;
  }, [shareId]);

  useEffect(() => {
    if (phase !== "loading") return;
    fetchPeek()
      .then((data) => {
        setPeekData(data);
        if (data.accessNonce) setAccessNonce(data.accessNonce);
        setPhase("warning");
      })
      .catch((err: unknown) => {
        const anyErr = err as { status?: number; data?: { error?: string; humorousMessage?: string; message?: string } };
        if (anyErr?.status === 404 && anyErr?.data?.error === "not_found") {
          setPhase("share_expired");
          return;
        }
        if (anyErr?.status === 410 && anyErr?.data?.error === "already_accessed") {
          setPhase("share_consumed");
          return;
        }
        setErrorMessage(
          anyErr?.data?.humorousMessage ??
            anyErr?.data?.message ??
            "Share not found or expired."
        );
        setPhase("error");
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const [peekLoading, setPeekLoading] = useState(false);

  // When the captcha gate first appears, do a token-less pre-check so users
  // learn immediately if the share is already gone — before solving the widget.
  useEffect(() => {
    if (phase !== "captcha") return;
    let cancelled = false;
    fetchPeek().catch((err: unknown) => {
      if (cancelled) return;
      const anyErr = err as { status?: number; data?: { error?: string } };
      if (anyErr?.status === 404 && anyErr?.data?.error === "not_found") {
        setPhase("share_expired");
      } else if (anyErr?.status === 410 && anyErr?.data?.error === "already_accessed") {
        setPhase("share_consumed");
      } else if (anyErr?.status === 410) {
        setPhase("share_expired");
      }
      // captcha_required / captcha_failed / other errors → share exists, stay on captcha gate
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePeekWithCaptcha = async () => {
    if (!captchaToken) return;
    setPeekLoading(true);
    try {
      const data = await fetchPeek(captchaToken);
      setPeekData(data);
      if (data.accessNonce) setAccessNonce(data.accessNonce);
      setCaptchaGateError("");
      setPhase("warning");
    } catch (err: unknown) {
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      const anyErr = err as { status?: number; data?: { error?: string; humorousMessage?: string; message?: string } };
      const errCode = anyErr?.data?.error;
      if (errCode === "captcha_failed" || errCode === "captcha_error" || errCode === "captcha_required") {
        // Stay on the captcha screen — show a retry message instead of the error page
        setCaptchaGateError("Verification failed. Please complete the captcha again.");
      } else if (anyErr?.status === 404 && errCode === "not_found") {
        setCaptchaGateError("");
        setPhase("share_expired");
      } else if (anyErr?.status === 410 && errCode === "already_accessed") {
        setCaptchaGateError("");
        setPhase("share_consumed");
      } else if (anyErr?.status === 410) {
        setCaptchaGateError("");
        setPhase("share_expired");
      } else {
        setCaptchaGateError("");
        setErrorMessage(
          anyErr?.data?.humorousMessage ??
            anyErr?.data?.message ??
            "Share not found or expired."
        );
        setPhase("error");
      }
    } finally {
      setPeekLoading(false);
    }
  };

  const extractKey = (): string | null => {
    const hash = window.location.hash;
    if (!hash) return null;
    const match = hash.match(/[#&]?key=([^&]+)/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  const fetchShare = useCallback(async (nonce?: string): Promise<GetShareData | null> => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = new URL(`${window.location.origin}${base}/api/shares/${shareId}`);
    if (nonce) url.searchParams.set("accessNonce", nonce);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string; humorousMessage?: string; message?: string };
      throw { status: res.status, data };
    }
    return res.json() as Promise<GetShareData>;
  }, [shareId]);

  const handleAccess = async () => {
    const keyFragment = extractKey();
    if (!keyFragment) {
      setErrorMessage("Invalid share link — encryption key missing from URL.");
      setPhase("error");
      return;
    }

    setPhase("decrypting");

    try {
      const data = await fetchShare(accessNonce || undefined);
      if (!data) throw new Error("No data returned");
      setShareData(data);

      if (data.passwordRequired) {
        setPhase("password");
        return;
      }

      await decrypt(data, keyFragment, null, null);
    } catch (err: unknown) {
      const anyErr = err as { status?: number; data?: { error?: string; humorousMessage?: string; message?: string } };
      if (anyErr?.status === 403 && anyErr?.data?.error === "invalid_nonce") {
        setPhase("nonce_expired");
        return;
      }
      if (anyErr?.status === 404 && anyErr?.data?.error === "not_found") {
        setPhase("share_expired");
        return;
      }
      if (anyErr?.status === 410 && anyErr?.data?.error === "already_accessed") {
        setPhase("share_consumed");
        return;
      }
      setErrorMessage(
        anyErr?.data?.humorousMessage ??
          anyErr?.data?.message ??
          "Failed to retrieve share."
      );
      setPhase("error");
    }
  };

  /** Reset all peek/nonce state and restart the flow from the beginning. */
  const handleRetry = () => {
    setAccessNonce("");
    setPeekData(null);
    setCaptchaToken("");
    setCaptchaGateError("");
    captchaRef.current?.resetCaptcha();
    setPhase(HCAPTCHA_SITE_KEY ? "captcha" : "loading");
  };

  /**
   * Resolve ciphertext from either the inline field or a presigned R2 URL.
   * R2 objects contain the raw base64 ciphertext string written by the sender.
   */
  const resolveCiphertext = async (data: GetShareData): Promise<string> => {
    if (data.encryptedData) return data.encryptedData;
    if (data.dataUrl) {
      const r2Res = await fetch(data.dataUrl);
      if (!r2Res.ok) throw new Error(`Failed to fetch encrypted data from storage (${r2Res.status}).`);
      return r2Res.text();
    }
    throw new Error("No encrypted data available in share response.");
  };

  const decrypt = async (
    shareOrData: GetShareData | string,
    keyFragment: string,
    pwd: string | null,
    salt: string | null
  ) => {
    setPhase("decrypting");
    try {
      // Accept either a GetShareData object (new path) or a raw ciphertext string (legacy).
      const encryptedData: string =
        typeof shareOrData === "string"
          ? shareOrData
          : await resolveCiphertext(shareOrData);

      let key: CryptoKey;

      if (pwd && salt) {
        // Password mode: keyFragment is the base64-encoded encrypted raw key
        // Decrypt it with the password-derived key
        const rawKey = await decryptKeyWithPassword(keyFragment, salt, pwd);
        const rawKeyBuffer = rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength) as ArrayBuffer;
        key = await crypto.subtle.importKey(
          "raw",
          rawKeyBuffer,
          { name: "AES-GCM" },
          false,
          ["encrypt", "decrypt"]
        );
      } else {
        // No password: keyFragment is the raw key in base64url
        key = await importKeyFromBase64Url(keyFragment);
      }

      const decrypted = await decryptPayload(encryptedData, key);
      setPayload(decrypted);

      if (decrypted.files && decrypted.files.length > 0) {
        setFileStates(
          decrypted.files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type,
            data: f.data,
            downloaded: false,
            progress: 0,
          }))
        );
      }

      setPhase("content");
    } catch {
      setPasswordError("Decryption failed. Check your password and try again.");
      setPhase("password");
    }
  };

  const handlePasswordSubmit = async () => {
    setPasswordError("");
    const keyFragment = extractKey();
    if (!keyFragment || !shareData) {
      setPasswordError("Invalid share link.");
      return;
    }
    if (!password.trim()) {
      setPasswordError("Please enter the password.");
      return;
    }
    await decrypt(
      shareData,
      keyFragment,
      password,
      shareData.passwordSalt ?? null
    );
  };

  const triggerDelete = useCallback(async () => {
    setPhase("done");
    try {
      await deleteShareMutation.mutateAsync({ shareId });
    } catch {
      // best effort
    }
  }, [deleteShareMutation, shareId]);

  const downloadFile = async (index: number) => {
    const fs = fileStates[index];
    if (!fs || fs.downloaded) return;

    const steps = [0, 20, 40, 60, 80, 100];
    for (const p of steps) {
      await new Promise((r) => setTimeout(r, 40));
      setFileStates((prev) =>
        prev.map((s, i) => (i === index ? { ...s, progress: p } : s))
      );
    }

    const blob = base64ToBlob(fs.data, fs.type || "application/octet-stream");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fs.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setFileStates((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, downloaded: true, progress: 100 } : s
      )
    );
  };

  // Check completion after state updates
  useEffect(() => {
    if (phase !== "content") return;
    const hasFiles = fileStates.length > 0;
    const hasText = !!payload?.text;
    if (!hasFiles && !hasText) return;
    const allFilesDownloaded = !hasFiles || fileStates.every((f) => f.downloaded);
    const textDone = !hasText || textCopied;
    if (allFilesDownloaded && textDone) {
      triggerDelete();
    }
  }, [fileStates, textCopied, phase, payload, triggerDelete]);

  const downloadAll = async () => {
    if (zipping) return;
    setZipping(true);
    const zip = new JSZip();
    for (let i = 0; i < fileStates.length; i++) {
      const fs = fileStates[i];
      const blob = base64ToBlob(fs.data, fs.type || "application/octet-stream");
      zip.file(fs.name, blob);
      setZipProgress(Math.round(((i + 1) / fileStates.length) * 40));
    }
    const content = await zip.generateAsync({ type: "blob" }, (meta) => {
      setZipProgress(40 + Math.round(meta.percent * 0.6));
    });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vaultdrop-share.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setZipping(false);
    setZipProgress(0);
    setFileStates((prev) => prev.map((s) => ({ ...s, downloaded: true, progress: 100 })));
  };

  const copyText = async () => {
    if (!payload?.text) return;
    await navigator.clipboard.writeText(payload.text);
    setTextCopied(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 border border-primary flex items-center justify-center">
            <div className="w-3 h-3 bg-primary" />
          </div>
          <div>
            <div className="font-mono text-sm font-bold tracking-widest">VAULTDROP</div>
            <div className="text-xs text-muted-foreground font-mono">secure share receiver</div>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="max-w-2xl mx-auto px-4 py-12">
        <AnimatePresence mode="wait">

          {/* Captcha gate (shown before peek fires, only when site key is configured) */}
          {phase === "captcha" && (
            <motion.div key="captcha" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="space-y-8 text-center">
              <div className="space-y-3">
                <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Human Verification</div>
                <p className="text-muted-foreground font-mono text-sm">Please complete the check below to access this share.</p>
              </div>
              <div className="flex justify-center" aria-label="Human verification">
                <HCaptcha
                  ref={captchaRef}
                  sitekey={HCAPTCHA_SITE_KEY!}
                  theme={captchaTheme}
                  onVerify={(token) => { setCaptchaToken(token); setCaptchaGateError(""); }}
                  onExpire={() => setCaptchaToken("")}
                  onError={() => setCaptchaToken("")}
                />
              </div>
              {captchaGateError && (
                <p className="text-sm font-mono text-destructive" role="alert">
                  {captchaGateError}
                </p>
              )}
              <Button
                onClick={handlePeekWithCaptcha}
                disabled={!captchaToken || peekLoading}
                className="w-full font-mono shadow-[0_0_16px_rgba(0,255,255,0.2)]"
                aria-label="Continue to access share"
              >
                {peekLoading ? "Verifying..." : "Continue"}
              </Button>
            </motion.div>
          )}

          {/* Loading */}
          {phase === "loading" && (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto" />
              <div className="font-mono text-sm text-muted-foreground">Verifying share...</div>
            </motion.div>
          )}

          {/* Warning */}
          {phase === "warning" && peekData && (
            <motion.div key="warning" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="space-y-8 text-center">
              <div className="text-6xl" role="img" aria-label="Guard dog mascot">🐕</div>
              <div className="space-y-3">
                <motion.div animate={{ scale: [1, 1.02, 1] }} transition={{ repeat: Infinity, duration: 2.5 }}
                  className="text-xl font-mono font-bold">
                  ⚠ This data will be permanently deleted after you access it.
                </motion.div>
                <p className="text-muted-foreground font-mono text-sm">Are you sure you want to continue?</p>
              </div>

              <div className="border border-border bg-card p-6 text-left space-y-3">
                {[
                  ["Total Size", formatBytes(peekData.totalSize)],
                  ["Type", peekData.shareType],
                  ...(peekData.fileCount > 0 ? [["Files", String(peekData.fileCount)]] : []),
                  ["Password Required", peekData.passwordRequired ? "Yes" : "No"],
                  ["Expires", new Date(peekData.expiresAt).toLocaleString()],
                ].map(([label, val]) => (
                  <div key={label} className="flex justify-between font-mono text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={label === "Password Required" && val === "Yes" ? "text-amber-400" : label === "Password Required" ? "text-primary" : "capitalize"}>{val}</span>
                  </div>
                ))}
              </div>

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => navigate("/")} className="flex-1 font-mono" aria-label="Go back without accessing">
                  Go Back
                </Button>
                <Button
                  onClick={handleAccess}
                  className="flex-1 font-mono shadow-[0_0_16px_rgba(0,255,255,0.2)]"
                  aria-label="Access data"
                >
                  Access Data
                </Button>
              </div>
            </motion.div>
          )}

          {/* Password entry */}
          {phase === "password" && (
            <motion.div key="password" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6 max-w-sm mx-auto">
              <div className="text-center space-y-2">
                <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Password Required</div>
                <p className="text-xs text-muted-foreground font-mono">The sender protected this share with a password.</p>
              </div>
              <div className="space-y-3">
                <Input
                  type="text"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setPasswordError(""); }}
                  placeholder="Enter password..."
                  className="font-mono bg-card"
                  aria-label="Share password"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handlePasswordSubmit(); }}
                />
                {passwordError && (
                  <div className="text-xs font-mono text-destructive" role="alert">{passwordError}</div>
                )}
                <Button onClick={handlePasswordSubmit} className="w-full font-mono" aria-label="Submit password to decrypt">
                  Decrypt
                </Button>
              </div>
            </motion.div>
          )}

          {/* Decrypting */}
          {phase === "decrypting" && (
            <motion.div key="decrypting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto" />
              <div className="font-mono text-sm text-muted-foreground">Decrypting...</div>
            </motion.div>
          )}

          {/* Content */}
          {phase === "content" && payload && (
            <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">
              <div className="border border-primary/30 bg-card px-4 py-3 flex items-center gap-2 text-primary font-mono text-xs">
                <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 2 }}
                  className="w-2 h-2 rounded-full bg-primary" />
                Data decrypted — retrieve all items to complete
              </div>

              {/* Text */}
              {payload.text && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Text Content</div>
                    <Button variant="outline" size="sm" onClick={copyText} className="font-mono text-xs" aria-label="Copy text to clipboard">
                      {textCopied
                        ? <span className="flex items-center gap-1"><Checkmark /> Copied</span>
                        : "Copy Text"
                      }
                    </Button>
                  </div>
                  <pre className="bg-card border border-border p-4 font-mono text-sm whitespace-pre-wrap break-all max-h-64 overflow-auto">
                    {payload.text}
                  </pre>
                </motion.div>
              )}

              {/* Files */}
              {fileStates.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      Files ({fileStates.length})
                    </div>
                    <Button variant="outline" size="sm" onClick={downloadAll} disabled={zipping}
                      className="font-mono text-xs" aria-label="Download all files as ZIP">
                      {zipping ? `Zipping ${zipProgress}%` : "Download All as ZIP"}
                    </Button>
                  </div>
                  <AnimatePresence>
                    {fileStates.map((fs, i) => (
                      <motion.div key={i}
                        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                        className="border border-border bg-card p-4 space-y-2">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm truncate">{fs.name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {formatBytes(fs.size)} · {fs.type || "unknown"}
                            </div>
                          </div>
                          {fs.downloaded
                            ? <Checkmark />
                            : <Button size="sm" onClick={() => downloadFile(i)}
                                disabled={fs.progress > 0 && fs.progress < 100}
                                className="font-mono text-xs shrink-0" aria-label={`Download ${fs.name}`}>
                                Download
                              </Button>
                          }
                        </div>
                        {fs.progress > 0 && <ProgressBar value={fs.progress} />}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </motion.div>
          )}

          {/* Done */}
          {phase === "done" && (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center space-y-6 py-8">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", damping: 10, stiffness: 150 }}
                className="w-16 h-16 border-2 border-primary flex items-center justify-center mx-auto text-primary text-2xl font-mono">
                ✓
              </motion.div>
              <div className="space-y-2">
                <div className="font-mono font-bold text-lg">All data retrieved.</div>
                <div className="text-muted-foreground font-mono text-sm">The share has been permanently deleted from the server.</div>
                <div className="text-xs text-muted-foreground font-mono">Thank you for using VaultDrop.</div>
              </div>
              <Button variant="outline" onClick={() => navigate("/")} className="font-mono" aria-label="Create a new share">
                Create a Share
              </Button>
            </motion.div>
          )}

          {/* Share expired — the share's own TTL ran out (404/410) */}
          {phase === "share_expired" && (
            <motion.div key="share_expired" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-6 py-8">
              <div className="text-6xl" role="img" aria-label="Dog mascot">🐕</div>
              <div className="space-y-3">
                <div className="font-mono font-bold text-xl">This share has expired</div>
                <p className="text-muted-foreground font-mono text-sm max-w-sm mx-auto">
                  This share has expired and can no longer be accessed.
                  Ask the sender to create a new share.
                </p>
              </div>
              <Button variant="outline" onClick={() => navigate("/")} className="font-mono" aria-label="Go home and create a new share">
                Create a Share
              </Button>
            </motion.div>
          )}

          {/* Share consumed — someone already accessed this share (410 already_accessed) */}
          {phase === "share_consumed" && (
            <motion.div key="share_consumed" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-6 py-8">
              <div className="text-6xl" role="img" aria-label="Warning mascot">⚠️</div>
              <div className="space-y-3">
                <div className="font-mono font-bold text-xl">This share was already accessed</div>
                <p className="text-muted-foreground font-mono text-sm max-w-sm mx-auto">
                  Someone else has already opened this share. If you did not access it, the sender should be notified — the data may have been intercepted.
                </p>
              </div>
              <Button variant="outline" onClick={() => navigate("/")} className="font-mono" aria-label="Go home and create a new share">
                Create a Share
              </Button>
            </motion.div>
          )}

          {/* Nonce expired — session timed out before clicking Access Data */}
          {phase === "nonce_expired" && (
            <motion.div key="nonce_expired" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-6 py-8">
              <div className="text-6xl" role="img" aria-label="Dog mascot">🐕</div>
              <div className="space-y-3">
                <div className="font-mono font-bold text-xl">Your session expired</div>
                <p className="text-muted-foreground font-mono text-sm max-w-sm mx-auto">
                  You took a little longer than 5 minutes on the warning screen.
                  The access session expired — but the share is still here.
                  Click below to start over.
                </p>
              </div>
              <Button
                onClick={handleRetry}
                className="font-mono shadow-[0_0_16px_rgba(0,255,255,0.2)]"
                aria-label="Try again to access this share"
              >
                Try Again
              </Button>
            </motion.div>
          )}

          {/* Error */}
          {phase === "error" && (
            <motion.div key="error" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-6 py-8">
              <div className="text-6xl" role="img" aria-label="Sad dog mascot">🐕</div>
              <div className="space-y-2">
                <div className="font-mono font-bold text-xl">{humor.title}</div>
                <div className="text-muted-foreground font-mono text-sm">{humor.subtitle}</div>
                {errorMessage && (
                  <div className="text-xs text-muted-foreground font-mono border border-border bg-card px-3 py-2 mt-3">{errorMessage}</div>
                )}
              </div>
              <Button variant="outline" onClick={() => navigate("/")} className="font-mono" aria-label="Go to home and create a share">
                Create a Share
              </Button>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}
