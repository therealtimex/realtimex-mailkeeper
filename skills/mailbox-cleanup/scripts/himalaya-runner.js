#!/usr/bin/env node
"use strict";

/**
 * himalaya-runner.js — runs one bounded Himalaya operation for one account
 * and prints exactly one JSON line: `{ok:true, op, data}` or `{ok:false, op, code}`.
 *
 * For a RealTimeX Secrets account mailbox-ops.js launches it as
 *
 *   rtxexec --env MAILKEEPER_IMAP_PASSWORD=secret://<login>#password \
 *     -- node himalaya-runner.js <op> --account <name> --config <path> ...
 *
 * and Himalaya fetches the password from himalaya-auth.js over its own auth
 * pipe. Himalaya's stdout and stderr stay inside this process: stdout is
 * parsed as JSON, stderr is only matched against fixed patterns, and neither
 * is ever printed. Only allowlisted codes leave.
 *
 *   folder-list
 *   envelope-list --folder <f> --page <n> --size <n> [--query <q>]
 *   message-move  --from <f> --to <f> --uid <uid> [--uid <uid> ...]
 *   folder-add    --name <f>
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// realtimex-plugin-validator: allow-process-env -- terminal-side runner: the Himalaya binary path and the rtxexec-injected credential are runtime transport, never plugin configuration.
const env = process.env;
const HIMALAYA = env.MAILKEEPER_HIMALAYA_BIN || "himalaya";
const MAX_UIDS = 200;
const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MUTATING = new Set(["message-move", "folder-add"]);

/** Ends main() with one result; written once, after main returns. */
class Result {
  constructor(value) {
    this.value = value;
  }
}

function emit(result) {
  throw new Result(result);
}

function parseArgs(argv) {
  const args = { _: [], config: [], uid: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined) return null;
    i += 1;
    if (Array.isArray(args[key])) args[key].push(value);
    else if (key in args) return null; // a repeated scalar is ambiguous
    else args[key] = value;
  }
  return args;
}

function cleanName(value, max = 200) {
  const text = typeof value === "string" ? value : "";
  // No control characters (newlines, NUL, escapes) and no empty or overlong names.
  return text.length > 0 && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text)
    ? text
    : null;
}

function positiveInt(value, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

function validConfigs(list) {
  if (!list.length) return null;
  for (const file of list) {
    if (!path.isAbsolute(file)) return null;
    try {
      if (!fs.statSync(file).isFile()) return null;
    } catch {
      return null;
    }
  }
  return list;
}

/** Map one operation to Himalaya argv. Per-subcommand options go last. */
function himalayaArgs(op, args) {
  switch (op) {
    case "folder-list":
      return ["folder", "list"];
    case "envelope-list": {
      const folder = cleanName(args.folder);
      const page = positiveInt(args.page, 100000);
      const size = positiveInt(args.size, 1000);
      const query = args.query === undefined ? "" : cleanName(args.query, 500);
      if (!folder || !page || !size || query === null) return null;
      return ["envelope", "list", "-f", folder, "-p", String(page), "-s", String(size), ...(query ? [query] : [])];
    }
    case "message-move": {
      const from = cleanName(args.from);
      const to = cleanName(args.to);
      const uids = args.uid;
      if (!from || !to || from === to || !uids.length || uids.length > MAX_UIDS) return null;
      if (!uids.every((uid) => /^[0-9]{1,12}$/.test(uid))) return null;
      return ["message", "move", "-f", from, to, ...uids];
    }
    case "folder-add": {
      const name = cleanName(args.name);
      return name ? ["folder", "add", name] : null;
    }
    default:
      return null;
  }
}

/**
 * Classify a failed Himalaya run from fixed patterns only. Anything not
 * reliably recognised is the generic code; a mutation that may have reached
 * the server is uncertain, never "failed".
 */
function classify(op, result) {
  if (result.error?.code === "ENOENT") return "MAILKEEPER_HIMALAYA_UNAVAILABLE";
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    return MUTATING.has(op) ? "MAILKEEPER_MUTATION_UNCERTAIN" : "MAILKEEPER_TIMEOUT";
  }
  const stderr = String(result.stderr || "");
  if (/MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH/.test(stderr)) return "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH";
  if (/MAILKEEPER_CREDENTIAL_UNAVAILABLE/.test(stderr)) return "MAILKEEPER_CREDENTIAL_UNAVAILABLE";
  if (/cannot find configuration for account/i.test(stderr)) return "MAILKEEPER_ACCOUNT_NOT_FOUND";
  if (/cannot find configuration at/i.test(stderr)) return "MAILKEEPER_HIMALAYA_CONFIG_MISSING";
  if (/cannot (parse|read) config/i.test(stderr)) return "MAILKEEPER_HIMALAYA_CONFIG_INVALID";
  if (/operation not permitted|os error 1\b/i.test(stderr)) return "MAILKEEPER_NETWORK_DENIED";
  // Himalaya's own connect timeout (macOS os error 60, Linux 110). Failing to
  // connect means nothing was sent; a timeout after connecting may not be.
  if (/timed out|os error (60|110)\b/i.test(stderr)) {
    return /cannot connect|cannot build imap client/i.test(stderr) || !MUTATING.has(op)
      ? "MAILKEEPER_TIMEOUT"
      : "MAILKEEPER_MUTATION_UNCERTAIN";
  }
  if (/cannot (connect|authenticate|login|build imap)|connection refused|authentication failed|invalid credentials/i.test(stderr)) {
    return "MAILKEEPER_IMAP_CHECK_FAILED";
  }
  return MUTATING.has(op) ? "MAILKEEPER_MUTATION_UNCERTAIN" : "MAILKEEPER_OPERATION_FAILED";
}

function main() {
  const op = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!args) emit({ ok: false, op: null, code: "MAILKEEPER_OPERATION_FAILED" });
  const account = cleanName(args.account);
  const configs = validConfigs(args.config);
  const opArgs = himalayaArgs(op, args);
  if (!account || !opArgs) emit({ ok: false, op: op || null, code: "MAILKEEPER_OPERATION_FAILED" });
  if (!configs) emit({ ok: false, op, code: "MAILKEEPER_HIMALAYA_CONFIG_MISSING" });

  const kind = env.MAILKEEPER_CREDENTIAL_KIND;
  const childEnv = { ...env, MAILKEEPER_AUTH_ACCOUNT: account };
  if (kind === "realtimex-secret") {
    // Check before Himalaya starts, so a missing injection can never fall
    // through to an interactive password prompt or another account.
    if (!env.MAILKEEPER_IMAP_PASSWORD) emit({ ok: false, op, code: "MAILKEEPER_CREDENTIAL_UNAVAILABLE" });
  } else if (kind === "himalaya-native") {
    delete childEnv.MAILKEEPER_IMAP_PASSWORD;
  } else {
    emit({ ok: false, op, code: "MAILKEEPER_CREDENTIAL_UNAVAILABLE" });
  }

  const timeoutMs = positiveInt(args["timeout-ms"] ?? 120000, 600000) || 120000;
  const result = spawnSync(
    HIMALAYA,
    [...opArgs, "-a", account, "-o", "json", "--quiet", ...configs.flatMap((file) => ["-c", file])],
    {
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: MAX_STDOUT,
      encoding: "utf8",
    }
  );
  // Bound what we inspect; we never print it.
  result.stderr = String(result.stderr || "").slice(0, MAX_STDERR);

  if (result.status !== 0 || result.error) {
    if (op === "envelope-list" && /out of bound/i.test(result.stderr)) emit({ ok: true, op, data: [] });
    emit({ ok: false, op, code: classify(op, result) });
  }
  const stdout = String(result.stdout || "").trim();
  if (!stdout) emit({ ok: true, op, data: null });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    emit({ ok: false, op, code: MUTATING.has(op) ? "MAILKEEPER_MUTATION_UNCERTAIN" : "MAILKEEPER_OPERATION_FAILED" });
  }
  emit({ ok: true, op, data });
}

if (require.main === module) {
  let result;
  try {
    main();
    result = { ok: false, op: null, code: "MAILKEEPER_OPERATION_FAILED" };
  } catch (error) {
    result = error instanceof Result ? error.value : { ok: false, op: null, code: "MAILKEEPER_OPERATION_FAILED" };
  }
  // Exit naturally: on macOS a pipe write is asynchronous, and process.exit()
  // right after it would cut a large envelope page short.
  process.exitCode = result.ok ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { himalayaArgs, classify, cleanName };
