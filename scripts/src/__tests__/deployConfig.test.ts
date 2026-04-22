import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

import { loadDeployConfig, saveDeployConfig } from "../../deploy.mjs";

function tmpConfigPath(): string {
  return join(tmpdir(), `deploy-config-test-${randomBytes(6).toString("hex")}.json`);
}

const EXPECTED_NON_SECRET_KEYS = [
  "accountId",
  "envTargets",
  "routingOption",
  "customDomain",
  "hcaptchaSiteKey",
  "pagesProjectName",
];

const SECRET_KEYS = [
  "CF_TOKEN",
  "hcaptchaSecretKey",
  "r2SecretAccessKey",
  "r2AccessKeyId",
];

const SAMPLE_CONFIG = {
  accountId: "abc123account",
  envTargets: ["production", "staging"],
  routingOption: "Option A — Custom domain + Worker Routes (recommended for production)",
  customDomain: "vaultdrop.example.com",
  hcaptchaSiteKey: "10000000-ffff-ffff-ffff-000000000001",
  pagesProjectName: "vaultdrop",
};

describe("saveDeployConfig", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths.splice(0)) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
  });

  it("writes exactly the expected non-secret keys to the config file", () => {
    const configPath = tmpConfigPath();
    paths.push(configPath);

    saveDeployConfig(SAMPLE_CONFIG, configPath);

    expect(existsSync(configPath)).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    const savedKeys = Object.keys(saved).sort();
    expect(savedKeys).toEqual([...EXPECTED_NON_SECRET_KEYS].sort());
  });

  it("persists the correct values for each non-secret key", () => {
    const configPath = tmpConfigPath();
    paths.push(configPath);

    saveDeployConfig(SAMPLE_CONFIG, configPath);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.accountId).toBe(SAMPLE_CONFIG.accountId);
    expect(saved.envTargets).toEqual(SAMPLE_CONFIG.envTargets);
    expect(saved.routingOption).toBe(SAMPLE_CONFIG.routingOption);
    expect(saved.customDomain).toBe(SAMPLE_CONFIG.customDomain);
    expect(saved.hcaptchaSiteKey).toBe(SAMPLE_CONFIG.hcaptchaSiteKey);
    expect(saved.pagesProjectName).toBe(SAMPLE_CONFIG.pagesProjectName);
  });

  it("does not include any secret keys in the saved file", () => {
    const configPath = tmpConfigPath();
    paths.push(configPath);

    const configWithSecrets = {
      ...SAMPLE_CONFIG,
      CF_TOKEN: "super-secret-cf-token",
      hcaptchaSecretKey: "secret-hcaptcha-key",
      r2SecretAccessKey: "secret-r2-access-key",
      r2AccessKeyId: "r2-key-id",
    };

    saveDeployConfig(configWithSecrets, configPath);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    for (const secretKey of SECRET_KEYS) {
      expect(saved).not.toHaveProperty(secretKey);
    }
  });
});

describe("loadDeployConfig", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths.splice(0)) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
  });

  it("returns an empty object when no config file exists", () => {
    const configPath = tmpConfigPath();
    const result = loadDeployConfig(configPath);
    expect(result).toEqual({});
  });

  it("returns saved values as defaults on re-run (round-trip)", () => {
    const configPath = tmpConfigPath();
    paths.push(configPath);

    saveDeployConfig(SAMPLE_CONFIG, configPath);

    const loaded = loadDeployConfig(configPath);

    expect(loaded.accountId).toBe(SAMPLE_CONFIG.accountId);
    expect(loaded.envTargets).toEqual(SAMPLE_CONFIG.envTargets);
    expect(loaded.routingOption).toBe(SAMPLE_CONFIG.routingOption);
    expect(loaded.customDomain).toBe(SAMPLE_CONFIG.customDomain);
    expect(loaded.hcaptchaSiteKey).toBe(SAMPLE_CONFIG.hcaptchaSiteKey);
    expect(loaded.pagesProjectName).toBe(SAMPLE_CONFIG.pagesProjectName);
  });

  it("loaded values can be used directly as prompt defaults (savedConfig.accountId pattern)", () => {
    const configPath = tmpConfigPath();
    paths.push(configPath);

    saveDeployConfig(SAMPLE_CONFIG, configPath);

    const savedConfig = loadDeployConfig(configPath);

    expect(savedConfig.accountId).toBe("abc123account");
    expect(savedConfig.pagesProjectName).toBe("vaultdrop");
    expect(savedConfig.envTargets).toContain("production");
    expect(savedConfig.envTargets).toContain("staging");
  });
});
