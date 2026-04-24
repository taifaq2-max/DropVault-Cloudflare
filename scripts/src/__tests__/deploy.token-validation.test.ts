import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateCfToken } from "../../deploy.mjs";

function makeFetchResponse(body: unknown, status = 200) {
  return {
    status,
    json: () => Promise.resolve(body),
  };
}

const FULL_PERMISSIONS = [
  { name: "Workers KV Storage Write" },
  { name: "Workers R2 Storage Write" },
  { name: "Workers Scripts Write" },
  { name: "Cloudflare Pages Edit" },
  { name: "Account Settings Read" },
  { name: "User API Tokens Read" },
];

describe("validateCfToken", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("proceeds without exiting when the token is valid and active", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse({
          success: true,
          result: { id: "tok-abc123", status: "active" },
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          success: true,
          result: {
            id: "tok-abc123",
            policies: [{ permission_groups: FULL_PERMISSIONS }],
          },
        }),
      );

    await validateCfToken();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits with code 1 and prints an error message when the API call fails", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(
        {
          success: false,
          errors: [{ code: 9109, message: "Invalid access token" }],
        },
        403,
      ),
    );

    await expect(validateCfToken()).rejects.toThrow("process.exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toMatch(/API token validation failed/);
  });

  it("exits with code 1 and mentions the status when the token is inactive", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse({
        success: true,
        result: { id: "tok-abc123", status: "disabled" },
      }),
    );

    await expect(validateCfToken()).rejects.toThrow("process.exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toMatch(/not active/);
    expect(logged).toMatch(/disabled/);
  });

  it("exits with code 1 and names the missing permissions when the token lacks required permission groups", async () => {
    const PARTIAL_PERMISSIONS = [
      { name: "Workers Scripts Write" },
      { name: "Account Settings Read" },
      { name: "User API Tokens Read" },
      // Intentionally omitting: Workers KV Storage Write, Workers R2 Storage Write, Cloudflare Pages Edit
    ];

    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse({
          success: true,
          result: { id: "tok-abc123", status: "active" },
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          success: true,
          result: {
            id: "tok-abc123",
            policies: [{ permission_groups: PARTIAL_PERMISSIONS }],
          },
        }),
      );

    await expect(validateCfToken()).rejects.toThrow("process.exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toMatch(/missing the following required permissions/);
    expect(logged).toMatch(/Workers KV Storage/);
  });
});
