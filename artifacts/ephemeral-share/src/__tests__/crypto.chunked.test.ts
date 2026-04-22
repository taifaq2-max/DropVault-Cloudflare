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

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

// ---------------------------------------------------------------------------
// encryptPayload — CHKD magic header verification
// ---------------------------------------------------------------------------

describe("encryptPayload — CHKD magic header in output", () => {
  it("produces output whose first four bytes are the CHKD magic bytes", async () => {
    const key = await makeKey();
    const payload: SharePayload = { type: "text", text: "magic header check" };
    const b64 = await encryptPayload(payload, key);

    const bytes = decodeBase64Bytes(b64);
    // "CHKD" = 0x43 0x48 0x4b 0x44
    expect(bytes[0]).toBe(0x43); // C
    expect(bytes[1]).toBe(0x48); // H
    expect(bytes[2]).toBe(0x4b); // K
    expect(bytes[3]).toBe(0x44); // D
  });

  it("encodes numChunks=1 for a small single-chunk payload", async () => {
    const key = await makeKey();
    const payload: SharePayload = { type: "text", text: "small payload" };
    const b64 = await encryptPayload(payload, key);

    const bytes = decodeBase64Bytes(b64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numChunks = view.getUint32(4, false);
    expect(numChunks).toBe(1);
  });

  it("round-trips a single-byte text payload (edge case)", async () => {
    const key = await makeKey();
    const payload: SharePayload = { type: "text", text: "x" };
    const b64 = await encryptPayload(payload, key);

    const bytes = decodeBase64Bytes(b64);
    expect(bytes[0]).toBe(0x43);

    const result = await decryptPayload(b64, key);
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Multi-chunk round-trip (payload > 4 MB)
// ---------------------------------------------------------------------------

describe("encryptPayload / decryptPayload — multi-chunk round-trip", () => {
  it("splits a >4 MB payload into multiple chunks and reassembles correctly", async () => {
    // 5 MB of repeated text guarantees at least two 4 MB chunks after JSON
    // serialization overhead.
    const bigText = "B".repeat(5 * 1024 * 1024);
    const payload: SharePayload = { type: "text", text: bigText };

    const key = await makeKey();
    const b64 = await encryptPayload(payload, key);

    // Verify magic header
    const bytes = decodeBase64Bytes(b64);
    expect(bytes[0]).toBe(0x43);
    expect(bytes[1]).toBe(0x48);
    expect(bytes[2]).toBe(0x4b);
    expect(bytes[3]).toBe(0x44);

    // Verify chunk count is at least 2
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numChunks = view.getUint32(4, false);
    expect(numChunks).toBeGreaterThanOrEqual(2);

    // Verify full round-trip fidelity
    const result = await decryptPayload(b64, key);
    expect(result.type).toBe("text");
    expect((result as { type: "text"; text: string }).text).toBe(bigText);
  }, 30_000);
});
