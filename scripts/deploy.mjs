#!/usr/bin/env node
/**
 * VaultDrop — Interactive Cloudflare Deployment Script
 *
 * Run from the repo root:
 *   node scripts/deploy.mjs
 *
 * Provisions all required Cloudflare resources and deploys the Worker + Pages
 * frontend end-to-end with no manual dashboard clicks required.
 */

import readline from "readline";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WRANGLER_TOML = path.join(REPO_ROOT, "artifacts", "cloudflare", "wrangler.toml");
const DEPLOY_CONFIG = path.join(REPO_ROOT, ".deploy.config.json");

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const bold = (s) => `${c.bold}${s}${c.reset}`;
const green = (s) => `${c.green}${s}${c.reset}`;
const yellow = (s) => `${c.yellow}${s}${c.reset}`;
const cyan = (s) => `${c.cyan}${s}${c.reset}`;
const red = (s) => `${c.red}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;

function banner(text) {
  const line = "─".repeat(text.length + 4);
  console.log(`\n${c.cyan}┌${line}┐${c.reset}`);
  console.log(`${c.cyan}│  ${c.bold}${text}${c.reset}${c.cyan}  │${c.reset}`);
  console.log(`${c.cyan}└${line}┘${c.reset}\n`);
}

function step(n, total, text) {
  console.log(`\n${cyan(`[${n}/${total}]`)} ${bold(text)}`);
}

function info(msg) { console.log(`  ${cyan("ℹ")} ${msg}`); }
function ok(msg)   { console.log(`  ${green("✓")} ${msg}`); }
function warn(msg) { console.log(`  ${yellow("⚠")} ${msg}`); }
function fail(msg) { console.log(`  ${red("✗")} ${msg}`); }

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------
let rl;

function createRL() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

function ask(question, defaultVal) {
  const hint = defaultVal !== undefined ? dim(` [${defaultVal}]`) : "";
  return new Promise((resolve) => {
    rl.question(`  ${cyan("?")} ${question}${hint}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed === "" && defaultVal !== undefined ? defaultVal : trimmed);
    });
  });
}

function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(`  ${cyan("?")} ${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = "";

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function onData(char) {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(value.trim());
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        value += char;
        process.stdout.write("*");
      }
    }

    stdin.on("data", onData);
  });
}

async function askChoice(question, choices, defaultChoice) {
  console.log(`  ${cyan("?")} ${question}`);
  choices.forEach((ch, i) => console.log(`    ${dim(`${i + 1}.`)} ${ch}`));
  const defaultIndex = defaultChoice !== undefined
    ? choices.findIndex((c) => c === defaultChoice)
    : -1;
  const defaultNum = defaultIndex >= 0 ? String(defaultIndex + 1) : "1";
  while (true) {
    const raw = await ask(`  Enter number (1-${choices.length})`, defaultNum);
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= choices.length) return choices[n - 1];
    warn(`Please enter a number between 1 and ${choices.length}.`);
  }
}

async function askMultiChoice(question, choices, defaultChoices) {
  console.log(`  ${cyan("?")} ${question}`);
  choices.forEach((ch, i) => console.log(`    ${dim(`${i + 1}.`)} ${ch}`));
  const defaultIndices = Array.isArray(defaultChoices) && defaultChoices.length > 0
    ? defaultChoices.map((dc) => choices.findIndex((c) => c === dc) + 1).filter((n) => n > 0)
    : [1];
  const defaultVal = defaultIndices.length > 0 ? defaultIndices.join(",") : "1";
  while (true) {
    const raw = await ask(`  Enter numbers separated by commas (e.g. 1,2)`, defaultVal);
    const parts = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    const valid = parts.every((n) => n >= 1 && n <= choices.length);
    if (valid && parts.length > 0) {
      return [...new Set(parts)].map((n) => choices[n - 1]);
    }
    warn(`Please enter valid numbers between 1 and ${choices.length}.`);
  }
}

// ---------------------------------------------------------------------------
// Deploy config persistence (non-secret answers only)
// ---------------------------------------------------------------------------

export function loadDeployConfig(configPath = DEPLOY_CONFIG) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

const DEPLOY_CONFIG_SECRET_KEYS = new Set([
  "CF_TOKEN",
  "hcaptchaSecretKey",
  "r2SecretAccessKey",
  "r2AccessKeyId",
]);

export function saveDeployConfig(values, configPath = DEPLOY_CONFIG) {
  try {
    const safe = Object.fromEntries(
      Object.entries(values).filter(([k]) => !DEPLOY_CONFIG_SECRET_KEYS.has(k)),
    );
    fs.writeFileSync(configPath, JSON.stringify(safe, null, 2) + "\n", "utf8");
    ok(`Non-secret config saved to ${dim(".deploy.config.json")} for future re-runs`);
  } catch (e) {
    warn(`Could not save deploy config: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Run a command, streaming output to the terminal.
 * Returns { stdout, stderr } combined output captured as strings.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   env?: Record<string,string>,
 *   pipeStdin?: string,
 *   captureOutput?: boolean,
 *   autoConfirm?: boolean
 * }} opts
 */
function runCmd(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      cwd = REPO_ROOT,
      env,
      pipeStdin,
      captureOutput = false,
      autoConfirm = false,
    } = opts;

    const mergedEnv = { ...process.env, ...env };

    const stdoutMode = captureOutput ? "pipe" : "inherit";
    const stderrMode = captureOutput ? "pipe" : "inherit";

    const child = spawn(cmd, args, {
      cwd,
      env: mergedEnv,
      stdio: ["pipe", stdoutMode, stderrMode],
    });

    if (pipeStdin !== undefined) {
      child.stdin.write(pipeStdin);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";

    // Patterns that indicate wrangler is waiting for a y/n confirmation.
    // Matches common Durable Object migration and deployment confirmation prompts.
    const CONFIRM_PATTERN = /\?|yes\/no|y\/n|please confirm|would you like to proceed|type "y"/i;
    let confirmedOnce = false;

    function maybeAutoConfirm(chunk) {
      if (!autoConfirm || pipeStdin !== undefined || confirmedOnce) return;
      if (CONFIRM_PATTERN.test(chunk.toString())) {
        confirmedOnce = true;
        try { child.stdin.write("y\n"); } catch (_) {}
      }
    }

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        stdout += d;
        if (!captureOutput) process.stdout.write(d);
        maybeAutoConfirm(d);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d;
        if (!captureOutput) process.stderr.write(d);
        maybeAutoConfirm(d);
      });
    }

    // Fallback: if no prompt was detected, send 'y' after 8 s so the process
    // doesn't hang forever if wrangler changes its prompt wording.
    if (autoConfirm) {
      setTimeout(() => {
        if (!confirmedOnce) {
          try { child.stdin.write("y\n"); } catch (_) {}
        }
      }, 8000);
    }

    child.on("close", (code) => {
      if (code !== 0) {
        const hint = stderr ? `\n${stderr.slice(0, 500)}` : "";
        reject(new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${code}${hint}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.on("error", reject);
  });
}

/**
 * Run wrangler via pnpm exec.
 * Always injects CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the
 * answers collected during the interactive Q&A phase, so the script works
 * on fresh machines without a prior `wrangler login`.
 */
function wrangler(args, opts = {}) {
  return runCmd("pnpm", ["exec", "wrangler", ...args], {
    cwd: path.join(REPO_ROOT, "artifacts", "cloudflare"),
    env: {
      CLOUDFLARE_API_TOKEN: CF_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    },
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Cloudflare REST API helper
// ---------------------------------------------------------------------------
let CF_TOKEN = "";
let CF_ACCOUNT_ID = "";

async function cfApi(urlPath, method = "GET", body = undefined) {
  const url = `https://api.cloudflare.com/client/v4${urlPath}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const json = await res.json();

  if (!json.success) {
    const errors = (json.errors || []).map((e) => `[${e.code}] ${e.message}`).join("; ");
    throw new Error(`Cloudflare API error on ${method} ${urlPath}: ${errors || res.status}`);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Verify that CF_TOKEN is valid, active, and carries the permissions required
 * by this deployment script.  The script exits before making any changes if
 * the token fails either check.
 *
 * Flow:
 *  1. GET /user/tokens/verify  — confirms the token is recognised and active,
 *     and returns the token's own ID.
 *  2. GET /user/tokens/:id     — fetches the full policy list so we can check
 *     for required permission groups before any resources are touched.
 *     This call requires the token to include "User:API Tokens:Read" (or a
 *     higher-level scope); if it fails the script exits with a clear error.
 *
 * Required permission groups (see step 1 prompt for the dashboard link):
 *   Workers KV Storage (Edit), Workers R2 Storage (Edit),
 *   Workers Scripts (Edit), Cloudflare Pages (Edit), Account Settings (Read),
 *   User: API Tokens (Read).
 */
async function validateCfToken() {
  info("Validating API token…");

  let verifyJson;
  try {
    verifyJson = await cfApi("/user/tokens/verify");
  } catch (e) {
    fail(`API token validation failed: ${e.message}`);
    fail("Please check that the token is correct and has not expired.");
    process.exit(1);
  }

  const tokenId = verifyJson.result && verifyJson.result.id;
  const status  = verifyJson.result && verifyJson.result.status;
  if (status !== "active") {
    fail(`API token is not active (status: ${status || "unknown"}).`);
    fail("Please create or regenerate your token and try again.");
    process.exit(1);
  }
  if (!tokenId) {
    fail("Cloudflare did not return a token ID in the verify response.");
    fail("Please check that the token is correct and try again.");
    process.exit(1);
  }

  // Each entry: `match(name)` tests a lowercase permission-group name string.
  // We require both the service keyword AND the access level so that, for
  // example, a read-only "Workers KV Storage Read" token does not pass an
  // Edit check.  Account Settings only requires Read so any level is accepted.
  const REQUIRED_PERMISSIONS = [
    {
      label: "Workers KV Storage (Edit)",
      match: (n) => (n.includes("kv storage")) && (n.includes("write") || n.includes("edit")),
    },
    {
      label: "Workers R2 Storage (Edit)",
      match: (n) => (n.includes("r2 storage")) && (n.includes("write") || n.includes("edit")),
    },
    {
      label: "Workers Scripts (Edit)",
      match: (n) => (n.includes("worker") && n.includes("script")) && (n.includes("write") || n.includes("edit")),
    },
    {
      label: "Cloudflare Pages (Edit)",
      match: (n) => (n.includes("pages")) && (n.includes("write") || n.includes("edit")),
    },
    {
      label: "Account Settings (Read)",
      match: (n) => n.includes("account settings") && (n.includes("read") || n.includes("write") || n.includes("edit")),
    },
  ];

  let tokenJson;
  try {
    tokenJson = await cfApi(`/user/tokens/${tokenId}`);
  } catch (e) {
    fail(`Could not fetch token permission details: ${e.message}`);
    fail(
      "Ensure the token has permission to read its own details, or verify manually\n" +
      "    at: https://dash.cloudflare.com/profile/api-tokens",
    );
    process.exit(1);
  }

  const policies = (tokenJson.result && tokenJson.result.policies) || [];
  const allPermNames = policies.flatMap(
    (p) => (p.permission_groups || []).map((g) => (g.name || "").toLowerCase()),
  );

  const missing = REQUIRED_PERMISSIONS.filter(
    (req) => !allPermNames.some((name) => req.match(name)),
  );

  if (missing.length > 0) {
    fail("API token is missing the following required permissions:");
    missing.forEach((m) => fail(`  • ${m.label}`));
    fail(
      "Create or edit your token at: https://dash.cloudflare.com/profile/api-tokens\n" +
      "    then re-run the deployment script.",
    );
    process.exit(1);
  }

  ok("API token is valid, active, and has the required permissions");
}

// ---------------------------------------------------------------------------
// KV provisioning
// ---------------------------------------------------------------------------
async function listKvNamespaces() {
  const json = await cfApi(`/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces?per_page=100`);
  return json.result || [];
}

async function createKvNamespace(title) {
  const json = await cfApi(
    `/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces`,
    "POST",
    { title },
  );
  return json.result.id;
}

async function ensureKvNamespace(title) {
  const existing = await listKvNamespaces();
  const found = existing.find((ns) => ns.title === title);
  if (found) {
    ok(`KV namespace "${title}" already exists → ${dim(found.id)}`);
    return found.id;
  }
  const id = await createKvNamespace(title);
  ok(`Created KV namespace "${title}" → ${dim(id)}`);
  return id;
}

// ---------------------------------------------------------------------------
// R2 bucket provisioning
// ---------------------------------------------------------------------------
async function listR2Buckets() {
  const json = await cfApi(`/accounts/${CF_ACCOUNT_ID}/r2/buckets?per_page=1000`);
  return (json.result && json.result.buckets) || [];
}

async function ensureR2Bucket(name) {
  const existing = await listR2Buckets();
  if (existing.find((b) => b.name === name)) {
    ok(`R2 bucket "${name}" already exists`);
    return;
  }
  await cfApi(`/accounts/${CF_ACCOUNT_ID}/r2/buckets`, "POST", { name });
  ok(`Created R2 bucket "${name}"`);
}

// ---------------------------------------------------------------------------
// R2 CORS policy
// ---------------------------------------------------------------------------
async function setR2CorsPolicy(bucketName, origin) {
  await cfApi(`/accounts/${CF_ACCOUNT_ID}/r2/buckets/${bucketName}/cors`, "PUT", {
    rules: [
      {
        allowedOrigins: [origin],
        allowedMethods: ["PUT", "GET"],
        allowedHeaders: ["Content-Type", "Content-Length"],
        maxAgeSeconds: 3600,
      },
    ],
  });
  ok(`R2 CORS policy set for bucket "${bucketName}" → origin ${dim(origin)}`);
}

// ---------------------------------------------------------------------------
// Pages env vars via REST API
// ---------------------------------------------------------------------------

/**
 * Upsert Pages env vars for both production and preview in a single PATCH
 * request, avoiding any risk of one environment's config overwriting the other.
 */
async function setPagesEnvVars(projectName, vars) {
  const envVarEntry = Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [
      k,
      v.secret
        ? { type: "secret_text", value: v.value }
        : { type: "plain_text", value: v.value },
    ]),
  );

  await cfApi(
    `/accounts/${CF_ACCOUNT_ID}/pages/projects/${projectName}`,
    "PATCH",
    {
      deployment_configs: {
        production: { env_vars: envVarEntry },
        preview:    { env_vars: envVarEntry },
      },
    },
  );
  ok("Pages env vars applied for production and preview environments");
}

// ---------------------------------------------------------------------------
// Workers.dev subdomain lookup
// ---------------------------------------------------------------------------

/**
 * Fetch the account's workers.dev subdomain from the Cloudflare API.
 * Returns the subdomain string (e.g. "myusername") or null if unavailable.
 * Used to construct canonical workers.dev Worker URLs as a fallback when the
 * URL cannot be parsed from wrangler deploy output.
 */
async function getWorkersSubdomain() {
  try {
    const json = await cfApi(`/accounts/${CF_ACCOUNT_ID}/workers/subdomain`);
    return (json.result && json.result.subdomain) || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// wrangler.toml patching
//
// All KV ID replacements are done with regexes that match the current value
// regardless of whether it is still the original placeholder or a real ID
// from a previous run — making re-runs fully idempotent.
// ---------------------------------------------------------------------------

/**
 * Replace the `id` field inside a [[kv_namespaces]] binding block that has
 * `binding = "SHARE_KV"` in the production (top-level) section.
 */
function replaceKvId(toml, newId) {
  return toml.replace(
    /(binding\s*=\s*"SHARE_KV"\s*\nid\s*=\s*)"[^"]*"/,
    `$1"${newId}"`,
  );
}

/**
 * Replace the `preview_id` field in the [[kv_namespaces]] block.
 */
function replaceKvPreviewId(toml, newId) {
  return toml.replace(
    /(binding\s*=\s*"SHARE_KV"\s*\nid\s*=\s*"[^"]*"\s*\npreview_id\s*=\s*)"[^"]*"/,
    `$1"${newId}"`,
  );
}

/**
 * Replace the `id` field inside the [[env.staging.kv_namespaces]] block.
 * We locate it by looking for the SHARE_KV binding inside the staging section.
 */
function replaceStagingKvId(toml, newId) {
  return toml.replace(
    /(\[env\.staging\.kv_namespaces\][^\[]*binding\s*=\s*"SHARE_KV"\s*\nid\s*=\s*)"[^"]*"/s,
    `$1"${newId}"`,
  );
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  banner("VaultDrop — Interactive Cloudflare Deployment");

  console.log(
    `This script provisions Cloudflare resources and deploys VaultDrop.\n` +
    `It drives the Cloudflare REST API and shells out to ${bold("wrangler")} for\n` +
    `secret management and deployments.\n`,
  );

  createRL();

  const savedConfig = loadDeployConfig();
  if (Object.keys(savedConfig).length > 0) {
    info(`Loaded saved config from ${dim(".deploy.config.json")} — press Enter to accept each default.`);
    console.log();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1 — Collect configuration
  // ─────────────────────────────────────────────────────────────────────────
  step(1, 10, "Gather configuration");

  info(
    `Create an API token at: ${cyan("https://dash.cloudflare.com/profile/api-tokens")}\n` +
    `    Required permissions: Workers KV Storage (Edit), Workers R2 Storage (Edit),\n` +
    `    Workers Scripts (Edit), Cloudflare Pages (Edit), Account Settings (Read),\n` +
    `    User: API Tokens (Read) — needed for the startup permission check.`,
  );
  CF_TOKEN = await askSecret("Cloudflare API token");
  if (!CF_TOKEN) { fail("API token is required. Aborting."); process.exit(1); }

  await validateCfToken();

  info(
    `Find your Account ID at: ${cyan("https://dash.cloudflare.com")} → right sidebar\n` +
    `    or run: ${bold("pnpm exec wrangler whoami")}`,
  );
  CF_ACCOUNT_ID = await ask("Cloudflare Account ID", savedConfig.accountId);
  if (!CF_ACCOUNT_ID) { fail("Account ID is required. Aborting."); process.exit(1); }

  const envTargets = await askMultiChoice(
    "Which environments do you want to deploy?",
    ["production", "staging"],
    savedConfig.envTargets,
  );
  const deployProduction = envTargets.includes("production");
  const deployStaging = envTargets.includes("staging");

  const routingOption = await askChoice("Routing option for API calls:", [
    "Option A — Custom domain + Worker Routes (recommended for production)",
    "Option B — Pages Function proxy (no custom domain, *.pages.dev)",
  ], savedConfig.routingOption);
  const useOptionA = routingOption.startsWith("Option A");

  let customDomain = "";
  if (useOptionA) {
    customDomain = await ask("Custom domain (e.g. vaultdrop.example.com)", savedConfig.customDomain);
    if (!customDomain) warn("No custom domain provided — falling back to Option B routing.");
  }

  console.log();
  info("hCaptcha integration (optional — leave blank to skip)");
  const hcaptchaSiteKey = await ask("hCaptcha site key (blank to skip)", savedConfig.hcaptchaSiteKey);
  let hcaptchaSecretKey = "";
  if (hcaptchaSiteKey) hcaptchaSecretKey = await askSecret("hCaptcha secret key");

  console.log();
  info(
    `R2 API token — needed for presigned-URL direct browser → R2 uploads.\n` +
    `    Create one at: ${cyan("https://dash.cloudflare.com/?to=/:account/r2/api-tokens")}\n` +
    `    Permissions: Object Read & Write, scoped to the vaultdrop-shares bucket.`,
  );
  const r2AccessKeyId = await ask("R2 API token — Access Key ID");
  if (!r2AccessKeyId) { fail("R2 Access Key ID is required. Aborting."); process.exit(1); }
  const r2SecretAccessKey = await askSecret("R2 API token — Secret Access Key");
  if (!r2SecretAccessKey) { fail("R2 Secret Access Key is required. Aborting."); process.exit(1); }

  const pagesProjectName = await ask("Cloudflare Pages project name", savedConfig.pagesProjectName || "vaultdrop");

  rl.close();

  const frontendUrl =
    useOptionA && customDomain
      ? `https://${customDomain}`
      : `https://${pagesProjectName}.pages.dev`;

  console.log();
  info(`Frontend URL:  ${bold(frontendUrl)}`);
  info(`Environments:  ${bold(envTargets.join(", "))}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2 — KV namespace provisioning
  // ─────────────────────────────────────────────────────────────────────────
  step(2, 10, "Provision KV namespaces");

  let kvProdId = "";
  let kvProdPreviewId = "";
  let kvStagingId = "";

  if (deployProduction) {
    kvProdId = await ensureKvNamespace("SHARE_KV");
    kvProdPreviewId = await ensureKvNamespace("SHARE_KV_preview");
  }
  if (deployStaging) {
    kvStagingId = await ensureKvNamespace("SHARE_KV_staging");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3 — R2 bucket provisioning
  // ─────────────────────────────────────────────────────────────────────────
  step(3, 10, "Provision R2 buckets");

  if (deployProduction) await ensureR2Bucket("vaultdrop-shares");
  if (deployStaging)    await ensureR2Bucket("vaultdrop-shares-staging");

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4 — Patch wrangler.toml
  // ─────────────────────────────────────────────────────────────────────────
  step(4, 10, "Patch wrangler.toml");

  let toml = fs.readFileSync(WRANGLER_TOML, "utf8");

  if (deployProduction) {
    // Patch production KV namespace IDs (idempotent — matches any current value)
    toml = replaceKvId(toml, kvProdId);
    toml = replaceKvPreviewId(toml, kvProdPreviewId);

    // Patch production [vars]
    toml = toml.replace(/^(FRONTEND_URL\s*=\s*)"[^"]*"/m, `$1"${frontendUrl}"`);
    toml = toml.replace(/^(CLOUDFLARE_ACCOUNT_ID\s*=\s*)"[^"]*"/m, `$1"${CF_ACCOUNT_ID}"`);
    // Patch R2_BUCKET_NAME in [vars] (production)
    toml = toml.replace(/^(R2_BUCKET_NAME\s*=\s*)"[^"]*"/m, `$1"vaultdrop-shares"`);
    // Patch [[r2_buckets]] bucket_name (production, top-level only — not inside env.staging)
    toml = toml.replace(
      /(^\[\[r2_buckets\]\][^\[]*bucket_name\s*=\s*)"[^"]*"/m,
      `$1"vaultdrop-shares"`,
    );
  }

  if (deployStaging) {
    // Patch staging KV namespace ID (idempotent)
    toml = replaceStagingKvId(toml, kvStagingId);

    // Patch staging [env.staging.vars] — use multiline/dotall to locate the block
    toml = toml.replace(
      /(\[env\.staging\.vars\][\s\S]*?FRONTEND_URL\s*=\s*)"[^"]*"/,
      `$1"${frontendUrl}"`,
    );
    toml = toml.replace(
      /(\[env\.staging\.vars\][\s\S]*?CLOUDFLARE_ACCOUNT_ID\s*=\s*)"[^"]*"/,
      `$1"${CF_ACCOUNT_ID}"`,
    );
    // Patch R2_BUCKET_NAME in [env.staging.vars]
    toml = toml.replace(
      /(\[env\.staging\.vars\][\s\S]*?R2_BUCKET_NAME\s*=\s*)"[^"]*"/,
      `$1"vaultdrop-shares-staging"`,
    );
    // Patch [[env.staging.r2_buckets]] bucket_name
    toml = toml.replace(
      /(\[\[env\.staging\.r2_buckets\]\][^\[]*bucket_name\s*=\s*)"[^"]*"/m,
      `$1"vaultdrop-shares-staging"`,
    );
  }

  fs.writeFileSync(WRANGLER_TOML, toml, "utf8");
  ok("wrangler.toml patched");

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5 — Worker secrets (required = hard failure, optional = warn)
  // ─────────────────────────────────────────────────────────────────────────
  step(5, 10, "Push Worker secrets");

  const sessionSecret = crypto.randomBytes(32).toString("hex");
  info("Generated SESSION_SECRET (64-char hex)");

  async function pushSecret(envFlag, name, value, { required = true } = {}) {
    try {
      await wrangler([...envFlag, "secret", "put", name], {
        pipeStdin: value + "\n",
        captureOutput: true,
      });
      ok(`${name} pushed`);
    } catch (e) {
      if (required) {
        fail(`Failed to push required secret ${name}: ${e.message}`);
        process.exit(1);
      } else {
        warn(`Optional secret ${name} could not be pushed: ${e.message}`);
      }
    }
  }

  for (const [envName, shouldDeploy] of [["production", deployProduction], ["staging", deployStaging]]) {
    if (!shouldDeploy) continue;
    const envFlag = envName === "staging" ? ["--env", "staging"] : [];

    info(`Pushing secrets for ${bold(envName)} environment...`);
    await pushSecret(envFlag, "SESSION_SECRET", sessionSecret, { required: true });
    await pushSecret(envFlag, "R2_ACCESS_KEY_ID", r2AccessKeyId, { required: true });
    await pushSecret(envFlag, "R2_ACCESS_KEY_SECRET", r2SecretAccessKey, { required: true });
    if (hcaptchaSecretKey) {
      await pushSecret(envFlag, "HCAPTCHA_SECRET_KEY", hcaptchaSecretKey, { required: false });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6 — Build and deploy Worker; capture Worker URL from output
  // ─────────────────────────────────────────────────────────────────────────
  step(6, 10, "Build and deploy Cloudflare Worker");

  let workerProdUrl = "";
  let workerStagingUrl = "";

  /** Extract the workers.dev URL from wrangler deploy stdout/stderr. */
  function parseWorkerUrl(output) {
    const m = output.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
    return m ? m[0] : "";
  }

  /**
   * Construct a canonical workers.dev URL using the account's registered
   * subdomain (fetched via the Cloudflare API) rather than guessing.
   * Returns null if the subdomain cannot be determined — caller should
   * treat this as a non-fatal warning since the Worker is already deployed.
   */
  async function buildWorkerFallbackUrl(workerName) {
    const subdomain = await getWorkersSubdomain();
    if (!subdomain) return null;
    return `https://${workerName}.${subdomain}.workers.dev`;
  }

  if (deployProduction) {
    info("Deploying Worker (production)...");
    let out;
    try {
      out = await wrangler(["deploy"], { captureOutput: true, autoConfirm: true });
      // Echo captured output to terminal
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
    } catch (e) {
      fail(`Worker deployment failed: ${e.message}`);
      process.exit(1);
    }
    workerProdUrl = parseWorkerUrl(out.stdout + out.stderr);
    if (!workerProdUrl) {
      workerProdUrl = await buildWorkerFallbackUrl("vaultdrop-api");
      if (workerProdUrl) {
        warn(`Could not parse Worker URL from output; derived: ${workerProdUrl}`);
      } else {
        warn("Could not determine Worker URL. You will need to set VITE_API_URL/WORKER_URL manually.");
      }
    }
    ok(`Worker deployed (production)${workerProdUrl ? ` → ${dim(workerProdUrl)}` : ""}`);
  }

  if (deployStaging) {
    info("Deploying Worker (staging)...");
    let out;
    try {
      out = await wrangler(["deploy", "--env", "staging"], { captureOutput: true, autoConfirm: true });
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
    } catch (e) {
      fail(`Worker (staging) deployment failed: ${e.message}`);
      process.exit(1);
    }
    workerStagingUrl = parseWorkerUrl(out.stdout + out.stderr);
    if (!workerStagingUrl) {
      workerStagingUrl = await buildWorkerFallbackUrl("vaultdrop-api-staging") || "";
      if (workerStagingUrl) {
        warn(`Could not parse staging Worker URL; derived: ${workerStagingUrl}`);
      }
    }
    ok(`Worker deployed (staging)${workerStagingUrl ? ` → ${dim(workerStagingUrl)}` : ""}`);
  }

  // Canonical Worker URL used for Pages env vars
  const workerUrl = workerProdUrl || workerStagingUrl;

  // ─────────────────────────────────────────────────────────────────────────
  // Step 7 — Build frontend
  // ─────────────────────────────────────────────────────────────────────────
  step(7, 10, "Build frontend");

  info("Running pnpm build for @workspace/ephemeral-share...");
  try {
    await runCmd(
      "pnpm",
      ["--filter", "@workspace/ephemeral-share", "run", "build"],
      {
        cwd: REPO_ROOT,
        env: {
          VITE_USE_R2_UPLOADS: "true",
          // For Option A (custom domain), VITE_API_URL is unset — the frontend
          // uses relative /api/* paths routed via Worker Routes.
          ...((!useOptionA || !customDomain) && workerUrl
            ? { VITE_API_URL: workerUrl }
            : {}),
          ...(hcaptchaSiteKey ? { VITE_HCAPTCHA_SITE_KEY: hcaptchaSiteKey } : {}),
        },
      },
    );
    ok("Frontend built");
  } catch (e) {
    fail(`Frontend build failed: ${e.message}`);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 8 — Deploy to Cloudflare Pages
  // ─────────────────────────────────────────────────────────────────────────
  step(8, 10, "Deploy to Cloudflare Pages");

  // Deploy from the ephemeral-share directory so wrangler auto-discovers the
  // `functions/api/[[route]].ts` Pages Function alongside `dist/public`.
  // This ensures Option B (Pages Function proxy) is included in the deployment.
  const ephemeralShareDir = path.join(REPO_ROOT, "artifacts", "ephemeral-share");
  info(`Deploying from: ${dim(path.join(ephemeralShareDir, "dist", "public"))}`);

  let pagesOut;
  try {
    pagesOut = await runCmd(
      "pnpm",
      [
        "exec", "wrangler", "pages", "deploy",
        "dist/public",
        "--project-name", pagesProjectName,
      ],
      {
        cwd: ephemeralShareDir,
        env: {
          CLOUDFLARE_API_TOKEN: CF_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
        },
        captureOutput: true,
      },
    );
    if (pagesOut.stdout) process.stdout.write(pagesOut.stdout);
    if (pagesOut.stderr) process.stderr.write(pagesOut.stderr);
    ok("Pages deployment complete");
  } catch (e) {
    fail(`Pages deployment failed: ${e.message}`);
    process.exit(1);
  }

  // Try to extract the Pages URL from wrangler output
  const pagesUrlMatch = (pagesOut.stdout + pagesOut.stderr).match(
    /https:\/\/[\w-]+\.pages\.dev/,
  );
  const pagesDeployedUrl = pagesUrlMatch ? pagesUrlMatch[0] : frontendUrl;

  // ─────────────────────────────────────────────────────────────────────────
  // Step 9 — Set Pages environment variables
  // ─────────────────────────────────────────────────────────────────────────
  step(9, 10, "Configure Pages environment variables");

  const pagesVars = {
    VITE_USE_R2_UPLOADS: { value: "true" },
  };

  if (!useOptionA || !customDomain) {
    if (workerUrl) pagesVars.VITE_API_URL = { value: workerUrl };
  }

  if (!useOptionA) {
    // Option B — Pages Function proxy needs WORKER_URL
    if (workerUrl) pagesVars.WORKER_URL = { value: workerUrl, secret: true };
  }

  if (hcaptchaSiteKey) {
    pagesVars.VITE_HCAPTCHA_SITE_KEY = { value: hcaptchaSiteKey };
  }

  try {
    await setPagesEnvVars(pagesProjectName, pagesVars);
  } catch (e) {
    warn(`Could not set Pages env vars via REST API: ${e.message}`);
    warn("Set them manually in the Cloudflare Pages dashboard → Settings → Environment variables.");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 10 — R2 CORS policy
  // ─────────────────────────────────────────────────────────────────────────
  step(10, 10, "Apply R2 CORS policy");

  // For Option A (custom domain) CORS must be set to the custom domain, not the
  // *.pages.dev URL — the browser navigates to the custom domain and that is the
  // origin included in R2 PUT requests. For Option B, prefer the actual Pages URL
  // returned by wrangler (may include the branch hash), falling back to frontendUrl.
  const corsOrigin =
    useOptionA && customDomain
      ? frontendUrl
      : pagesDeployedUrl || frontendUrl;

  if (deployProduction) {
    try {
      await setR2CorsPolicy("vaultdrop-shares", corsOrigin);
    } catch (e) {
      warn(`Could not set R2 CORS policy: ${e.message}`);
      warn(
        `Set it manually in the R2 bucket settings.\n` +
        `    AllowedOrigins: ["${corsOrigin}"], AllowedMethods: ["PUT","GET"]`,
      );
    }
  }

  if (deployStaging) {
    try {
      await setR2CorsPolicy("vaultdrop-shares-staging", corsOrigin);
    } catch (e) {
      warn(`Could not set staging R2 CORS policy: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  console.log();
  banner("Deployment Complete");

  const tableRows = [
    ["Pages URL",             pagesDeployedUrl],
    ["Worker URL (prod)",     deployProduction ? workerProdUrl   : dim("(not deployed)")],
    ["Worker URL (staging)",  deployStaging    ? workerStagingUrl : dim("(not deployed)")],
    ["Routing mode",          useOptionA && customDomain ? "Option A — Custom domain" : "Option B — Pages Function proxy"],
    ["hCaptcha",              hcaptchaSiteKey ? green("enabled") : dim("disabled")],
    ["R2 direct uploads",     green("enabled")],
  ];

  const maxKeyLen = Math.max(...tableRows.map(([k]) => k.length));
  const border = `  ${c.cyan}${"─".repeat(maxKeyLen + 32)}${c.reset}`;
  console.log(border);
  for (const [key, value] of tableRows) {
    console.log(`  ${bold(key.padEnd(maxKeyLen))}  ${value}`);
  }
  console.log(border);

  // Manual follow-up steps (only for Option A with custom domain)
  const followUps = [];

  if (useOptionA && customDomain) {
    followUps.push(
      `Verify "${customDomain}" is added to your Cloudflare account.`,
      `Create a Worker Route: ${customDomain}/api/*  →  vaultdrop-api\n` +
      `      (Workers & Pages → vaultdrop-api → Triggers → Routes)`,
      `Add a Pages custom domain: ${customDomain}\n` +
      `      (Pages → ${pagesProjectName} → Custom domains)`,
    );
  }

  if (followUps.length > 0) {
    console.log();
    console.log(`  ${yellow("Manual steps still required:")}`);
    followUps.forEach((s, i) => console.log(`\n  ${yellow(`${i + 1}.`)} ${s}`));
  }

  console.log();
  saveDeployConfig({
    accountId: CF_ACCOUNT_ID,
    envTargets,
    routingOption,
    customDomain,
    hcaptchaSiteKey,
    pagesProjectName,
  });

  console.log();
  ok(green("VaultDrop deployment finished successfully."));
  console.log();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(red(`\nFatal error: ${err.message}`));
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
