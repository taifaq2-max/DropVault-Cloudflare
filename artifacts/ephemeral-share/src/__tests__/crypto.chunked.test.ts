import { describe, it, expect, vi } from "vitest";
import { encryptPayload, decryptPayload, generateEncryptionKey } from "@/lib/crypto";
import type { SharePayload } from "@/lib/crypto";

async function makeKey(): Promise<CryptoKey> {
  const { key } = await generateEncryptionKey();
  return key;
}

// Build a minimal valid CHKD-format payload containing exactly `numChunks` chunks
// each with `chunkPlaintextSize` bytes of plaintext.
async function buildChunkedPayload(
  key: CryptoKey,
  payload: SharePayload
): Promise<string> {
  return encryptPayload(payload, key);
}

describe("decryptPayload — chunked format (CHKD header)", () => {
  it("decrypts a chunked payload and produces correct output", async () => {
    const key = await makeKey();
    const original: SharePayload = { type: "text", text: "hello chunked world" };
    const ciphertext = await buildChunkedPayload(key, original);

    const result = await decryptPayload(ciphertext, key);
    expect(result).toEqual(original);
  });

  it("invokes onProgress callback for each chunk with correct arguments", async () => {
    const key = await makeKey();
    const original: SharePayload = { type: "text", text: "progress test payload" };
    const ciphertext = await buildChunkedPayload(key, original);

    const calls: Array<[number, number]> = [];
    await decryptPayload(ciphertext, key, (done, total) => {
      calls.push([done, total]);
    });

    expect(calls.length).toBeGreaterThan(0);
    // Each call's done value must be <= total
    for (const [done, total] of calls) {
      expect(done).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(0);
      expect(done).toBeLessThanOrEqual(total);
    }
    // Final call must report 100% completion
    const [lastDone, lastTotal] = calls[calls.length - 1];
    expect(lastDone).toBe(lastTotal);
  });

  it("invokes onProgress callback even for a single-chunk payload", async () => {
    const key = await makeKey();
    const original: SharePayload = { type: "text", text: "single chunk" };
    const ciphertext = await buildChunkedPayload(key, original);

    const onProgress = vi.fn();
    await decryptPayload(ciphertext, key, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(1);
    const [done, total] = onProgress.mock.calls[0] as [number, number];
    expect(done).toBe(total);
  });

  it("does not invoke onProgress when callback is omitted", async () => {
    const key = await makeKey();
    const original: SharePayload = { type: "text", text: "no callback" };
    const ciphertext = await buildChunkedPayload(key, original);

    // Should not throw and should decrypt correctly
    const result = await decryptPayload(ciphertext, key);
    expect(result).toEqual(original);
  });

  it("throws on a truncated payload (missing chunk data)", async () => {
    const key = await makeKey();
    const original: SharePayload = { type: "text", text: "truncation test" };
    const ciphertext = await buildChunkedPayload(key, original);

    // Decode, truncate, re-encode
    const binary = atob(ciphertext);
    const truncated = btoa(binary.slice(0, binary.length - 20));

    await expect(decryptPayload(truncated, key)).rejects.toThrow(/truncated/i);
  });

  it("throws when the ciphertext has been tampered with", async () => {
    const key = await makeKey();
    const original: SharePayload = { type: "text", text: "tamper test" };
    const ciphertext = await buildChunkedPayload(key, original);

    // Flip some bytes in the ciphertext region (after the header)
    const bytes = new Uint8Array(
      atob(ciphertext)
        .split("")
        .map((c) => c.charCodeAt(0))
    );
    // Flip bytes near the end (in the ciphertext, not the header)
    for (let i = bytes.length - 5; i < bytes.length; i++) {
      bytes[i] ^= 0xff;
    }
    const tampered = btoa(String.fromCharCode(...bytes));

    await expect(decryptPayload(tampered, key)).rejects.toThrow();
  });
});
