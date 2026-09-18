"use strict";

/**
 * Himalaya wrapper.
 *
 * Every mailbox read/write in the plugin runtime goes through here. The
 * account name comes from workspace config and maps to `[accounts.<name>]`
 * in the Himalaya TOML that BizOps manages; we never see a host, address, or
 * secret.
 *
 * Himalaya v1.2 filter language (see `himalaya envelope list --help`):
 *   before/after <yyyy-mm-dd>, from/to/subject/body <pattern>, flag <flag>,
 *   combined with and/or/not.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// realtimex-plugin-validator: allow-process-env -- Himalaya binary and TOML
// path are host-runtime discovery (which CLI, which BizOps-managed config file),
// not plugin configuration; kept injectable so tests never depend on the host.
const HIMALAYA_BIN = process.env.MAILKEEPER_HIMALAYA_BIN || "himalaya";
const BATCH = 200;

function tailArgs(account) {
  // `-a` / `-c` / `-o` are per-subcommand options in Himalaya, so they go last.
  return [
    "-a", account,
    "-o", "json",
    ...(process.env.HIMALAYA_CONFIG ? ["-c", process.env.HIMALAYA_CONFIG] : []),
  ];
}

async function himalaya(account, args, { timeoutMs = 120_000 } = {}) {
  const { stdout } = await execFileAsync(
    HIMALAYA_BIN,
    [...args, ...tailArgs(account)],
    { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout.trim() ? JSON.parse(stdout) : null;
}

/**
 * Accounts declared in the Himalaya TOML. Names only — never hosts, addresses
 * or secrets — which is exactly what the EMAIL_ACCOUNTS picker needs.
 */
async function listAccounts() {
  const { stdout } = await execFileAsync(
    HIMALAYA_BIN,
    [
      "account", "list", "-o", "json",
      ...(process.env.HIMALAYA_CONFIG ? ["-c", process.env.HIMALAYA_CONFIG] : []),
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
async function checkAccount(account) {
  try {
    const folders = await himalaya(account, ["folder", "list"], {
      timeoutMs: 30_000,
    });
    return { ok: true, folders: Array.isArray(folders) ? folders.map((f) => f.name) : [] };
  } catch (error) {
    return {
      ok: false,
      error: `Himalaya account "${account}" is not usable: ${firstLine(error)}`,
    };
  }
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error)
    .split("\n")
    .find(Boolean)
    ?.slice(0, 300);
}

/**
 * List envelopes matching a filter query in one folder, paging until done.
 * Returns the normalized envelope shape used by the snapshot cache.
 */
async function listEnvelopes(account, query, { folder = "INBOX", maxPages = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let rows;
    try {
      rows = await himalaya(account, ["envelope", "list",
        "-f", folder,
        "-p", String(page),
        "-s", String(BATCH),
        ...(query ? [query] : []),
      ]);
    } catch (error) {
      // Himalaya errors on an out-of-range page instead of returning [].
      if (/out of bound/i.test(String(error?.stderr || error?.message))) break;
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
async function move(account, uids, { from = "INBOX", to, dryRun = false } = {}) {
  if (!to) throw new Error("move requires a target folder");
  const actions = [];
  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH);
    if (!dryRun) {
      await himalaya(account, ["message", "move", "-f", from, to, ...chunk]);
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
async function undoActions(account, actions, { dryRun = false } = {}) {
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
      });
      reversed.push(...done);
    } catch (error) {
      skipped.push({ ...group, error: firstLine(error) });
    }
  }
  return { reversed: reversed.length, skipped, dryRun };
}

/**
 * Ensure an Auto/<category> folder exists. Idempotent.
 */
async function ensureFolder(account, name) {
  const existing = await himalaya(account, ["folder", "list"]);
  if (Array.isArray(existing) && existing.some((f) => f.name === name)) return false;
  await himalaya(account, ["folder", "add", name]);
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
};
