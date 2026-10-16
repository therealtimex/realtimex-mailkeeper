"use strict";

/**
 * Himalaya discovery for the plugin runtime.
 *
 * The plugin server only reads account names from the Himalaya config; it
 * never authenticates. Mailbox reads and moves happen in the agent's terminal
 * through the mailbox-cleanup skill, where the RealTimeX Secrets credential
 * path is available.
 */

const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const { resolveHimalayaConfig, validAccountName } = require("../skills/mailbox-cleanup/scripts/mailkeeper-core");

// realtimex-plugin-validator: allow-process-env -- Himalaya binary and config file are host-runtime discovery (which CLI, which Himalaya config file), not plugin configuration; kept injectable so tests never depend on the host.
const env = process.env;
const HIMALAYA_BIN = env.MAILKEEPER_HIMALAYA_BIN || "himalaya";

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The Himalaya config file every MailKeeper surface uses for this host. */
function resolveConfig() {
  return resolveHimalayaConfig({
    himalayaConfig: env.HIMALAYA_CONFIG || "",
    home: os.homedir(),
    platform: process.platform,
    appData: env.APPDATA || "",
    exists: isFile,
  });
}

function runHimalaya(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    // stdin is closed so Himalaya can never sit in an interactive prompt.
    const child = spawn(HIMALAYA_BIN, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, stdout, stderr, status: null });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status, signal });
    });
  });
}

/**
 * Accounts declared in the Himalaya config. Names only — never hosts,
 * addresses or credentials. Reading the list runs no authentication command.
 * Failures carry a fixed code; Himalaya's own text never leaves this function.
 */
async function listAccounts(resolved = resolveConfig()) {
  if (resolved.missing) throw codedError("MAILKEEPER_HIMALAYA_CONFIG_MISSING");
  const result = await runHimalaya([
    "account", "list", "-o", "json", "--quiet",
    ...resolved.paths.flatMap((file) => ["-c", file]),
  ]);
  if (result.error?.code === "ENOENT") throw codedError("MAILKEEPER_HIMALAYA_UNAVAILABLE");
  if (result.signal) throw codedError("MAILKEEPER_TIMEOUT");
  if (result.status !== 0) {
    throw codedError(
      /cannot (parse|read) config/i.test(result.stderr)
        ? "MAILKEEPER_HIMALAYA_CONFIG_INVALID"
        : "MAILKEEPER_OPERATION_FAILED"
    );
  }
  let rows;
  try {
    rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  } catch {
    throw codedError("MAILKEEPER_OPERATION_FAILED");
  }
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: typeof row?.name === "string" ? row.name : "",
      backend: String(row?.backend || ""),
      isDefault: row?.default === true,
    }))
    .filter((row) => validAccountName(row.name));
}

module.exports = { resolveConfig, listAccounts };
