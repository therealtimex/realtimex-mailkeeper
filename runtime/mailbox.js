"use strict";

/**
 * Himalaya wrapper.
 *
 * Every mailbox read/write in the plugin runtime goes through here. The
 * account name comes from workspace config and maps to `[accounts.<name>]`
 * in the shared Himalaya TOML. The host admits each mailbox operation using
 * its authenticated caller; this adapter never resolves a credential. Only
 * the credential-free account listing reads the selected target locally.
 *
 * Himalaya v1.2 filter language (see `himalaya envelope list --help`):
 *   before/after <yyyy-mm-dd>, from/to/subject/body <pattern>, flag <flag>,
 *   combined with and/or/not.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// realtimex-plugin-validator: allow-process-env -- Himalaya binary and TOML
// path are host-runtime discovery (which CLI, which shared config file), not
// plugin configuration; kept injectable so tests never depend on the host.
const HIMALAYA_BIN = process.env.MAILKEEPER_HIMALAYA_BIN || "himalaya";
const BATCH = 200;

async function execute(account, request, { email, bindingId } = {}) {
  if (!email?.executeHimalaya) throw Object.assign(new Error("HOST_UNSUPPORTED"), { code: "HOST_UNSUPPORTED" });
  let result;
  try { result = await email.executeHimalaya({ account, ...request, ...(bindingId ? { bindingId } : {}) }); }
  catch (error) {
    if (error?.code === "HOST_UNSUPPORTED") throw error;
    // The host reports failures as results; a throw leaves a mutation's outcome unknown.
    throw Object.assign(new Error("CONNECTION_FAILED"), { code: "CONNECTION_FAILED",
      ...(["move", "add-folder"].includes(request.operation) ? { receipt: { operationId: null, outcome: "uncertain" } } : {}) });
  }
  const mutating = ["move", "add-folder"].includes(request.operation);
  // A refusal before admission carries no operation fields and started nothing.
  // Any other mutation reply without a valid receipt has an unknown outcome.
  const uncertain = { operationId: typeof result?.operationId === "string" ? result.operationId : null, outcome: "uncertain" };
  if (result?.ok !== true) {
    const safe = classifyError(result);
    const admitted = result?.operationId !== undefined || result?.outcome !== undefined;
    throw Object.assign(new Error(safe.error), safe, { receipt: !mutating ? null
      : mutationReceipt(result, ["not_started", "uncertain"]) || (admitted ? uncertain : null) });
  }
  if (mutating && !mutationReceipt(result, ["confirmed"]))
    throw Object.assign(new Error("Mailbox result is uncertain. Review the original attempt."), { code: "EMAIL_RESULT_UNCERTAIN", receipt: uncertain });
  return result;
}

function mutationReceipt(result, outcomes = ["confirmed", "not_started", "uncertain"]) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result?.operationId || "") || !outcomes.includes(result?.outcome)) return null;
  return { operationId: result.operationId, outcome: result.outcome };
}

/**
 * Accounts declared in the Himalaya TOML. Names only — never hosts, addresses
 * or secrets — which is exactly what the EMAIL_ACCOUNTS picker needs.
 */
async function listAccounts({ configPaths, configPath } = {}) {
  // Listing never authenticates, so it reads the selected target directly.
  const paths = configPaths?.length ? configPaths : configPath ? [configPath] : [];
  const { stdout } = await execFileAsync(
    HIMALAYA_BIN,
    [
      "account", "list", "-o", "json",
      ...(paths.length ? ["-c", paths.join(":")] : process.env.HIMALAYA_CONFIG ? ["-c", process.env.HIMALAYA_CONFIG] : []),
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 }
  );
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: String(row.name || ""),
      backend: String(row.backend || ""),
      isDefault: row.default === true,
    }))
    .filter((row) => row.name);
}

/**
 * Cheap readiness probe: can we list folders for this account?
 */
async function checkAccount(account, options = {}) {
  try {
    const { data: folders } = await execute(account, { operation: "folders" }, options);
    return { ok: true, folders: Array.isArray(folders) ? folders.map((f) => f.name) : [] };
  } catch (error) {
    return {
      ok: false,
      ...classifyError(error),
    };
  }
}

// Only allowlisted summaries cross the process boundary. Error chains often
// start with a generic heading; inspect the whole chain, never persist stderr.
function classifyError(error) {
  const detail = String(error?.stderr || error?.message || "")
    .replace(/\u001b\[[0-9;]*m/g, "");
  let code = "CONNECTION_FAILED";
  const messages = {
    CLI_MISSING: "Install Himalaya, then check again.",
    CLI_UNSUPPORTED: "Use a supported Himalaya version, then check again.",
    HOST_UNSUPPORTED: "Upgrade RealTimeX to use authenticated email access.",
    CONTEXT_REQUIRED: "Open setup or run from this workspace's authenticated terminal, then check again.",
    PLUGIN_DISABLED: "Enable MailKeeper for this workspace, then check again.",
    CREDENTIAL_SCOPE_DENIED: "Allow this Login for this workspace in Secrets, then check again.",
    EMAIL_PAGE_OUT_OF_RANGE: "No further page is available.",
    EMAIL_RESULT_UNCERTAIN: "Review the original mailbox attempt before retrying.",
    CONFIG_INVALID: "Repair the email configuration, then check again.",
    ACCOUNT_NOT_FOUND: "Add the selected email account, then check again.",
    CREDENTIAL_MISSING: "Save the credential privately, then check again.",
    AUTH_FAILED: "Review the private credential and provider authentication settings.",
    CONNECTION_FAILED: "Check the connection and provider settings, then retry.",
  };
  const hostCodes = {
    EMAIL_BINARY_UNAVAILABLE: "CLI_MISSING", EMAIL_VERSION_UNSUPPORTED: "CLI_UNSUPPORTED",
    HOST_UNSUPPORTED: "HOST_UNSUPPORTED", EMAIL_CONTEXT_UNAVAILABLE: "CONTEXT_REQUIRED",
    EMAIL_CONFIG_INVALID: "CONFIG_INVALID", EMAIL_CONFIG_MISSING: "CONFIG_INVALID",
    EMAIL_CONFIG_UNREADABLE: "CONFIG_INVALID", EMAIL_ACCOUNT_MISSING: "ACCOUNT_NOT_FOUND",
    EMAIL_BINDING_MISMATCH: "CREDENTIAL_MISSING", EMAIL_BINDING_CHANGED: "CREDENTIAL_MISSING",
    EMAIL_TARGET_CHANGED: "CONFIG_INVALID", SECRET_NOT_FOUND: "CREDENTIAL_MISSING",
    SECRET_DISABLED: "CREDENTIAL_MISSING", SECRET_SCOPE_DENIED: "CREDENTIAL_SCOPE_DENIED",
    SECRET_UNDECRYPTABLE: "CREDENTIAL_MISSING", SECRET_FIELD_NOT_FOUND: "CREDENTIAL_MISSING",
    SECRET_LOGIN_REQUIRED: "CREDENTIAL_MISSING", EMAIL_AUTH_FAILED: "AUTH_FAILED",
    EMAIL_CREDENTIAL_COMMAND_FAILED: "CREDENTIAL_MISSING", EMAIL_PAGE_OUT_OF_RANGE: "EMAIL_PAGE_OUT_OF_RANGE",
    EMAIL_PLUGIN_DISABLED: "PLUGIN_DISABLED", EMAIL_RESULT_UNCERTAIN: "EMAIL_RESULT_UNCERTAIN",
  };
  if (hostCodes[error?.code]) code = hostCodes[error.code];
  else if (messages[error?.code]) code = error.code; // Already classified by execute().
  else if (error?.code === "ENOENT") code = "CLI_MISSING";
  else if (/toml|parse.*config|invalid.*config/i.test(detail)) code = "CONFIG_INVALID";
  else if (/account.*(?:not found|does not exist|unknown)|unknown account/i.test(detail)) code = "ACCOUNT_NOT_FOUND";
  else if (/security:.*(?:could not be found|specified item)|(?:keychain|security|find-generic-password)[\s\S]*\b44\b/i.test(detail)) code = "CREDENTIAL_MISSING";
  else if (/authentication failed|auth(?:entication)?failed|invalid credentials|login failed/i.test(detail)) code = "AUTH_FAILED";
  return { code, error: messages[code], retryable: true };
}

/**
 * List envelopes matching a filter query in one folder, paging until done.
 * Returns the normalized envelope shape used by the snapshot cache.
 */
async function listEnvelopes(account, query, { folder = "INBOX", maxPages = 500, ...options } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let rows;
    try {
      ({ data: rows } = await execute(account, { operation: "envelopes", folder,
        page, pageSize: BATCH, ...(query ? { query } : {}) }, options));
    } catch (error) {
      // Himalaya errors on an out-of-range page instead of returning [].
      if (error.code === "EMAIL_PAGE_OUT_OF_RANGE") break;
      throw error;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) out.push(normalizeEnvelope(row, folder));
    if (rows.length < BATCH) break;
  }
  return out;
}

function normalizeEnvelope(row, folder) {
  const from = row.from || {};
  const address = String(from.addr || from.address || "").toLowerCase();
  return {
    uid: String(row.id),
    folder,
    date: row.date || null,
    fromName: from.name || "",
    fromAddress: address,
    fromDomain: address.includes("@") ? address.split("@").pop() : "",
    subject: row.subject || "",
    flags: Array.isArray(row.flags) ? row.flags : [],
  };
}

/**
 * Move a set of UIDs from one folder to another. Returns the action records
 * that go into the run receipt so /undo can reverse them.
 */
async function move(account, uids, { from = "INBOX", to, dryRun = false, ...options } = {}) {
  if (!to) throw new Error("move requires a target folder");
  const actions = [];
  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH);
    if (!dryRun) {
      try {
        await execute(account, { operation: "move", from, to, uids: chunk.map(String) }, options);
      } catch (error) {
        // Keep confirmed chunks and the failed attempt's identity so a caller
        // never reports moved mail as untouched or replays it blindly.
        throw Object.assign(error, { completed: actions,
          attempt: { from, to, uids: chunk, ...(error.receipt || { operationId: null, outcome: "not_started" }) } });
      }
    }
    for (const uid of chunk) {
      actions.push({ kind: "move", uid, from, to, dryRun });
    }
  }
  return actions;
}

/**
 * Reverse a receipt's actions. Only `move` is reversible today, and only by
 * moving back; UIDs may change across folders on some servers, in which case
 * we report the ones we could not find instead of guessing.
 */
async function undoActions(account, actions, { dryRun = false, ...options } = {}) {
  const byPair = new Map();
  for (const action of actions) {
    if (action.kind !== "move" || action.dryRun) continue;
    const key = `${action.to}→${action.from}`;
    if (!byPair.has(key)) byPair.set(key, { from: action.to, to: action.from, uids: [] });
    byPair.get(key).uids.push(action.uid);
  }
  const reversed = [];
  const skipped = [];
  for (const group of byPair.values()) {
    try {
      const done = await move(account, group.uids, {
        from: group.from,
        to: group.to,
        dryRun,
        ...options,
      });
      reversed.push(...done);
    } catch (error) {
      const completed = error.completed || [];
      reversed.push(...completed);
      const { code, error: message } = classifyError(error);
      skipped.push({ ...group, uids: group.uids.slice(completed.length), code, error: message,
        ...(error.attempt ? { attempt: error.attempt } : {}) });
    }
  }
  return { reversed: reversed.length, reversedActions: reversed, skipped, dryRun };
}

/**
 * Ensure an Auto/<category> folder exists. Idempotent.
 */
async function ensureFolder(account, name, options = {}) {
  const { data: existing } = await execute(account, { operation: "folders" }, options);
  if (Array.isArray(existing) && existing.some((f) => f.name === name)) return false;
  await execute(account, { operation: "add-folder", folder: name }, options);
  return true;
}

module.exports = {
  listAccounts,
  checkAccount,
  listEnvelopes,
  move,
  undoActions,
  ensureFolder,
  normalizeEnvelope,
  classifyError,
  mutationReceipt,
};
