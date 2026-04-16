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

export async function encryptPayload(
  payload: SharePayload,
  key: CryptoKey
): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return bufferToBase64(combined.buffer);
}

export async function decryptPayload(
  encryptedDataBase64: string,
  key: CryptoKey
): Promise<SharePayload> {
  const combined = new Uint8Array(base64ToBuffer(encryptedDataBase64));
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
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data URL prefix
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
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
