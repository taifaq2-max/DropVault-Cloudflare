import { useState, useEffect, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  usePeekShare,
  useGetShare,
  useDeleteShare,
} from "@workspace/api-client-react";
import {
  importKeyFromBase64Url,
  decryptPayload,
  decryptKeyWithPassword,
  importKeyFromBase64Url as importKey,
  base64ToBlob,
  type SharePayload,
} from "@/lib/crypto";
import { formatBytes, randomHumorous } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import JSZip from "jszip";

type Phase =
  | "loading"
  | "warning"
  | "password"
  | "decrypting"
  | "content"
  | "done"
  | "error";

interface FileDownloadState {
  name: string;
  size: number;
  type: string;
  data: string; // base64
  downloaded: boolean;
  progress: number;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 bg-muted w-full overflow-hidden">
      <motion.div
        className="h-full bg-primary"
        initial={{ width: 0 }}
        animate={{ width: `${value}%` }}
        transition={{ ease: "linear" }}
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
      aria-label="Downloaded"
    >
      ✓
    </motion.div>
  );
}

export default function ReceiverPage() {
  const [, params] = useRoute("/share/:shareId");
  const [, navigate] = useLocation();
  const shareId = params?.shareId ?? "";

  const [phase, setPhase] = useState<Phase>("loading");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [fileStates, setFileStates] = useState<FileDownloadState[]>([]);
  const [textCopied, setTextCopied] = useState(false);
  const [humorousError, setHumorousError] = useState(randomHumorous);
  const [errorMessage, setErrorMessage] = useState("");
  const [zipProgress, setZipProgress] = useState(0);
  const [zipping, setZipping] = useState(false);
  const encryptedDataRef = useRef<string | null>(null);
  const passwordSaltRef = useRef<string | null>(null);
  const shareTypeRef = useRef<"text" | "files" | "mixed">("text");

  // Peek without consuming
  const peekQuery = usePeekShare(shareId, {
    query: {
      enabled: !!shareId,
      retry: false,
    },
  });

  const getShareMutation = useGetShare(shareId, {
    query: { enabled: false },
  });

  const deleteShare = useDeleteShare();

  useEffect(() => {
    if (peekQuery.isSuccess) {
      setPhase("warning");
    } else if (peekQuery.isError) {
      setHumorousError(randomHumorous());
      const err = peekQuery.error as { response?: { data?: { humorousMessage?: string; message?: string }; status?: number } };
      setErrorMessage(
        err?.response?.data?.humorousMessage ??
          err?.response?.data?.message ??
          "Share not found or expired."
      );
      setPhase("error");
    }
  }, [peekQuery.isSuccess, peekQuery.isError, peekQuery.error]);

  const handleAccess = async () => {
    const keyBase64Url = extractKey();
    if (!keyBase64Url) {
      setErrorMessage("Invalid share link — encryption key missing.");
      setPhase("error");
      return;
    }

    setPhase("decrypting");

    try {
      const refetchResult = await (getShareMutation as unknown as { refetch: () => Promise<{ data?: { encryptedData?: string; passwordRequired?: boolean; passwordSalt?: string | null; shareType?: string; webhookUrl?: string | null } }> }).refetch();
      const data = refetchResult.data;
      if (!data?.encryptedData) throw new Error("No data");

      encryptedDataRef.current = data.encryptedData;
      passwordSaltRef.current = data.passwordSalt ?? null;
      shareTypeRef.current = (data.shareType as "text" | "files" | "mixed") ?? "text";

      if (data.passwordRequired) {
        setPhase("password");
        return;
      }

      await decrypt(data.encryptedData, keyBase64Url, null, null);
    } catch (err: unknown) {
      const anyErr = err as { response?: { data?: { humorousMessage?: string; message?: string } } };
      setHumorousError(randomHumorous());
      setErrorMessage(
        anyErr?.response?.data?.humorousMessage ??
          anyErr?.response?.data?.message ??
          "Failed to retrieve share."
      );
      setPhase("error");
    }
  };

  const extractKey = (): string | null => {
    const hash = window.location.hash;
    if (!hash) return null;
    const match = hash.match(/[#&]?key=([^&]+)/);
    return match ? match[1] : null;
  };

  const decrypt = async (
    encryptedData: string,
    keyBase64Url: string,
    pwd: string | null,
    salt: string | null
  ) => {
    setPhase("decrypting");
    try {
      let key;
      if (pwd && salt) {
        const rawKey = await decryptKeyWithPassword(keyBase64Url, salt, pwd);
        const { importKeyFromBase64Url: importRaw } = await import("@/lib/crypto");
        const buf = rawKey.buffer as ArrayBuffer;
        const raw64 = btoa(String.fromCharCode(...rawKey));
        const urlSafe = raw64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        key = await importRaw(urlSafe);
      } else {
        key = await importKeyFromBase64Url(keyBase64Url);
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
      setPasswordError("Decryption failed. Check your password.");
      setPhase("password");
    }
  };

  const handlePasswordSubmit = async () => {
    setPasswordError("");
    const keyBase64Url = extractKey();
    if (!keyBase64Url || !encryptedDataRef.current) {
      setPasswordError("Invalid share link.");
      return;
    }
    await decrypt(
      encryptedDataRef.current,
      keyBase64Url,
      password,
      passwordSaltRef.current
    );
  };

  const downloadFile = async (index: number) => {
    const fs = fileStates[index];
    if (!fs) return;

    // Simulate progress
    const update = (p: number) =>
      setFileStates((prev) =>
        prev.map((s, i) => (i === index ? { ...s, progress: p } : s))
      );

    for (let p = 0; p <= 100; p += 20) {
      await new Promise((r) => setTimeout(r, 50));
      update(p);
    }

    const blob = base64ToBlob(fs.data, fs.type || "application/octet-stream");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fs.name;
    a.click();
    URL.revokeObjectURL(url);

    setFileStates((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, downloaded: true, progress: 100 } : s
      )
    );

    checkAllComplete();
  };

  const downloadAll = async () => {
    setZipping(true);
    const zip = new JSZip();
    for (let i = 0; i < fileStates.length; i++) {
      const fs = fileStates[i];
      const blob = base64ToBlob(fs.data, fs.type || "application/octet-stream");
      zip.file(fs.name, blob);
      setZipProgress(Math.round(((i + 1) / fileStates.length) * 50));
    }
    const content = await zip.generateAsync({ type: "blob" }, (meta) => {
      setZipProgress(50 + Math.round(meta.percent / 2));
    });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vaultdrop-share.zip";
    a.click();
    URL.revokeObjectURL(url);
    setZipping(false);
    setZipProgress(0);
    setFileStates((prev) => prev.map((s) => ({ ...s, downloaded: true, progress: 100 })));
    checkAllComplete();
  };

  const copyText = async () => {
    if (payload?.text) {
      await navigator.clipboard.writeText(payload.text);
      setTextCopied(true);
      checkAllComplete();
    }
  };

  const checkAllComplete = () => {
    const allFilesDownloaded =
      !fileStates.length || fileStates.every((f) => f.downloaded);
    const textHandled =
      !payload?.text || textCopied;
    if (allFilesDownloaded && textHandled) {
      setTimeout(() => triggerDelete(), 500);
    }
  };

  const triggerDelete = async () => {
    setPhase("done");
    try {
      await deleteShare.mutateAsync({ shareId });
    } catch {
      // best effort
    }
  };

  // Check after state updates
  useEffect(() => {
    if (phase === "content") {
      const allFilesDownloaded =
        fileStates.length === 0 || fileStates.every((f) => f.downloaded);
      const textHandled = !payload?.text || textCopied;
      if (allFilesDownloaded && textHandled && (fileStates.length > 0 || payload?.text)) {
        triggerDelete();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileStates, textCopied, phase]);

  const peekData = peekQuery.data;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-4 py-4 flex items-center gap-3">
        <div className="w-8 h-8 border border-primary flex items-center justify-center">
          <div className="w-3 h-3 bg-primary" />
        </div>
        <div>
          <div className="font-mono text-sm font-bold tracking-widest">VAULTDROP</div>
          <div className="text-xs text-muted-foreground font-mono">secure share receiver</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-12">
        <AnimatePresence mode="wait">
          {phase === "loading" && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto"
              />
              <div className="font-mono text-sm text-muted-foreground">Verifying share...</div>
            </motion.div>
          )}

          {phase === "warning" && peekData && (
            <motion.div
              key="warning"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-8 text-center"
            >
              {/* Dog mascot */}
              <div className="text-6xl" role="img" aria-label="Dog mascot">🐕</div>

              <div className="space-y-3">
                <motion.div
                  animate={{ scale: [1, 1.02, 1] }}
                  transition={{ repeat: Infinity, duration: 2.5 }}
                  className="text-xl font-mono font-bold text-foreground"
                >
                  ⚠ This data will be permanently deleted after you access it.
                </motion.div>
                <p className="text-muted-foreground font-mono text-sm">
                  Are you sure you want to continue?
                </p>
              </div>

              {/* Share info */}
              <div className="border border-border bg-card p-6 text-left space-y-3">
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-muted-foreground">Total Size</span>
                  <span className="text-foreground">{formatBytes(peekData.totalSize)}</span>
                </div>
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-muted-foreground">Type</span>
                  <span className="text-foreground capitalize">{peekData.shareType}</span>
                </div>
                {peekData.fileCount > 0 && (
                  <div className="flex justify-between font-mono text-sm">
                    <span className="text-muted-foreground">Files</span>
                    <span className="text-foreground">{peekData.fileCount}</span>
                  </div>
                )}
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-muted-foreground">Password Required</span>
                  <span className={peekData.passwordRequired ? "text-amber-400" : "text-primary"}>
                    {peekData.passwordRequired ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-muted-foreground">Expires</span>
                  <span className="text-foreground">
                    {new Date(peekData.expiresAt).toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="flex gap-4">
                <Button
                  variant="outline"
                  onClick={() => navigate("/")}
                  className="flex-1 font-mono"
                  aria-label="Go back"
                >
                  Go Back
                </Button>
                <Button
                  onClick={handleAccess}
                  className="flex-1 font-mono shadow-[0_0_16px_rgba(0,255,255,0.2)]"
                  aria-label="Access and download data"
                >
                  Access Data
                </Button>
              </div>
            </motion.div>
          )}

          {phase === "password" && (
            <motion.div
              key="password"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-6"
            >
              <div className="text-center space-y-2">
                <div className="font-mono text-sm text-muted-foreground uppercase tracking-widest">
                  Password Required
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  The sender protected this share with a password.
                </p>
              </div>
              <div className="space-y-3">
                <Input
                  type="text"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPasswordError("");
                  }}
                  placeholder="Enter password..."
                  className="font-mono bg-card"
                  aria-label="Enter share password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handlePasswordSubmit();
                  }}
                  autoFocus
                />
                {passwordError && (
                  <div className="text-xs font-mono text-destructive" role="alert">
                    {passwordError}
                  </div>
                )}
                <Button
                  onClick={handlePasswordSubmit}
                  className="w-full font-mono"
                  aria-label="Submit password"
                >
                  Decrypt
                </Button>
              </div>
            </motion.div>
          )}

          {phase === "decrypting" && (
            <motion.div
              key="decrypting"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto"
              />
              <div className="font-mono text-sm text-muted-foreground">Decrypting...</div>
            </motion.div>
          )}

          {phase === "content" && payload && (
            <motion.div
              key="content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-6"
            >
              <div className="border border-primary/30 bg-card px-4 py-3 flex items-center gap-2 text-primary font-mono text-xs">
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                  className="w-2 h-2 rounded-full bg-primary"
                />
                Data decrypted — retrieve all items to complete
              </div>

              {/* Text section */}
              {payload.text && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      Text Content
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={copyText}
                      className="font-mono text-xs"
                      aria-label="Copy text to clipboard"
                    >
                      {textCopied ? (
                        <span className="flex items-center gap-1">
                          <Checkmark /> Copied
                        </span>
                      ) : (
                        "Copy Text"
                      )}
                    </Button>
                  </div>
                  <pre className="bg-card border border-border p-4 font-mono text-sm whitespace-pre-wrap break-all max-h-64 overflow-auto text-foreground">
                    {payload.text}
                  </pre>
                </motion.div>
              )}

              {/* Files section */}
              {fileStates.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      Files ({fileStates.length})
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadAll}
                      disabled={zipping}
                      className="font-mono text-xs"
                      aria-label="Download all files as ZIP"
                    >
                      {zipping ? `Zipping ${zipProgress}%` : "Download All as ZIP"}
                    </Button>
                  </div>

                  <AnimatePresence>
                    {fileStates.map((fs, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }}
                        className="border border-border bg-card p-4 space-y-2"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm truncate">{fs.name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {formatBytes(fs.size)} · {fs.type || "unknown"}
                            </div>
                          </div>
                          {fs.downloaded ? (
                            <Checkmark />
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => downloadFile(i)}
                              disabled={fs.progress > 0 && fs.progress < 100}
                              className="font-mono text-xs shrink-0"
                              aria-label={`Download ${fs.name}`}
                            >
                              Download
                            </Button>
                          )}
                        </div>
                        {fs.progress > 0 && (
                          <ProgressBar value={fs.progress} />
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </motion.div>
          )}

          {phase === "done" && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-6 py-8"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", damping: 10, stiffness: 150 }}
                className="w-16 h-16 border-2 border-primary flex items-center justify-center mx-auto text-primary text-2xl font-mono"
              >
                ✓
              </motion.div>
              <div className="space-y-2">
                <div className="font-mono font-bold text-lg">All data retrieved.</div>
                <div className="text-muted-foreground font-mono text-sm">
                  The share has been permanently deleted from the server.
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  Thank you for using VaultDrop.
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => navigate("/")}
                className="font-mono"
                aria-label="Create a new share"
              >
                Create a Share
              </Button>
            </motion.div>
          )}

          {phase === "error" && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center space-y-6 py-8"
            >
              <div className="text-6xl" role="img" aria-label="Dog mascot">🐕</div>
              <div className="space-y-2">
                <div className="font-mono font-bold text-xl">{humorousError.title}</div>
                <div className="text-muted-foreground font-mono text-sm">
                  {humorousError.subtitle}
                </div>
                {errorMessage && (
                  <div className="text-xs text-muted-foreground font-mono border border-border bg-card px-3 py-2 mt-3">
                    {errorMessage}
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                onClick={() => navigate("/")}
                className="font-mono"
                aria-label="Go to home page"
              >
                Create a Share
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
