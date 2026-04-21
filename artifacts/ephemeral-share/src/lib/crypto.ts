// Client-side AES-GCM encryption utilities
// Uses Web Crypto API — no external library

export interface EncryptedPayload {
  encryptedData: string; // base64: iv(12) + ciphertext
  keyBase64Url: string; // base64url of 32-byte raw key
}

export interface PasswordEncryptedKey {
  encryptedKey: string; // base64: iv(12) + encrypted main key
  salt: string; // base64 of 16-byte salt
}

export interface SharePayload {
  type: "text" | "files" | "mixed";
  text?: string;
  files?: Array<{ name: string; size: number; type: string; data: string }>;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlToBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBuffer(padded);
}

export async function generateEncryptionKey(): Promise<{
  key: CryptoKey;
  rawKey: Uint8Array;
  keyBase64Url: string;
}> {
  const rawKey = new Uint8Array(32);
  crypto.getRandomValues(rawKey);

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  return {
    key,
    rawKey,
    keyBase64Url: bufferToBase64Url(rawKey),
  };
}

// Magic bytes that identify the chunked format: "CHKD"
const CHUNKED_MAGIC = new Uint8Array([0x43, 0x48, 0x4b, 0x44]);
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk

// Encrypt payload in fixed-size chunks so that onProgress reflects real work.
// Each chunk is encrypted with its own random IV.
//
// Wire format (base64-encoded):
//   [4 bytes magic "CHKD"] [4 bytes uint32 numChunks big-endian]
//   for each chunk:
//     [4 bytes uint32 ciphertextLen big-endian] [12 bytes IV] [ciphertextLen bytes ciphertext]
export async function encryptPayload(
  payload: SharePayload,
  key: CryptoKey,
  onProgress?: (bytesEncrypted: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const totalBytes = plaintext.byteLength;

  const numChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE));
  const encryptedChunks: Uint8Array[] = [];
  let bytesEncrypted = 0;

  for (let i = 0; i < numChunks; i++) {
    if (signal?.aborted) {
      throw new DOMException("Encryption cancelled.", "AbortError");
    }

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalBytes);
    const chunk = plaintext.slice(start, end);

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      chunk
    );

    // Layout per chunk: 4-byte ciphertextLen + 12-byte IV + ciphertext
    const chunkBytes = new Uint8Array(4 + 12 + ciphertext.byteLength);
    const lenView = new DataView(chunkBytes.buffer);
    lenView.setUint32(0, ciphertext.byteLength, false);
    chunkBytes.set(iv, 4);
    chunkBytes.set(new Uint8Array(ciphertext), 16);
    encryptedChunks.push(chunkBytes);

    bytesEncrypted = end;
    onProgress?.(bytesEncrypted, totalBytes);
  }

  // Build final buffer: magic(4) + numChunks(4) + all chunk data
  const totalSize =
    4 + 4 + encryptedChunks.reduce((s, c) => s + c.byteLength, 0);
  const result = new Uint8Array(totalSize);
  result.set(CHUNKED_MAGIC, 0);
  const resultView = new DataView(result.buffer);
  resultView.setUint32(4, numChunks, false);
  let offset = 8;
  for (const chunkBytes of encryptedChunks) {
    result.set(chunkBytes, offset);
    offset += chunkBytes.byteLength;
  }

  return bufferToBase64(result.buffer);
}

export async function decryptPayload(
  encryptedDataBase64: string,
  key: CryptoKey
): Promise<SharePayload> {
  const combined = new Uint8Array(base64ToBuffer(encryptedDataBase64));

  // Detect chunked format by magic header "CHKD"
  if (
    combined.length >= 8 &&
    combined[0] === 0x43 &&
    combined[1] === 0x48 &&
    combined[2] === 0x4b &&
    combined[3] === 0x44
  ) {
    const view = new DataView(
      combined.buffer,
      combined.byteOffset,
      combined.byteLength
    );
    const numChunks = view.getUint32(4, false);
    if (numChunks === 0 || numChunks > 100_000) {
      throw new Error("Decryption failed: invalid chunk count in payload.");
    }
    let offset = 8;
    const plaintextParts: Uint8Array[] = [];

    for (let i = 0; i < numChunks; i++) {
      if (offset + 4 > combined.length) {
        throw new Error("Decryption failed: payload is truncated (missing chunk length).");
      }
      const ciphertextLen = view.getUint32(offset, false);
      offset += 4;
      if (offset + 12 + ciphertextLen > combined.length) {
        throw new Error("Decryption failed: payload is truncated (missing chunk data).");
      }
      const iv = combined.slice(offset, offset + 12);
      offset += 12;
      const ciphertext = combined.slice(offset, offset + ciphertextLen);
      offset += ciphertextLen;

      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
      );
      plaintextParts.push(new Uint8Array(plaintext));
    }

    const totalLength = plaintextParts.reduce((s, p) => s + p.byteLength, 0);
    const fullPlaintext = new Uint8Array(totalLength);
    let pos = 0;
    for (const part of plaintextParts) {
      fullPlaintext.set(part, pos);
      pos += part.byteLength;
    }

    return JSON.parse(new TextDecoder().decode(fullPlaintext)) as SharePayload;
  }

  // Legacy format: IV(12) + ciphertext (single block, no magic header)
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as SharePayload;
}

export async function importKeyFromBase64Url(
  keyBase64Url: string
): Promise<CryptoKey> {
  const rawKey = base64UrlToBuffer(keyBase64Url);
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// Password-based encryption of the main key
export async function encryptKeyWithPassword(
  rawKey: Uint8Array,
  password: string
): Promise<PasswordEncryptedKey> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const encryptedKeyBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    derivedKey,
    rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength) as ArrayBuffer
  );

  const combined = new Uint8Array(12 + encryptedKeyBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encryptedKeyBuffer), 12);

  return {
    encryptedKey: bufferToBase64(combined.buffer),
    salt: bufferToBase64(salt.buffer),
  };
}

export async function decryptKeyWithPassword(
  encryptedKeyBase64: string,
  saltBase64: string,
  password: string
): Promise<Uint8Array> {
  const saltBuffer = base64ToBuffer(saltBase64);
  const combined = new Uint8Array(base64ToBuffer(encryptedKeyBase64));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: 100_000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const rawKeyBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    derivedKey,
    ciphertext
  );

  return new Uint8Array(rawKeyBuffer);
}

export function generatePassword(): string {
  const words1 = ["crimson", "silent", "hidden", "neon", "cyan", "amber", "phantom", "ghost", "stellar", "quantum", "velvet", "frost", "shadow", "cobalt", "obsidian", "silver", "golden", "azure", "scarlet", "indigo"];
  const words2 = ["FALCON", "VAULT", "LOCK", "CIPHER", "MATRIX", "NEXUS", "PULSE", "SHARD", "PRISM", "FORGE", "SHIELD", "BLADE", "ECHO", "TITAN", "ORBIT", "DELTA", "APEX", "NOVA", "QUARTZ", "LYNX"];
  const words3 = ["raven", "ghost", "cipher", "node", "forge", "prism", "echo", "blade", "nexus", "core", "wire", "grid", "spark", "wing", "key", "flux", "dash", "arc", "bolt", "dusk"];
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const w1 = words1[buf[0] % words1.length];
  const w2 = words2[buf[1] % words2.length];
  const w3 = words3[buf[2] % words3.length];
  const num = 10000 + (buf[3] * 353) % 90000;
  return `${w1}-${w2}-${w3}-${num}`;
}

export function extractKeyFromFragment(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const match = hash.match(/[#&]?key=([^&]+)/);
  return match ? match[1] : null;
}

// Convert file to base64
// onprogress receives (loaded, total) bytes as the FileReader reads the file.
// signal, when provided, will abort the FileReader and reject with an AbortError.
export function fileToBase64(
  file: File,
  onprogress?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("File read cancelled.", "AbortError"));
      return;
    }

    const reader = new FileReader();

    const onAbort = () => {
      reader.abort();
      reject(new DOMException("File read cancelled.", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    reader.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(reader.error);
    };
    reader.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    if (onprogress) {
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          onprogress(e.loaded, e.total);
        }
      };
    }
    reader.readAsDataURL(file);
  });
}

// Convert base64 to Blob
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
