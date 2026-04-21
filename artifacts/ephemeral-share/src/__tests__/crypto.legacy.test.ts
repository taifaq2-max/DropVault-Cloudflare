import { describe, it, expect } from "vitest";
import { decryptPayload } from "@/lib/crypto";

// ---------------------------------------------------------------------------
// Hardcoded legacy-format fixtures
//
// These were produced by the pre-update single-block encryption path:
//   combined = IV(12 bytes) || AES-GCM-ciphertext
// They represent shares that would have existed BEFORE the chunked-format
// update (magic header "CHKD") was introduced.
//
// Fixture generation (run once with Node.js webcrypto):
//   key   = 32 bytes all 0x42
//   iv    = [1,2,3,4,5,6,7,8,9,10,11,12]
//   input = JSON.stringify({ type:"text", text:"hello from legacy format" })
// ---------------------------------------------------------------------------

const FIXTURES = {
  text: {
    keyBytes: new Uint8Array(32).fill(0x42),
    // Pre-computed: iv(12) || AES-GCM-ciphertext for payload below
    ciphertextB64:
      "AQIDBAUGBwgJCgsMzthSNT0WazmurtSwPqtC7uTau7IlpRUa676wdr8ofJHEeiOGh2FWWENIvB/uvLeiZ1NeiCrtIVTrGroUWj6CDf8=",
    payload: { type: "text" as const, text: "hello from legacy format" },
  },
  files: {
    keyBytes: new Uint8Array(32).fill(0x99),
    // Pre-computed: iv(12) || AES-GCM-ciphertext for payload below
    ciphertextB64:
      "ChQeKDI8RlBaZG54KVG0r0ufWe9k2Smw6FlbL+LGSJ/R5IIbWJnuglYbMOcOgJRlWSTrpiLpwRFLBvNhonXiiqFsC6j/a5oFTkZUxOtdjvtK634n3FQFX8SQo0HntVjeM7YCol+JEnZqMhgB2dDDXaiV/WSGJ3FNwd61jTX3TDtIvZ8=",
    payload: {
      type: "files" as const,
      files: [{ name: "report.pdf", size: 2048, type: "application/pdf", data: "QUJDRA==" }],
    },
  },
};

async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
}

describe("decryptPayload — legacy single-block format (backward compatibility)", () => {
  it("decrypts a hardcoded legacy text payload (no CHKD magic header)", async () => {
    const { keyBytes, ciphertextB64, payload } = FIXTURES.text;

    const firstByte = new Uint8Array(atob(ciphertextB64).split("").map((c) => c.charCodeAt(0)))[0];
    expect(firstByte).not.toBe(0x43);

    const key = await importKey(keyBytes);
    const result = await decryptPayload(ciphertextB64, key);

    expect(result).toEqual(payload);
  });

  it("decrypts a hardcoded legacy files payload (no CHKD magic header)", async () => {
    const { keyBytes, ciphertextB64, payload } = FIXTURES.files;

    const key = await importKey(keyBytes);
    const result = await decryptPayload(ciphertextB64, key);

    expect(result).toEqual(payload);
  });

  it("throws when a hardcoded legacy ciphertext is tampered with", async () => {
    const { keyBytes, ciphertextB64 } = FIXTURES.text;

    const tampered = ciphertextB64.slice(0, -4) + "AAAA";

    const key = await importKey(keyBytes);
    await expect(decryptPayload(tampered, key)).rejects.toThrow();
  });
});
