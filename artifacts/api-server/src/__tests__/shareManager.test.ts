import { describe, it, expect } from "vitest";
import {
  createShare,
  getShare,
  deleteShare,
  markAccessed,
  cleanupExpired,
  getStats,
} from "../services/shareManager.js";

const BASE_PARAMS = {
  encryptedData: "aGVsbG8=",
  ttl: 3600,
  shareType: "text" as const,
  totalSize: 5,
};

describe("shareManager", () => {
  it("createShare returns a share with the correct fields", () => {
    const share = createShare(BASE_PARAMS);
    expect(typeof share.id).toBe("string");
    expect(share.id.length).toBeGreaterThan(0);
    expect(share.encryptedData).toBe(BASE_PARAMS.encryptedData);
    expect(share.accessed).toBe(false);
    expect(share.shareType).toBe("text");
    expect(share.expiresAt).toBeGreaterThan(Date.now());
  });

  it("getShare retrieves a created share by id", () => {
    const share = createShare(BASE_PARAMS);
    const found = getShare(share.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(share.id);
  });

  it("getShare returns undefined for unknown id", () => {
    expect(getShare("totally-nonexistent-id")).toBeUndefined();
  });

  it("markAccessed sets accessed flag to true", () => {
    const share = createShare(BASE_PARAMS);
    expect(share.accessed).toBe(false);
    markAccessed(share.id);
    expect(getShare(share.id)?.accessed).toBe(true);
  });

  it("deleteShare removes the share", () => {
    const share = createShare(BASE_PARAMS);
    const deleted = deleteShare(share.id);
    expect(deleted).toBe(true);
    expect(getShare(share.id)).toBeUndefined();
  });

  it("deleteShare returns false for nonexistent id", () => {
    expect(deleteShare("does-not-exist")).toBe(false);
  });

  it("cleanupExpired removes expired shares", () => {
    const share = createShare({ ...BASE_PARAMS, ttl: -1 });
    expect(getShare(share.id)).toBeDefined();
    cleanupExpired();
    expect(getShare(share.id)).toBeUndefined();
  });

  it("getStats reflects created and delivered counts", () => {
    const before = getStats();
    createShare(BASE_PARAMS);
    const after = getStats();
    expect(after.containersCreated).toBeGreaterThan(before.containersCreated);
  });
});
