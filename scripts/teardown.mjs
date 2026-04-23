#!/usr/bin/env node
/**
 * VaultDrop — Cloudflare Teardown Script
 *
 * Run from the repo root:
 *   node scripts/teardown.mjs           — interactive teardown (deletes resources)
 *   node scripts/teardown.mjs --dry-run — preview what would be deleted, no changes made
 *
 * Deletes all Cloudflare resources provisioned by scripts/deploy.mjs:
 *   - Worker scripts (production + staging)
 *   - Cloudflare Pages project
 *   - KV namespaces (SHARE_KV, SHARE_KV_preview, SHARE_KV_staging)
 *   - R2 buckets (vaultdrop-shares, vaultdrop-shares-staging)
 *
 * Idempotent — resources that don't exist are silently skipped.
 * Non-empty R2 buckets are drained (all objects deleted) before the bucket
 * itself is removed.
 */

import readline from "readline";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEPLOY_CONFIG = path.join(REPO_ROOT, ".deploy.config.json");
const CF_WORKER_DIR = path.join(REPO_ROOT, "artifacts", "cloudflare");
const WRANGLER_TOML = path.join(CF_WORKER_DIR, "wrangler.toml");

// ---------------------------------------------------------------------------
// Parse resource names from wrangler.toml so teardown stays in sync with
// wrangler configuration even when names are customised.
// ---------------------------------------------------------------------------

/**
 * Extract resource names from wrangler.toml using the same regex approach as
 * deploy.mjs.  Falls back to conventional defaults if the file cannot be read
 * or a value cannot be found.
 *
 * @returns {{
 *   workerProd: string,
 *   workerStaging: string,
 *   kvBinding: string,
 *   r2BucketProd: string,
 *   r2BucketStaging: string,
 * }}
 */
function parseWranglerResources() {
  const defaults = {
    workerProd:      "vaultdrop-api",
    workerStaging:   "vaultdrop-api-staging",
    kvBinding:       "SHARE_KV",
    r2BucketProd:    "vaultdrop-shares",
    r2BucketStaging: "vaultdrop-shares-staging",
  };

  let toml;
  try {
    toml = fs.readFileSync(WRANGLER_TOML, "utf8");
  } catch (_) {
    return defaults;
  }

  // Top-level `name` (production Worker) — first `name =` before any section
  const topLevelSection = toml.split(/^\[/m)[0];
  const workerProdMatch = topLevelSection.match(/^name\s*=\s*"([^"]+)"/m);
  const workerProd = workerProdMatch ? workerProdMatch[1] : defaults.workerProd;

  // Staging Worker name from [env.staging] section
  const stagingMatch = toml.match(/\[env\.staging\][^\[]*?name\s*=\s*"([^"]+)"/s);
  const workerStaging = stagingMatch ? stagingMatch[1] : defaults.workerStaging;

  // KV binding name from [[kv_namespaces]] block (top-level, not staging)
  const kvMatch = toml.match(/\[\[kv_namespaces\]\][^\[]*binding\s*=\s*"([^"]+)"/s);
  const kvBinding = kvMatch ? kvMatch[1] : defaults.kvBinding;

  // Production R2 bucket name from [[r2_buckets]] (top-level)
  const r2ProdMatch = toml.match(/\[\[r2_buckets\]\][^\[]*bucket_name\s*=\s*"([^"]+)"/s);
  const r2BucketProd = r2ProdMatch ? r2ProdMatch[1] : defaults.r2BucketProd;

  // Staging R2 bucket name from [[env.staging.r2_buckets]]
  const r2StagingMatch = toml.match(/\[\[env\.staging\.r2_buckets\]\][^\[]*bucket_name\s*=\s*"([^"]+)"/s);
  const r2BucketStaging = r2StagingMatch ? r2StagingMatch[1] : defaults.r2BucketStaging;

  return { workerProd, workerStaging, kvBinding, r2BucketProd, r2BucketStaging };
}

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

function info(msg) { console.log(`  ${cyan("ℹ")} ${msg}`); }
function ok(msg)   { console.log(`  ${green("✓")} ${msg}`); }
function warn(msg) { console.log(`  ${yellow("⚠")} ${msg}`); }
function fail(msg) { console.log(`  ${red("✗")} ${msg}`); }
function skip(msg) { console.log(`  ${dim("–")} ${msg}`); }

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

function closeRL() {
  if (rl) rl.close();
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

// ---------------------------------------------------------------------------
// Deploy config
// ---------------------------------------------------------------------------
function loadDeployConfig() {
  try {
    const raw = fs.readFileSync(DEPLOY_CONFIG, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Run a command and capture its stdout + stderr.
 * Streams output to the terminal unless captureOutput is true.
 */
function runCmd(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const { cwd = REPO_ROOT, env, captureOutput = false } = opts;

    const mergedEnv = { ...process.env, ...env };
    const stdoutMode = captureOutput ? "pipe" : "inherit";
    const stderrMode = captureOutput ? "pipe" : "inherit";

    const child = spawn(cmd, args, {
      cwd,
      env: mergedEnv,
      stdio: ["ignore", stdoutMode, stderrMode],
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        stdout += d;
        if (!captureOutput) process.stdout.write(d);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d;
        if (!captureOutput) process.stderr.write(d);
      });
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
 * Run a wrangler command via pnpm exec, injecting the API credentials so
 * the script works without a prior `wrangler login`.
 */
function wrangler(args, opts = {}) {
  return runCmd("pnpm", ["exec", "wrangler", ...args], {
    cwd: CF_WORKER_DIR,
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
    const errs = json.errors || [];
    const message = errs.map((e) => `[${e.code}] ${e.message}`).join("; ") || String(res.status);
    const err = new Error(`Cloudflare API error on ${method} ${urlPath}: ${message}`);
    // Attach the raw numeric codes for structured error checking (see isNotFound)
    err.cfCodes = errs.map((e) => Number(e.code));
    err.httpStatus = res.status;
    throw err;
  }

  return json;
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------
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

  const status = verifyJson.result && verifyJson.result.status;
  if (status !== "active") {
    fail(`API token is not active (status: ${status || "unknown"}).`);
    fail("Please create or regenerate your token and try again.");
    process.exit(1);
  }

  ok("API token is valid and active");
}

// ---------------------------------------------------------------------------
// Worker deletion
// ---------------------------------------------------------------------------
async function deleteWorker(workerName) {
  try {
    await cfApi(`/accounts/${CF_ACCOUNT_ID}/workers/scripts/${workerName}`, "DELETE");
    ok(`Deleted Worker "${workerName}"`);
  } catch (e) {
    if (isNotFound(e)) {
      skip(`Worker "${workerName}" does not exist — skipping`);
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Pages project deletion
// ---------------------------------------------------------------------------
async function deletePagesProject(projectName) {
  try {
    await cfApi(`/accounts/${CF_ACCOUNT_ID}/pages/projects/${projectName}`, "DELETE");
    ok(`Deleted Pages project "${projectName}"`);
  } catch (e) {
    if (isNotFound(e)) {
      skip(`Pages project "${projectName}" does not exist — skipping`);
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// KV namespace deletion
// ---------------------------------------------------------------------------

/**
 * Fetch all KV namespaces for the account, following page-based pagination.
 * The Cloudflare KV API uses `page` + `per_page` (not cursor-based).
 */
async function listKvNamespaces() {
  const all = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const json = await cfApi(
      `/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces?per_page=${perPage}&page=${page}`,
    );
    const batch = json.result || [];
    all.push(...batch);

    const info = json.result_info || {};
    const totalCount = info.total_count ?? batch.length;
    if (all.length >= totalCount || batch.length < perPage) break;
    page++;
  }

  return all;
}

async function deleteKvNamespace(title) {
  const namespaces = await listKvNamespaces();
  const found = namespaces.find((ns) => ns.title === title);
  if (!found) {
    skip(`KV namespace "${title}" does not exist — skipping`);
    return;
  }
  await cfApi(`/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${found.id}`, "DELETE");
  ok(`Deleted KV namespace "${title}" (${dim(found.id)})`);
}

// ---------------------------------------------------------------------------
// R2 bucket management — list, drain, delete
// ---------------------------------------------------------------------------
async function listR2Buckets() {
  const json = await cfApi(`/accounts/${CF_ACCOUNT_ID}/r2/buckets?per_page=1000`);
  return (json.result && json.result.buckets) || [];
}

/**
 * List all object keys in an R2 bucket via the Cloudflare REST API,
 * following cursor-based pagination.  Returns an array of key strings.
 *
 * Endpoint: GET /accounts/{accountId}/r2/buckets/{bucket}/objects
 * Query params: cursor, max_keys
 */
async function listR2Objects(bucketName) {
  const keys = [];
  let cursor = undefined;

  while (true) {
    let urlPath = `/accounts/${CF_ACCOUNT_ID}/r2/buckets/${bucketName}/objects?max_keys=1000`;
    if (cursor) urlPath += `&cursor=${encodeURIComponent(cursor)}`;

    let json;
    try {
      json = await cfApi(urlPath);
    } catch (e) {
      // Bucket doesn't exist or listing failed — return whatever we have
      if (isNotFound(e)) return keys;
      throw e;
    }

    const result = json.result || {};
    const objects = result.objects || [];

    for (const obj of objects) {
      if (typeof obj.key === "string") keys.push(obj.key);
    }

    if (!result.truncated || !result.cursor) break;
    cursor = result.cursor;
  }

  return keys;
}

/**
 * Delete all objects from an R2 bucket using wrangler, then delete the bucket
 * via the REST API.  Idempotent: skips gracefully if bucket or objects don't
 * exist.
 */
async function deleteR2Bucket(name) {
  // Confirm bucket exists first
  const buckets = await listR2Buckets();
  if (!buckets.find((b) => b.name === name)) {
    skip(`R2 bucket "${name}" does not exist — skipping`);
    return;
  }

  // List objects and drain the bucket before deletion
  info(`Listing objects in R2 bucket "${name}"…`);
  const keys = await listR2Objects(name);

  if (keys.length > 0) {
    warn(`Bucket "${name}" contains ${keys.length} object(s) — deleting all…`);
    let deleted = 0;
    for (const key of keys) {
      try {
        await wrangler(["r2", "object", "delete", `${name}/${key}`], { captureOutput: true });
        deleted++;
      } catch (e) {
        // Object may have already been deleted by expiration or concurrent run
        if (!isNotFound(e) && !e.message.includes("NoSuchKey")) throw e;
      }
    }
    ok(`Deleted ${deleted} object(s) from bucket "${name}"`);
  } else {
    info(`Bucket "${name}" is empty`);
  }

  // Now delete the bucket itself
  await cfApi(`/accounts/${CF_ACCOUNT_ID}/r2/buckets/${name}`, "DELETE");
  ok(`Deleted R2 bucket "${name}"`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Returns true when a Cloudflare API error indicates the resource doesn't
 * exist.  Checks structured `cfCodes` first (populated by cfApi), then falls
 * back to message text for wrangler CLI errors which don't carry cfCodes.
 *
 * Known Cloudflare not-found codes:
 *   10007 — Workers / general resource not found
 *   10060 — KV namespace not found
 *   10006 — Pages project not found
 */
function isNotFound(e) {
  const NOT_FOUND_CODES = new Set([10007, 10060, 10006]);
  if (Array.isArray(e.cfCodes) && e.cfCodes.length > 0) {
    return e.cfCodes.some((code) => NOT_FOUND_CODES.has(code));
  }
  // HTTP 404 is also a reliable indicator
  if (e.httpStatus === 404) return true;
  // Fallback for wrangler CLI errors and edge cases
  return (
    e.message.includes("not found") ||
    e.message.includes("Not Found") ||
    e.message.includes("does not exist") ||
    e.message.includes("could not be found") ||
    e.message.includes("NoSuchBucket") ||
    e.message.includes("NoSuchKey")
  );
}

// ---------------------------------------------------------------------------
// Dry-run checks — read-only existence probes for each resource type
// ---------------------------------------------------------------------------

async function checkWorker(workerName) {
  try {
    await cfApi(`/accounts/${CF_ACCOUNT_ID}/workers/scripts/${workerName}`);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

async function checkPagesProject(projectName) {
  try {
    await cfApi(`/accounts/${CF_ACCOUNT_ID}/pages/projects/${projectName}`);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

let _cachedKvNamespaces = null;
async function checkKvNamespace(title) {
  if (!_cachedKvNamespaces) _cachedKvNamespaces = await listKvNamespaces();
  return _cachedKvNamespaces.some((ns) => ns.title === title);
}

let _cachedR2Buckets = null;
async function checkR2Bucket(name) {
  if (!_cachedR2Buckets) _cachedR2Buckets = await listR2Buckets();
  return _cachedR2Buckets.some((b) => b.name === name);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const DRY_RUN = process.argv.includes("--dry-run");

  if (DRY_RUN) {
    banner("VaultDrop — Teardown Dry Run");
    console.log(
      `${bold("Dry-run mode:")} resources will be ${cyan("checked but not deleted")}.\n` +
      `Re-run without ${dim("--dry-run")} to perform the actual teardown.\n`,
    );
  } else {
    banner("VaultDrop — Cloudflare Teardown");

    console.log(
      `This script ${red("permanently deletes")} all Cloudflare resources created by\n` +
      `the VaultDrop deployment script. This action ${bold("cannot be undone")}.\n`,
    );
  }

  // Read resource names from wrangler.toml so this script stays in sync even
  // when names are customised.
  const cfg = parseWranglerResources();

  createRL();

  const savedConfig = loadDeployConfig();
  if (Object.keys(savedConfig).length > 0) {
    info(`Loaded saved config from ${dim(".deploy.config.json")} — press Enter to accept each default.`);
    console.log();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collect credentials
  // ─────────────────────────────────────────────────────────────────────────
  info(
    `You need a Cloudflare API token with delete permissions.\n` +
    `    Create one at: ${cyan("https://dash.cloudflare.com/profile/api-tokens")}`,
  );
  CF_TOKEN = await askSecret("Cloudflare API token");
  if (!CF_TOKEN) { fail("API token is required. Aborting."); process.exit(1); }

  await validateCfToken();

  info(
    `Find your Account ID at: ${cyan("https://dash.cloudflare.com")} → right sidebar`,
  );
  CF_ACCOUNT_ID = await ask("Cloudflare Account ID", savedConfig.accountId);
  if (!CF_ACCOUNT_ID) { fail("Account ID is required. Aborting."); process.exit(1); }

  const pagesProjectName = await ask(
    "Cloudflare Pages project name",
    savedConfig.pagesProjectName || "vaultdrop",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Build the resource list from parsed wrangler.toml values
  // ─────────────────────────────────────────────────────────────────────────
  const kvTitles = [cfg.kvBinding, `${cfg.kvBinding}_preview`, `${cfg.kvBinding}_staging`];

  const resources = [
    { type: "Worker",        name: cfg.workerProd },
    { type: "Worker",        name: cfg.workerStaging },
    { type: "Pages project", name: pagesProjectName },
    ...kvTitles.map((name) => ({ type: "KV namespace", name })),
    { type: "R2 bucket",     name: cfg.r2BucketProd },
    { type: "R2 bucket",     name: cfg.r2BucketStaging },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // DRY-RUN: probe each resource for existence and exit without deleting
  // ─────────────────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log();
    console.log(`  ${bold("Checking live resource status…")}`);
    console.log();

    const typeWidth = Math.max(...resources.map((r) => r.type.length));
    let liveCount = 0;

    for (const r of resources) {
      const typeLabel = r.type.padEnd(typeWidth);
      let exists;
      if (r.type === "Worker")        exists = await checkWorker(r.name);
      else if (r.type === "Pages project") exists = await checkPagesProject(r.name);
      else if (r.type === "KV namespace") exists = await checkKvNamespace(r.name);
      else if (r.type === "R2 bucket")    exists = await checkR2Bucket(r.name);

      if (exists) {
        liveCount++;
        const dataWarning =
          r.type === "R2 bucket" ? red("  ⚠ ALL STORED FILES WOULD BE LOST") : "";
        const kvWarning =
          r.type === "KV namespace" ? yellow("  ⚠ all share metadata would be lost") : "";
        console.log(`    ${dim(typeLabel)}  ${bold(r.name)}  ${green("EXISTS — would be deleted")}${dataWarning}${kvWarning}`);
      } else {
        console.log(`    ${dim(typeLabel)}  ${bold(r.name)}  ${dim("not found — would be skipped")}`);
      }
    }

    console.log();
    if (liveCount > 0) {
      warn(`${liveCount} resource(s) are live and would be deleted by a real teardown.`);
      warn("R2 buckets would be drained (all objects deleted) before removal.");
    } else {
      ok("No live resources found — a real teardown would have nothing to delete.");
    }
    console.log();
    info(`Re-run without ${dim("--dry-run")} to perform the actual teardown.`);
    console.log();
    closeRL();
    process.exit(0);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Print what will be deleted
  // ─────────────────────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${bold("The following resources will be permanently deleted:")}`);
  console.log();

  const typeWidth = Math.max(...resources.map((r) => r.type.length));
  for (const r of resources) {
    const typeLabel = r.type.padEnd(typeWidth);
    const dataWarning =
      r.type === "R2 bucket" ? red("  ⚠ ALL STORED FILES WILL BE LOST") : "";
    const kvWarning =
      r.type === "KV namespace" ? yellow("  ⚠ all share metadata will be lost") : "";
    console.log(`    ${dim(typeLabel)}  ${bold(r.name)}${dataWarning}${kvWarning}`);
  }

  console.log();
  warn("R2 buckets will be drained (all objects deleted) before removal.");
  warn("This operation is " + bold("irreversible") + ". Existing share links will stop working.");
  console.log();

  // ─────────────────────────────────────────────────────────────────────────
  // Ask for confirmation
  // ─────────────────────────────────────────────────────────────────────────
  const confirm = await ask(
    `Type ${bold("yes")} to confirm deletion of all resources above`,
    "",
  );

  if (confirm.toLowerCase() !== "yes") {
    console.log();
    info("Teardown cancelled — no resources were deleted.");
    closeRL();
    process.exit(0);
  }

  closeRL();
  console.log();

  // ─────────────────────────────────────────────────────────────────────────
  // Delete resources
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${cyan("─")} ${bold("Workers")}`);
  await deleteWorker(cfg.workerProd);
  await deleteWorker(cfg.workerStaging);

  console.log(`\n${cyan("─")} ${bold("Pages project")}`);
  await deletePagesProject(pagesProjectName);

  console.log(`\n${cyan("─")} ${bold("KV namespaces")}`);
  for (const title of kvTitles) await deleteKvNamespace(title);

  console.log(`\n${cyan("─")} ${bold("R2 buckets")}`);
  await deleteR2Bucket(cfg.r2BucketProd);
  await deleteR2Bucket(cfg.r2BucketStaging);

  // ─────────────────────────────────────────────────────────────────────────
  // Done
  // ─────────────────────────────────────────────────────────────────────────
  banner("Teardown Complete");

  ok(green("All VaultDrop Cloudflare resources have been removed."));
  console.log();
  info("You may also want to:");
  console.log(`    • Delete your Cloudflare API token if it is no longer needed`);
  console.log(`    • Remove ${dim(".deploy.config.json")} from this repository`);
  console.log(`    • Reset placeholder IDs in ${dim("artifacts/cloudflare/wrangler.toml")}`);
  console.log();
}

main().catch((err) => {
  console.error(red(`\nFatal error: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  closeRL();
  process.exit(1);
});
